"use strict";
/**
 * Slots and bookings: Chamber weekly reviews (C-9, C-11, W-7, W-8) and
 * MindSpace sessions (T-1, T-3). Same mechanism, different rules.
 */
const E = require("./engine");
const U = require("./util");
const C = require("./config");
const { notify } = require("./notify");
const { issueAutomatic } = require("./chamber");

const { db, FieldValue, Timestamp, fail, optStr, int, oneOf, id, audit, callable, membershipId } = U;

const STAFF_ROLE = { chamber: "reviewer", mindspace: "practitioner" };
const CHAMBER_BOOKABLE = ["active", "timeout", "plan_rewrite"];

function weekKeyOf(date) { return E.weekMonday(E.dateKey(date, C.TZ)); }

function canStaff(roles, service) { return roles.includes("admin") || roles.includes(STAFF_ROLE[service]); }

const publishSlots = callable("publishSlots", async ({ uid, roles, data }) => {
  const service = oneOf(data.service, ["chamber", "mindspace"], "Service");
  if (!canStaff(roles, service)) fail("permission-denied", "You cannot publish slots for this service.");
  const list = Array.isArray(data.slots) ? data.slots : [];
  if (!list.length || list.length > 60) fail("invalid-argument", "Send between 1 and 60 slots.");
  const settings = await U.loadSettings();
  const batch = db.batch();
  const ids = [];
  for (const s of list) {
    const start = U.isoTime(s.start, "Slot start");
    if (+start < Date.now() + 15 * 60000) fail("invalid-argument", "Slots must be in the future.");
    const minutes = s.minutes ? int(s.minutes, { min: 10, max: 120, name: "Length" }) : (service === "chamber" ? settings.rules.reviewLengthMinutes : 50);
    const ref = db.collection("slots").doc();
    batch.set(ref, { service, staffUid: uid, start: Timestamp.fromDate(start), minutes, weekKey: weekKeyOf(start), status: "open", createdAt: FieldValue.serverTimestamp() });
    ids.push(ref.id);
  }
  await batch.commit();
  await audit({ actor: uid, action: "slots.published", object: `slots/${service}`, after: { count: ids.length } });
  return { ok: true, ids };
}, { allow: ["reviewer", "practitioner"] });

const closeSlot = callable("closeSlot", async ({ uid, roles, data }) => {
  const ref = db.collection("slots").doc(id(data.slotId, "Slot"));
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) fail("not-found", "Slot not found");
    if (s.data().staffUid !== uid && !roles.includes("admin")) fail("permission-denied", "Not your slot.");
    if (s.data().status !== "open") fail("failed-precondition", "Only an open slot can be closed. Use reschedule for a booked one.");
    tx.update(ref, { status: "closed", closedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
}, { allow: ["reviewer", "practitioner"] });

const bookSlot = callable("bookSlot", async ({ uid, data }) => {
  const slotRef = db.collection("slots").doc(id(data.slotId, "Slot"));
  const user = await db.collection("users").doc(uid).get();
  if (!user.exists) fail("failed-precondition", "Create your profile first.");
  const bRef = db.collection("bookings").doc();
  let slot;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(slotRef);
    if (!s.exists || s.data().status !== "open") fail("failed-precondition", "That slot was just taken. Please pick another.");
    slot = s.data();
    if (+slot.start.toDate() < Date.now()) fail("failed-precondition", "That slot has passed.");
    if (slot.service === "chamber") {
      const m = await tx.get(db.collection("memberships").doc(membershipId(uid, "chamber")));
      if (!m.exists || !CHAMBER_BOOKABLE.includes(m.data().state)) fail("failed-precondition", "Weekly reviews open once your plan is locked.");
      // Payment: booking is restricted when unpaid; clip duties are not (P-10).
      if (m.data().paymentStatus !== "paid") fail("failed-precondition", "Your monthly fee is unpaid, so booking is paused. Your daily clips still apply. Pay in Billing to book.");
      const same = await tx.get(db.collection("bookings").where("uid", "==", uid).where("service", "==", "chamber").where("weekKey", "==", slot.weekKey).where("status", "in", ["booked", "done"]));
      if (!same.empty) fail("already-exists", "You already have this week's review. One session a week.");
    }
    let suspended = null;
    if (slot.service === "mindspace") {
      const open = await tx.get(db.collection("bookings").where("uid", "==", uid).where("service", "==", "mindspace").where("status", "==", "booked"));
      if (open.size >= 2) fail("failed-precondition", "You already have two MindSpace sessions booked.");
      const m = await tx.get(db.collection("memberships").doc(membershipId(uid, "chamber")));
      if (m.exists && m.data().state === "suspended" && m.data().suspensionId) suspended = m.data().suspensionId;
    }
    // all reads are done; writes follow
    tx.update(slotRef, { status: "booked", bookedBy: uid, bookingId: bRef.id });
    tx.set(bRef, {
      uid, slotId: slotRef.id, service: slot.service, staffUid: slot.staffUid, start: slot.start, minutes: slot.minutes,
      weekKey: slot.weekKey, status: "booked", reminders: {}, createdAt: FieldValue.serverTimestamp(),
    });
    if (suspended) tx.update(db.collection("suspensions").doc(suspended), { mindspaceBookingId: bRef.id });
    audit({ actor: uid, action: "booking.created", object: bRef.path, subjectUid: uid, after: { service: slot.service, start: slot.start.toDate().toISOString() } }, tx);
  });
  await notify(slot.staffUid, { event: "booking_new", title: "New booking", body: `${C.SERVICES[slot.service]} on ${slot.start.toDate().toISOString()}`, link: "/staff/#calendar", urgent: false, email: false });
  return { ok: true, bookingId: bRef.id };
}, { limit: [20, 3600] });

const cancelBooking = callable("cancelBooking", async ({ uid, data }) => {
  const ref = db.collection("bookings").doc(id(data.bookingId, "Booking"));
  const settings = await U.loadSettings();
  let countsAsMiss = false;
  let b;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().uid !== uid || s.data().status !== "booked") fail("failed-precondition", "This booking cannot be cancelled.");
    b = s.data();
    countsAsMiss = b.service === "chamber" && E.cancellationCountsAsMiss(b.start.toDate(), new Date(), settings.rules);
    tx.update(ref, { status: countsAsMiss ? "missed" : "cancelled", cancelledAt: FieldValue.serverTimestamp() });
    tx.update(db.collection("slots").doc(b.slotId), { status: "open", bookedBy: null, bookingId: null });
    audit({ actor: uid, action: countsAsMiss ? "booking.late_cancel" : "booking.cancelled", object: ref.path, subjectUid: uid }, tx);
  });
  if (countsAsMiss && settings.rules.autoMissedReviewTimeout) {
    await issueAutomatic(uid, { category: "missed_review", tradingDate: U.todayKey(), evidence: { detail: `Cancelled less than ${settings.rules.cancelCutoffHours} hours before the review` } });
  }
  return { ok: true, countsAsMiss };
}, { limit: [10, 3600] });

/** W-7: review done, member did not attend, or reschedule. MindSpace notes are stored apart (T-4). */
const completeBooking = callable("completeBooking", async ({ uid: actor, roles, data }) => {
  const ref = db.collection("bookings").doc(id(data.bookingId, "Booking"));
  const outcome = oneOf(data.outcome, ["done", "no_show", "reschedule"], "Outcome");
  const note = optStr(data.note, { max: 5000 });
  const b = (await U.mustGet(ref, "Booking")).data();
  if (!canStaff(roles, b.service)) fail("permission-denied", "Not your service.");
  if (b.staffUid !== actor && !roles.includes("admin")) fail("permission-denied", "Not your booking.");
  if (b.status !== "booked") fail("failed-precondition", "This booking is already closed.");
  const settings = await U.loadSettings();

  if (outcome === "done" && b.service === "chamber" && !note) fail("invalid-argument", "Write the note: what the member did well and the pattern to watch.");
  const update = { status: outcome === "done" ? "done" : outcome === "no_show" ? "missed" : "moved", completedBy: actor, completedAt: FieldValue.serverTimestamp() };
  if (b.service === "chamber") update.note = note || null; // the member can read this (C-11)
  await ref.update(update);

  if (b.service === "mindspace" && note) {
    // T-4: practitioner notes live apart, visible only to the author and the admin.
    await db.collection("mindspaceNotes").add({ uid: b.uid, bookingId: ref.id, practitionerUid: actor, note, createdAt: FieldValue.serverTimestamp() });
  }
  if (b.service === "mindspace" && outcome === "done") {
    await db.collection("users").doc(b.uid).update({ metMindspace: true, metMindspaceAt: FieldValue.serverTimestamp() });
    await db.collection("mindspaceShared").doc(b.uid).set({ lastAttended: b.start, attendedCount: FieldValue.increment(1) }, { merge: true });
  }
  if (outcome === "reschedule") {
    await db.collection("slots").doc(b.slotId).update({ status: "closed" });
    await notify(b.uid, { event: "booking_moved", title: "Session moved", body: "Your session needs a new time. Please pick another slot. There is no penalty.", link: b.service === "chamber" ? "/app/#chamber" : "/app/#mindspace" });
  }
  if (outcome === "no_show" && b.service === "chamber" && settings.rules.autoMissedReviewTimeout) {
    await issueAutomatic(b.uid, { category: "missed_review", tradingDate: E.dateKey(b.start.toDate(), C.TZ), evidence: { detail: "Did not attend the booked weekly review" } });
  }
  if (outcome === "done" && b.service === "chamber") {
    await notify(b.uid, { event: "review_note", title: "Your weekly review note is ready", body: "Read what you did well and the pattern to watch.", link: "/app/#chamber", urgent: false });
  }
  await audit({ actor, action: `booking.${update.status}`, object: ref.path, subjectUid: b.uid, reason: b.service === "mindspace" ? null : note });
  return { ok: true };
}, { allow: ["reviewer", "practitioner"] });

/** Edge case: reviewer unavailable. Admin moves their booked slots; members are not penalised. */
const reassignStaff = callable("reassignStaff", async ({ uid: actor, data }) => {
  const from = id(data.fromUid, "From");
  const to = id(data.toUid, "To");
  const future = await db.collection("bookings").where("staffUid", "==", from).where("status", "==", "booked").get();
  const batch = db.batch();
  for (const d of future.docs) {
    batch.update(d.ref, { staffUid: to, reassignedFrom: from });
    batch.update(db.collection("slots").doc(d.data().slotId), { staffUid: to });
  }
  await batch.commit();
  await audit({ actor, action: "staff.reassigned", object: `users/${from}`, after: { to, bookings: future.size } });
  for (const d of future.docs) {
    await notify(d.data().uid, { event: "booking_reassigned", title: "Your session has a new host", body: "Same time, a different HexhaEdge person. Nothing changes for you.", link: "/app/", urgent: false });
  }
  return { ok: true, moved: future.size };
}, { allow: ["admin"] });

module.exports = { publishSlots, closeSlot, bookSlot, cancelBooking, completeBooking, reassignStaff, weekKeyOf };
