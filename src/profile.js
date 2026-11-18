"use strict";
/** Profiles, consent, applications and service entry (P-1 to P-8, B-1, B-2). */
const U = require("./util");
const C = require("./config");
const { transition, pauseService } = require("./states");
const { notify } = require("./notify");

const { db, FieldValue, fail, str, optStr, int, oneOf, id, email, audit, callable, membershipId } = U;

const SERVICE_NEEDS = {
  chamber: ["terms", "privacy", "clips"],
  build: ["terms", "privacy", "training_agreement", "risk_statement"],
  mindspace: ["terms", "privacy"],
  capital: ["terms", "privacy"],
};

const TIMEZONES = ["Africa/Nairobi", "Africa/Kampala", "Africa/Dar_es_Salaam", "Africa/Kigali", "Africa/Lagos", "Africa/Johannesburg", "Europe/London", "Asia/Dubai", "UTC"];

function cleanBackground(b = {}) {
  const instruments = Array.isArray(b.instruments) ? b.instruments.slice(0, 20).map((x) => str(x, { max: 40, name: "Instrument" })).filter(Boolean) : [];
  const accounts = Array.isArray(b.accounts) ? b.accounts.filter((a) => ["personal", "prop", "practice"].includes(a)) : [];
  return { instruments, years: int(b.years === undefined || b.years === "" ? 0 : b.years, { min: 0, max: 60, name: "Years trading" }), accounts };
}

async function writeConsent(tx, uid, purpose, given, version, actor) {
  const ref = db.collection("users").doc(uid).collection("consents").doc(purpose);
  tx.set(ref, { purpose, given, version, at: FieldValue.serverTimestamp() });
  tx.set(db.collection("users").doc(uid).collection("consentEvents").doc(), { purpose, given, version, at: FieldValue.serverTimestamp() });
  audit({ actor, action: given ? "consent.given" : "consent.withdrawn", object: ref.path, after: { purpose, given, version }, subjectUid: uid }, tx);
}

/** P-1, P-2, P-4, P-6: create the one profile, after the phone code was verified. */
const createProfile = callable("createProfile", async ({ uid, token, data }) => {
  if (!token.phone_number) fail("failed-precondition", "Verify your phone number first.");
  if (!/^\+254[17]\d{8}$/.test(token.phone_number)) fail("failed-precondition", "Please sign up with a Kenyan mobile number.");
  const name = str(data.name, { min: 2, max: 80, name: "Name" });
  const mail = email(data.email);
  const timezone = data.timezone ? oneOf(data.timezone, TIMEZONES, "Time zone") : "Africa/Nairobi";
  const contactChannel = oneOf(data.contactChannel || "sms", ["sms", "whatsapp", "email"], "Contact channel");
  const background = cleanBackground(data.background);
  const consents = data.consents || {};
  if (consents.terms !== true || consents.privacy !== true) fail("failed-precondition", "Please accept the terms and the privacy notice.");

  const settings = await U.loadSettings();
  const userRef = db.collection("users").doc(uid);
  const existing = await userRef.get();
  if (existing.exists) fail("already-exists", "You already have a profile.");

  // One profile per person: the email may not sit on another account.
  try {
    await U.admin.auth().updateUser(uid, { email: mail });
  } catch (e) {
    if (e && e.code === "auth/email-already-exists") fail("already-exists", "That email is already on another profile. Log in with it, or use a different email.");
    throw e;
  }

  await db.runTransaction(async (tx) => {
    tx.set(userRef, {
      name, email: mail, phone: token.phone_number, timezone, contactChannel, background,
      metMindspace: false, avatarUrl: null,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    for (const purpose of Object.keys(C.CONSENT_PURPOSES)) {
      if (typeof consents[purpose] === "boolean") {
        await writeConsent(tx, uid, purpose, consents[purpose], settings.consentVersions[purpose], uid);
      }
    }
    audit({ actor: uid, action: "profile.created", object: userRef.path, subjectUid: uid }, tx);
  });
  return { ok: true };
}, { limit: [5, 3600] });

/** P-7: give or withdraw one consent. Withdrawing one a service needs pauses it. */
const setConsent = callable("setConsent", async ({ uid, data }) => {
  const purpose = oneOf(data.purpose, Object.keys(C.CONSENT_PURPOSES), "Consent");
  const given = data.given === true;
  const settings = await U.loadSettings();
  await db.runTransaction(async (tx) => {
    await writeConsent(tx, uid, purpose, given, settings.consentVersions[purpose], uid);
  });
  const paused = [];
  if (!given) {
    for (const [service, needs] of Object.entries(SERVICE_NEEDS)) {
      if (!needs.includes(purpose)) continue;
      const m = await db.collection("memberships").doc(membershipId(uid, service)).get();
      if (m.exists && !["paused", "exited", "disqualified", "declined", "revoked", "applicant"].includes(m.data().state)) {
        await pauseService(uid, service, { actor: uid, reason: `Consent withdrawn: ${C.CONSENT_PURPOSES[purpose].label}`, byMember: true });
        paused.push(service);
      }
    }
    if (paused.length) {
      await notify(uid, {
        event: "service_paused",
        title: "Service paused",
        body: `You withdrew consent for "${C.CONSENT_PURPOSES[purpose].label}". ${paused.map((s) => C.SERVICES[s]).join(" and ")} needs it, so it is paused. Give the consent again in Settings to continue.`,
        link: "/app/#settings",
      });
    }
  }
  return { ok: true, paused };
}, { limit: [30, 3600] });

/**
 * Apply to a service (gating table). Capital has no sign-up; MindSpace needs
 * only a booking, so applying to it just opens the membership.
 */
const applyToService = callable("applyToService", async ({ uid, data }) => {
  const service = oneOf(data.service, ["build", "chamber", "mindspace"], "Service");
  const user = await db.collection("users").doc(uid).get();
  if (!user.exists) fail("failed-precondition", "Create your profile first.");
  const settings = await U.loadSettings();

  const consents = await db.collection("users").doc(uid).collection("consents").get();
  const given = new Set(consents.docs.filter((d) => d.data().given).map((d) => d.id));
  const needsNow = service === "chamber" ? ["terms", "privacy", "clips"] : ["terms", "privacy"];
  const missing = needsNow.filter((p) => !given.has(p));
  if (missing.length) fail("failed-precondition", `Please give consent for: ${missing.map((p) => C.CONSENT_PURPOSES[p].label).join(", ")}.`);

  const ref = db.collection("memberships").doc(membershipId(uid, service));
  const answers = {};
  if (service === "build") {
    // B-1: five intake questions, answered in writing before the first talk.
    const qs = ["experience", "goal", "time", "money", "expectations"];
    for (const q of qs) answers[q] = str((data.answers || {})[q] || "", { min: 2, max: 1500, name: "Each answer" });
    answers.preferredHour = U.hhmm(data.preferredHour || "", "Preferred hour");
  }
  if (service === "chamber") {
    answers.why = str((data.answers || {}).why || "", { min: 2, max: 1500, name: "Why you want to join" });
    answers.accountType = oneOf((data.answers || {}).accountType, ["prop", "personal", "practice"], "Account type");
  }

  const appRef = db.collection("applications").doc();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists ? snap.data() : null;
    if (cur && !["declined", "exited"].includes(cur.state)) fail("already-exists", "You already have this service open.");
    if (service === "chamber") {
      const active = await tx.get(db.collection("memberships").where("service", "==", "chamber").where("state", "in", ["onboarding", "plan_review", "active", "timeout", "paused", "suspended", "plan_rewrite"]));
      if (active.size >= settings.gates.chamberCapacity) {
        // still accept the application; admission waits for a place
        answers.waitlist = true;
      }
    }
    const state = service === "mindspace" ? "active" : "applicant";
    tx.set(appRef, { uid, service, answers, status: service === "mindspace" ? "accepted" : "pending", createdAt: FieldValue.serverTimestamp() });
    // A fresh membership record each time (a past decline or exit stays in the audit log).
    transition(tx, ref, null, state, {
      actor: uid, service, reason: cur ? `Applied again (was ${cur.state})` : "Applied",
      extra: { uid, service, paymentStatus: "none", applicationId: appRef.id, previousState: cur ? cur.state : null },
    });
  });
  return { ok: true, applicationId: appRef.id };
}, { limit: [10, 3600] });

/**
 * Admit or decline an applicant (A-1, B-1). A decline is recorded with the
 * reason; the wording the member sees is always "not the right fit at this time".
 */
const DECLINE_REASONS = ["signals_wanted", "wants_someone_to_trade", "money_cannot_afford", "needs_income_soon", "expects_quick_money", "rejects_risk_statement", "capacity", "other"];
const decideApplication = callable("decideApplication", async ({ uid: actor, data, roles }) => {
  const appId = id(data.applicationId, "Application");
  const decision = oneOf(data.decision, ["accept", "decline"], "Decision");
  const appRef = db.collection("applications").doc(appId);
  const app = (await U.mustGet(appRef, "Application")).data();
  if (app.service === "chamber" && !roles.includes("admin")) fail("permission-denied", "Only an admin admits Chamber members.");
  if (app.service === "build" && !roles.some((r) => r === "admin" || r === "trainer")) fail("permission-denied", "Only a trainer or admin decides training applications.");
  const why = decision === "decline" ? oneOf(data.reason, DECLINE_REASONS, "Reason") : null;
  const note = U.optStr(data.note, { max: 1000 });
  const ref = db.collection("memberships").doc(membershipId(app.uid, app.service));

  await db.runTransaction(async (tx) => {
    const m = await tx.get(ref);
    if (!m.exists) fail("not-found", "Membership not found");
    const cur = m.data();
    if (cur.state !== "applicant") fail("failed-precondition", "This application was already decided.");
    tx.update(appRef, { status: decision === "accept" ? "accepted" : "declined", declineReason: why, note, decidedBy: actor, decidedAt: FieldValue.serverTimestamp() });
    const to = decision === "decline" ? "declined" : app.service === "chamber" ? "onboarding" : "accepted";
    transition(tx, ref, cur, to, { actor, service: app.service, reason: decision === "decline" ? `Declined: ${why}${note ? ` (${note})` : ""}` : "Accepted" });
  });

  await notify(app.uid, decision === "accept"
    ? { event: "application_accepted", title: `${C.SERVICES[app.service]}: you are accepted`, body: app.service === "chamber" ? "Next: write your plan in the dashboard. A reviewer checks it before it locks." : "Next: read and accept the Training Agreement and Risk Statement, then pay to open your sessions.", link: "/app/#services" }
    : { event: "application_declined", title: `${C.SERVICES[app.service]}`, body: "Thank you for applying. It is not the right fit at this time.", link: "/app/#services" });
  return { ok: true };
});

/** T-2: record that a member has met MindSpace (the first door). */
const markMetMindspace = callable("markMetMindspace", async ({ uid: actor, data }) => {
  const uid = id(data.uid, "Member");
  const ref = db.collection("users").doc(uid);
  await db.runTransaction(async (tx) => {
    await U.mustGet(ref, "Member", tx);
    tx.update(ref, { metMindspace: true, metMindspaceAt: FieldValue.serverTimestamp() });
    audit({ actor, action: "mindspace.met", object: ref.path, subjectUid: uid }, tx);
  });
  return { ok: true };
}, { allow: ["practitioner"] });

/** Members download their own record (DPA right of access). */
const exportMyData = callable("exportMyData", async ({ uid }) => exportUser(uid), { limit: [3, 86400] });

async function exportUser(uid) {
  const out = {};
  const user = await db.collection("users").doc(uid).get();
  out.profile = user.exists ? user.data() : null;
  out.consents = (await db.collection("users").doc(uid).collection("consentEvents").get()).docs.map((d) => d.data());
  const cols = ["memberships", "applications", "plans", "obligations", "submissions", "violations", "timeouts", "suspensions", "pauses", "bookings", "weeklyReports", "invoices", "payments", "trainingSessions", "progressChecks", "unlockRequests", "evidenceRequests", "notifications"];
  for (const c of cols) out[c] = (await db.collection(c).where("uid", "==", uid).limit(2000).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  out.messages = (await db.collection("threads").doc(uid).collection("messages").limit(2000).get()).docs.map((d) => d.data());
  out.audit = (await db.collection("audit").where("subjectUid", "==", uid).limit(5000).get()).docs.map((d) => d.data());
  out.exportedAt = new Date().toISOString();
  return JSON.parse(JSON.stringify(out, (k, v) => (v && typeof v === "object" && typeof v.toDate === "function" ? v.toDate().toISOString() : v)));
}

/** A-7: a member asks for deletion; an admin carries it out under the retention rules. */
const requestDeletion = callable("requestDeletion", async ({ uid, data }) => {
  const note = optStr(data.note, { max: 1000 });
  const ref = db.collection("requests").doc();
  await ref.set({ uid, kind: "deletion", note, status: "open", createdAt: FieldValue.serverTimestamp() });
  await audit({ actor: uid, action: "deletion.requested", object: ref.path, subjectUid: uid, reason: note });
  return { ok: true };
}, { limit: [3, 86400] });

module.exports = { createProfile, setConsent, applyToService, decideApplication, markMetMindspace, exportMyData, requestDeletion, exportUser, SERVICE_NEEDS };
