"use strict";
/** Admin console (P-17, A-1 to A-8), roles, invitations (X-1 to X-5), outage rule (N-8). */
const E = require("./engine");
const U = require("./util");
const C = require("./config");
const { notify, sendEmail, appUrl } = require("./notify");
const { exportUser } = require("./profile");
const { transition } = require("./states");

const { db, FieldValue, fail, str, optStr, int, num, oneOf, id, email, audit, callable, membershipId } = U;

/** Set staff roles. Claims take effect on the person's next login. */
const setRoles = callable("setRoles", async ({ uid: actor, data }) => {
  const target = id(data.uid, "Person");
  const roles = (Array.isArray(data.roles) ? data.roles : []).filter((r) => C.ROLES.includes(r));
  const why = U.reason(data.reason);
  const user = await U.admin.auth().getUser(target);
  const before = U.roles(user.customClaims || {});
  if (target === actor && before.includes("admin") && !roles.includes("admin")) {
    const admins = (await db.collection("staff").where("roles", "array-contains", "admin").get()).size;
    if (admins <= 1) fail("failed-precondition", "You are the only admin. Make someone else admin first.");
  }
  const claims = { ...(user.customClaims || {}) };
  for (const r of C.ROLES) delete claims[r];
  for (const r of roles) claims[r] = true;
  await U.admin.auth().setCustomUserClaims(target, claims);
  await U.admin.auth().revokeRefreshTokens(target);
  await db.collection("staff").doc(target).set({ roles, name: user.displayName || null, email: user.email || null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await audit({ actor, action: "roles.set", object: `users/${target}`, before: { roles: before }, after: { roles }, reason: why, subjectUid: target });
  return { ok: true };
}, { allow: ["admin"] });

/* ---------- Settings with history (A-2) ---------- */

function validateSetting(key, v) {
  if (!v || typeof v !== "object") fail("invalid-argument", "Settings must be an object");
  if (key === "rules") {
    const out = {};
    const ints = { suspensionWindowDays: [5, 120], suspensionThreshold: [1, 10], clipMinSeconds: [3, 60], clipMaxSeconds: [5, 120], uploadGraceMinutes: [0, 240], missingAfterHours: [1, 72], reversalWindowHours: [1, 168], reviewLengthMinutes: [10, 90], shortReviewMinutes: [5, 60], cleanStreakForShortReview: [5, 120], cancelCutoffHours: [0, 72], bookingCutoffWeekday: [0, 6], planLockDays: [7, 120], evidenceDueHours: [1, 168], resubmitDueHours: [1, 48] };
    for (const [k, [a, b]] of Object.entries(ints)) if (v[k] !== undefined) out[k] = int(v[k], { min: a, max: b, name: k });
    if (v.balanceTolerance !== undefined) out.balanceTolerance = num(v.balanceTolerance, { min: 0, max: 1000, name: "Tolerance" });
    if (v.bookingCutoffTime !== undefined) out.bookingCutoffTime = U.hhmm(v.bookingCutoffTime);
    if (v.tierDays) out.tierDays = { minor: int(v.tierDays.minor, { min: 1, max: 30 }), serious: int(v.tierDays.serious, { min: 1, max: 30 }), critical: int(v.tierDays.critical, { min: 1, max: 30 }) };
    for (const k of ["autoNoBookingTimeout", "autoMissedReviewTimeout"]) if (v[k] !== undefined) out[k] = v[k] === true;
    if (out.clipMinSeconds && out.clipMaxSeconds && out.clipMinSeconds >= out.clipMaxSeconds) fail("invalid-argument", "Clip minimum must be below the maximum.");
    return out;
  }
  if (key === "weightTable") {
    const cats = {};
    for (const [k, row] of Object.entries(v.categories || {})) {
      if (!/^[a-z_]{2,40}$/.test(k)) fail("invalid-argument", `Bad category key ${k}`);
      cats[k] = { tier: oneOf(row.tier, E.TIERS, "Tier"), label: str(row.label, { max: 120, name: "Label" }) };
    }
    if (!Object.keys(cats).length) fail("invalid-argument", "The weight table needs categories.");
    return { categories: cats };
  }
  if (key === "gates") {
    const mf = v.mindspaceFirst || {};
    return {
      mindspaceFirst: { build: mf.build === true, chamber: mf.chamber === true, capital: mf.capital === true, mindspace: false },
      chamberNeedsPayment: v.chamberNeedsPayment !== false,
      buildNeedsPayment: v.buildNeedsPayment !== false,
      chamberCapacity: int(v.chamberCapacity === undefined ? 5 : v.chamberCapacity, { min: 1, max: 500, name: "Capacity" }),
    };
  }
  if (key === "fees") {
    return {
      chamberMonthlyKes: int(v.chamberMonthlyKes, { min: 0, max: 1000000, name: "Chamber fee" }),
      buildMonthlyUsd: num(v.buildMonthlyUsd, { min: 0, max: 10000, name: "Training fee" }),
      usdToKes: num(v.usdToKes, { min: 1, max: 1000, name: "Rate" }),
      invoiceDaysBefore: int(v.invoiceDaysBefore === undefined ? 3 : v.invoiceDaysBefore, { min: 0, max: 14 }),
      reminderDaysBefore: int(v.reminderDaysBefore === undefined ? 1 : v.reminderDaysBefore, { min: 0, max: 14 }),
      mindspaceSessionKes: int(v.mindspaceSessionKes || 0, { min: 0, max: 1000000 }),
    };
  }
  if (key === "calendar") {
    const days = (Array.isArray(v.noTradeDays) ? v.noTradeDays : []).map((d) => U.dateKeyArg(d, "No-trade day"));
    return { noTradeDays: [...new Set(days)].sort() };
  }
  if (key === "consentVersions") {
    const out = {};
    for (const k of Object.keys(C.CONSENT_PURPOSES)) if (v[k]) out[k] = str(v[k], { max: 20 });
    return out;
  }
  if (key === "retention") {
    return {
      clipsDays: int(v.clipsDays, { min: 7, max: 3650, name: "Clip retention" }),
      evidenceDays: int(v.evidenceDays, { min: 1, max: 365, name: "Evidence retention" }),
      notificationsDays: int(v.notificationsDays || 365, { min: 30, max: 3650 }),
    };
  }
  if (key === "build") {
    return { xSpaceLink: optStr(v.xSpaceLink, { max: 300 }), xSpaceTime: v.xSpaceTime ? U.hhmm(v.xSpaceTime) : "18:00" };
  }
  fail("invalid-argument", "Unknown setting");
}

const updateSettings = callable("updateSettings", async ({ uid, data }) => {
  const key = oneOf(data.key, ["rules", "weightTable", "gates", "fees", "calendar", "consentVersions", "retention", "build"], "Setting");
  const why = U.reason(data.reason);
  const value = validateSetting(key, data.value);
  const ref = db.collection("settings").doc(key);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const before = cur.exists ? cur.data() : null;
    let after = { ...(key === "rules" && before ? before : {}), ...value };
    if (key === "weightTable") {
      // New version; past rulings keep the version they were issued under (R-2).
      const version = ((before && before.version) || E.DEFAULT_WEIGHT_TABLE.version) + 1;
      after = { version, categories: value.categories };
      tx.set(db.collection("weightTableVersions").doc(String(version)), { ...after, createdBy: uid, createdAt: FieldValue.serverTimestamp() });
    }
    tx.set(ref, { ...after, updatedBy: uid, updatedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection("settingsHistory").doc(), { key, before, after, by: uid, reason: why, at: FieldValue.serverTimestamp() });
    audit({ actor: uid, action: `settings.${key}`, object: ref.path, before, after, reason: why }, tx);
  });
  await U.loadSettings(true);
  return { ok: true };
}, { allow: ["admin"] });

/* ---------- HexhaEdge Capital invitations (X-1, X-2, X-4, A-5) ---------- */

const createInvitation = callable("createInvitation", async ({ uid: actor, data }) => {
  const name = str(data.name, { min: 2, max: 80, name: "Name" });
  const mail = email(data.email);
  const why = U.reason(data.reason);
  let user;
  try {
    user = await U.admin.auth().getUserByEmail(mail);
  } catch (e) {
    user = await U.admin.auth().createUser({ email: mail, displayName: name, emailVerified: false, password: require("crypto").randomBytes(24).toString("base64url") });
  }
  const invRef = db.collection("invitations").doc();
  const mRef = db.collection("memberships").doc(membershipId(user.uid, "capital"));
  await db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (m.exists && ["invited", "active"].includes(m.data().state)) fail("already-exists", "This person is already invited.");
    tx.set(invRef, { uid: user.uid, name, email: mail, sentBy: actor, status: "sent", reason: why, createdAt: FieldValue.serverTimestamp() });
    transition(tx, mRef, null, "invited", { actor, service: "capital", reason: why, extra: { uid: user.uid, service: "capital", invitationId: invRef.id, paymentStatus: "none" } });
  });
  // Login details: a link to set a password. Wording to be reviewed by the lawyer (X-5).
  const link = await U.admin.auth().generatePasswordResetLink(mail, { url: appUrl("/auth/#login") });
  const sent = await sendEmail(mail, "Your HexhaEdge invitation",
    `Hello ${name},\n\nYou are invited to HexhaEdge Capital, HexhaEdge's own proprietary trading. This is an invitation, not an offer to invest: HexhaEdge does not trade for, manage or hold money for other people, and promises no returns.\n\nSet your password with the link below, then log in with this email.`, link).catch((e) => ({ status: "failed", detail: e.message }));
  await invRef.update({ emailStatus: sent.status });
  await notify(user.uid, { event: "invitation", title: "HexhaEdge Capital: invited", body: "You have been invited. Details are in your email.", link: "/app/#services", email: false }).catch(() => undefined);
  return { ok: true, emailed: sent.status === "sent", setupLink: sent.status === "sent" ? null : link };
}, { allow: ["admin"] });

const revokeInvitation = callable("revokeInvitation", async ({ uid: actor, data }) => {
  const ref = db.collection("invitations").doc(id(data.invitationId, "Invitation"));
  const why = U.reason(data.reason);
  await db.runTransaction(async (tx) => {
    const inv = await tx.get(ref);
    if (!inv.exists || inv.data().status !== "sent") fail("failed-precondition", "This invitation is not open.");
    const mRef = db.collection("memberships").doc(membershipId(inv.data().uid, "capital"));
    const m = await tx.get(mRef);
    tx.update(ref, { status: "revoked", revokedBy: actor, revokeReason: why, revokedAt: FieldValue.serverTimestamp() });
    if (m.exists) transition(tx, mRef, m.data(), "revoked", { actor, service: "capital", reason: why });
  });
  return { ok: true };
}, { allow: ["admin"] });

/* ---------- Member data (A-7) ---------- */

const exportMemberData = callable("exportMemberData", async ({ uid: actor, data }) => {
  const target = id(data.uid, "Member");
  const why = U.reason(data.reason);
  const out = await exportUser(target);
  out.mindspaceNotes = (await db.collection("mindspaceNotes").where("uid", "==", target).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  await audit({ actor, action: "member.exported", object: `users/${target}`, subjectUid: target, reason: why });
  return JSON.parse(JSON.stringify(out, (k, v) => (v && typeof v === "object" && typeof v.toDate === "function" ? v.toDate().toISOString() : v)));
}, { allow: ["admin"], timeoutSeconds: 120 });

/**
 * Delete on request or on exit, as the retention rules allow. Media always goes;
 * "all" also removes the profile and login. Rulings and the audit log stay
 * (anonymised by uid only) where the lawyer advises they are needed to treat other members fairly.
 */
const deleteMemberData = callable("deleteMemberData", async ({ uid: actor, data }) => {
  const target = id(data.uid, "Member");
  const scope = oneOf(data.scope, ["media", "all"], "Scope");
  const why = U.reason(data.reason);
  const bucket = U.admin.storage().bucket();
  await bucket.deleteFiles({ prefix: `clips/${target}/` }).catch(() => undefined);
  await bucket.deleteFiles({ prefix: `evidence/${target}/` }).catch(() => undefined);
  const subs = await db.collection("submissions").where("uid", "==", target).get();
  for (const d of subs.docs) await d.ref.update({ clipPath: null, clipDeleted: true, form: null });
  if (scope === "all") {
    for (const c of ["notifications", "applications", "progressChecks", "mindspaceNotes"]) {
      const q = await db.collection(c).where("uid", "==", target).get();
      for (const d of q.docs) await d.ref.delete();
    }
    const msgs = await db.collection("threads").doc(target).collection("messages").get();
    for (const d of msgs.docs) await d.ref.delete();
    await db.collection("startingNotes").doc(target).delete().catch(() => undefined);
    await db.collection("users").doc(target).set({ name: "Deleted member", email: null, phone: null, background: null, avatarUrl: null, deleted: true, deletedAt: FieldValue.serverTimestamp() });
    await U.admin.auth().deleteUser(target).catch(() => undefined);
  }
  await audit({ actor, action: `member.deleted_${scope}`, object: `users/${target}`, subjectUid: target, reason: why });
  const reqs = await db.collection("requests").where("uid", "==", target).where("status", "==", "open").get();
  for (const r of reqs.docs) await r.ref.update({ status: "done", doneBy: actor });
  return { ok: true };
}, { allow: ["admin"], timeoutSeconds: 300 });

/* ---------- Outage rule (N-8) ---------- */

const setOutageMode = callable("setOutageMode", async ({ uid, data }) => {
  const active = data.active === true;
  const why = U.reason(data.reason);
  await db.collection("system").doc("outage").set({ active, confirmed: true, confirmedBy: uid, note: why, since: active ? FieldValue.serverTimestamp() : null, endedAt: active ? null : FieldValue.serverTimestamp() }, { merge: true });
  await audit({ actor: uid, action: active ? "outage.on" : "outage.off", object: "system/outage", reason: why });
  return { ok: true };
}, { allow: ["admin"] });

const resolveCase = callable("resolveCase", async ({ uid, data }) => {
  const ref = db.collection("cases").doc(id(data.caseId, "Case"));
  const why = U.reason(data.note);
  await ref.update({ status: "closed", closedBy: uid, closeNote: why, closedAt: FieldValue.serverTimestamp() });
  await audit({ actor: uid, action: "case.closed", object: ref.path, reason: why });
  return { ok: true };
}, { allow: ["admin"] });

/** Admin decides a deletion or other member request after review. */
const closeRequest = callable("closeRequest", async ({ uid, data }) => {
  const ref = db.collection("requests").doc(id(data.requestId, "Request"));
  const why = U.reason(data.note);
  await ref.update({ status: "closed", closedBy: uid, closeNote: why });
  await audit({ actor: uid, action: "request.closed", object: ref.path, reason: why });
  return { ok: true };
}, { allow: ["admin"] });

module.exports = { setRoles, updateSettings, createInvitation, revokeInvitation, exportMemberData, deleteMemberData, setOutageMode, resolveCase, closeRequest, validateSetting };
