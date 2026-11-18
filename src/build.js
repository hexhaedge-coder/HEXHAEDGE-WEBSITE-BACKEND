"use strict";
/**
 * Build Your Edge — training and mentorship (B-1 to B-12).
 * The platform handles intake, scheduling, billing and records. The teaching stays human.
 * No scores, points or marks anywhere (B-7).
 */
const E = require("./engine");
const U = require("./util");
const C = require("./config");
const { notify } = require("./notify");

const { db, FieldValue, Timestamp, fail, str, optStr, oneOf, id, audit, callable, membershipId } = U;

/** Trainer profile: working hours and their standing Google Meet room. */
const saveTrainerProfile = callable("saveTrainerProfile", async ({ uid, roles, data }) => {
  const target = data.uid && roles.includes("admin") ? id(data.uid, "Trainer") : uid;
  const hours = (Array.isArray(data.hours) ? data.hours : []).map((h) => U.hhmm(h, "Hour")).slice(0, 14);
  const meetLink = optStr(data.meetLink, { max: 200 });
  if (meetLink && !/^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(meetLink)) fail("invalid-argument", "Use a Google Meet link, like https://meet.google.com/abc-defg-hij");
  const name = str(data.name || "", { min: 2, max: 80, name: "Name" });
  await db.collection("trainers").doc(target).set({ name, hours, meetLink, active: data.active !== false, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await audit({ actor: uid, action: "trainer.saved", object: `trainers/${target}`, after: { hours, active: data.active !== false } });
  return { ok: true };
}, { allow: ["trainer"] });

/** B-3: offer only trainers free at the trainee's hour; keep the same trainer where possible. */
const trainerOptions = callable("trainerOptions", async ({ uid, data }) => {
  const hour = U.hhmm(data.hour, "Hour");
  const m = await db.collection("memberships").doc(membershipId(uid, "build")).get();
  if (!m.exists || !["accepted", "active", "paused"].includes(m.data().state)) fail("failed-precondition", "Training opens once your application is accepted.");
  const trainers = (await db.collection("trainers").where("active", "==", true).get()).docs.filter((d) => (d.data().hours || []).includes(hour));
  const busy = await db.collection("memberships").where("service", "==", "build").where("state", "in", ["accepted", "active"]).where("trainingHour", "==", hour).get();
  const taken = new Set(busy.docs.filter((d) => d.id !== m.id).map((d) => d.data().trainerUid));
  const current = m.data().trainerUid;
  return {
    options: trainers.filter((t) => !taken.has(t.id) || t.id === current).map((t) => ({ trainerUid: t.id, name: t.data().name, current: t.id === current })),
  };
}, { limit: [30, 3600] });

const chooseTrainer = callable("chooseTrainer", async ({ uid, data }) => {
  const hour = U.hhmm(data.hour, "Hour");
  const trainerUid = id(data.trainerUid, "Trainer");
  const ref = db.collection("memberships").doc(membershipId(uid, "build"));
  await db.runTransaction(async (tx) => {
    const m = await tx.get(ref);
    if (!m.exists || !["accepted", "active"].includes(m.data().state)) fail("failed-precondition", "Training opens once your application is accepted.");
    const t = await tx.get(db.collection("trainers").doc(trainerUid));
    if (!t.exists || !t.data().active || !(t.data().hours || []).includes(hour)) fail("failed-precondition", "That trainer is not free at that hour.");
    const clash = await tx.get(db.collection("memberships").where("service", "==", "build").where("trainerUid", "==", trainerUid).where("trainingHour", "==", hour).where("state", "in", ["accepted", "active"]));
    if (clash.docs.some((d) => d.id !== ref.id)) fail("failed-precondition", "That hour was just taken. Please pick another.");
    tx.update(ref, { trainerUid, trainingHour: hour, updatedAt: FieldValue.serverTimestamp() });
    U.audit({ actor: uid, action: "training.hour_chosen", object: ref.path, subjectUid: uid, after: { trainerUid, hour } }, tx);
  });
  return { ok: true };
}, { limit: [10, 3600] });

function trainerOwns(session, uid, roles) {
  return roles.includes("admin") || session.trainerUid === uid;
}

/** B-6: after each session the trainer writes a short note. AI notes only with consent. */
const updateTrainingSession = callable("updateTrainingSession", async ({ uid, roles, data }) => {
  const ref = db.collection("trainingSessions").doc(id(data.sessionId, "Session"));
  const status = oneOf(data.status, ["done", "missed", "moved", "attended", "absent"], "Status");
  const s = (await U.mustGet(ref, "Session")).data();
  if (!trainerOwns(s, uid, roles)) fail("permission-denied", "Trainers see only their own trainees.");
  const update = { status, updatedAt: FieldValue.serverTimestamp(), updatedBy: uid };
  if (status === "done") {
    update.covered = str(data.covered || "", { min: 3, max: 3000, name: "What was covered" });
    update.observe = str(data.observe || "", { min: 3, max: 3000, name: "What to observe before next time" });
  }
  if (data.aiNotes) {
    for (const t of s.participants || [s.uid]) {
      const c = await db.collection("users").doc(t).collection("consents").doc("sessions_ai").get();
      if (!c.exists || c.data().given !== true) fail("failed-precondition", "AI notes can be attached only where the trainee's consent is on file.");
    }
    update.aiNotes = str(data.aiNotes, { max: 20000, name: "AI notes" });
    update.aiTool = oneOf(data.aiTool || "other", ["read_ai", "fathom", "gemini", "other"], "Tool");
  }
  if (status === "moved") {
    const start = U.isoTime(data.newStart, "New time");
    const weekStart = E.weekMonday(E.dateKey(s.start.toDate(), C.TZ));
    if (E.weekMonday(E.dateKey(start, C.TZ)) !== weekStart) fail("invalid-argument", "A moved session stays in the same week.");
    update.status = "scheduled";
    update.start = Timestamp.fromDate(start);
    update.movedFrom = s.start;
  }
  await ref.update(update);
  await audit({ actor: uid, action: `training.${status}`, object: ref.path, subjectUid: s.uid, after: { status } });
  if (status === "done") {
    for (const t of s.participants || [s.uid]) {
      await notify(t, { event: "session_note", title: "Session note ready", body: "Your trainer wrote what you covered and what to observe before next time.", link: "/app/#build", urgent: false });
    }
  }
  return { ok: true };
}, { allow: ["trainer"] });

/** B-5: the trainee asks to move a session with notice. */
const requestMove = callable("requestMove", async ({ uid, data }) => {
  const ref = db.collection("trainingSessions").doc(id(data.sessionId, "Session"));
  const s = (await U.mustGet(ref, "Session")).data();
  if (!(s.participants || [s.uid]).includes(uid)) fail("permission-denied", "Not your session.");
  const noticeHours = 24; // open item: notice period to set
  if (+s.start.toDate() - Date.now() < noticeHours * 3600000) fail("failed-precondition", `Moves need at least ${noticeHours} hours' notice. Inside that, the session stands.`);
  const note = str(data.note || "", { min: 3, max: 500, name: "Preferred times" });
  await ref.update({ moveRequested: true, moveNote: note });
  await notify(s.trainerUid, { event: "move_request", title: "Move request", body: note, link: "/staff/#training", urgent: false, email: false });
  return { ok: true };
}, { limit: [10, 3600] });

/** B-7: the starting note. Stored once, as the fixed point. */
const saveStartingNote = callable("saveStartingNote", async ({ uid, data }) => {
  const ref = db.collection("startingNotes").doc(uid);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists) fail("already-exists", "Your starting note is already saved. It stays as your fixed point.");
    tx.set(ref, {
      uid,
      know: str(data.know || "", { min: 3, max: 3000, name: "What you know" }),
      expect: str(data.expect || "", { min: 3, max: 3000, name: "What you expect" }),
      feel: str(data.feel || "", { min: 3, max: 3000, name: "How you feel" }),
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true };
}, { limit: [5, 3600] });

/** B-7: progress check across the four pillars. Comments only, never scores. */
const saveProgressCheck = callable("saveProgressCheck", async ({ uid, roles, data }) => {
  const trainee = id(data.uid, "Trainee");
  const m = (await U.mustGet(db.collection("memberships").doc(membershipId(trainee, "build")), "Membership")).data();
  if (!roles.includes("admin") && m.trainerUid !== uid) fail("permission-denied", "Trainers see only their own trainees.");
  const p = (k, label) => str(data[k] || "", { min: 3, max: 3000, name: label });
  const ref = db.collection("progressChecks").doc();
  await ref.set({
    uid: trainee, trainerUid: uid, date: U.todayKey(),
    strategy: p("strategy", "Strategy"), psychology: p("psychology", "Psychology and behaviour"),
    risk: p("risk", "Risk and reward management"), management: p("management", "Trade management"),
    createdAt: FieldValue.serverTimestamp(),
  });
  await notify(trainee, { event: "progress_check", title: "Progress check added", body: "Your trainer added comments across the four pillars.", link: "/app/#build", urgent: false });
  return { ok: true };
}, { allow: ["trainer"] });

/** B-8: combine two or three trainees at the same level. They are told beforehand; the fee does not change. */
const combineSessions = callable("combineSessions", async ({ uid, roles, data }) => {
  const ids = (Array.isArray(data.sessionIds) ? data.sessionIds : []).map((x) => id(x, "Session"));
  if (ids.length < 2 || ids.length > 3) fail("invalid-argument", "Combine two or three sessions.");
  const snaps = await Promise.all(ids.map((i) => db.collection("trainingSessions").doc(i).get()));
  const ss = snaps.map((s) => s.data());
  if (ss.some((s) => !s || !trainerOwns(s, uid, roles) || s.status !== "scheduled")) fail("failed-precondition", "Only your own scheduled sessions can be combined.");
  if (new Set(ss.map((s) => +s.start.toDate())).size !== 1) fail("failed-precondition", "Sessions must be at the same time.");
  const participants = ss.map((s) => s.uid);
  const batch = db.batch();
  batch.update(snaps[0].ref, { participants, group: true });
  for (const s of snaps.slice(1)) batch.update(s.ref, { status: "merged", mergedInto: snaps[0].id });
  await batch.commit();
  for (const t of participants) {
    await notify(t, { event: "group_session", title: "Small-group session", body: `Your next session is shared with ${participants.length - 1} other trainee${participants.length > 2 ? "s" : ""} at your level. Same time, same fee.`, link: "/app/#build", urgent: false });
  }
  return { ok: true };
}, { allow: ["trainer"] });

/** B-12: the trainer suggests Follow Your Edge as a next step. The trainee decides. */
const suggestNextStep = callable("suggestNextStep", async ({ uid, roles, data }) => {
  const trainee = id(data.uid, "Trainee");
  const ref = db.collection("memberships").doc(membershipId(trainee, "build"));
  const m = (await U.mustGet(ref, "Membership")).data();
  if (!roles.includes("admin") && m.trainerUid !== uid) fail("permission-denied", "Not your trainee.");
  await ref.update({ suggestChamber: true, suggestNote: optStr(data.note, { max: 1000 }) });
  await audit({ actor: uid, action: "training.next_step_suggested", object: ref.path, subjectUid: trainee });
  return { ok: true };
}, { allow: ["trainer"] });

module.exports = { saveTrainerProfile, trainerOptions, chooseTrainer, updateTrainingSession, requestMove, saveStartingNote, saveProgressCheck, combineSessions, suggestNextStep };
