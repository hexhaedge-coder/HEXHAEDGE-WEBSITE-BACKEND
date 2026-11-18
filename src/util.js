"use strict";
const admin = require("firebase-admin");
const E = require("./engine");
const C = require("./config");

/* ------------------------------------------------------------------ */
/* Firebase Admin: credentials come from the environment                */
/* ------------------------------------------------------------------ */

function initAdmin() {
  if (admin.apps.length) return;
  const opts = {};
  // On Render, paste the service account JSON (one line) into FIREBASE_SERVICE_ACCOUNT,
  // or its base64 form into FIREBASE_SERVICE_ACCOUNT_BASE64. Locally,
  // GOOGLE_APPLICATION_CREDENTIALS pointing at a key file also works.
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
    || (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8") : "");
  if (raw) {
    const sa = JSON.parse(raw);
    opts.credential = admin.credential.cert(sa);
    opts.projectId = sa.project_id;
  }
  if (process.env.FIREBASE_STORAGE_BUCKET) opts.storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
  admin.initializeApp(opts);
}
initAdmin();

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const FieldValue = admin.firestore.FieldValue;
const Timestamp = admin.firestore.Timestamp;

/** An error the caller may see. Code names follow the Firebase convention. */
class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.httpsError = true;
  }
}

/** One JSON line per log entry: Render keeps and searches these. Secrets are never logged. */
const logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: "info", msg, ...(meta || {}), at: new Date().toISOString() })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: "warn", msg, ...(meta || {}), at: new Date().toISOString() })),
  error: (msg, meta) => console.error(JSON.stringify({ level: "error", msg, ...(meta || {}), at: new Date().toISOString() })),
};

/* ------------------------------------------------------------------ */
/* Errors and input checks                                             */
/* ------------------------------------------------------------------ */

function fail(code, message) { throw new HttpsError(code, message); }

const str = (v, { max = 2000, min = 0, name = "value" } = {}) => {
  if (typeof v !== "string") fail("invalid-argument", `${name} must be text`);
  const t = v.trim();
  if (t.length < min) fail("invalid-argument", `${name} is required`);
  if (t.length > max) fail("invalid-argument", `${name} is too long (max ${max})`);
  return t;
};
const optStr = (v, opts) => (v === undefined || v === null || v === "" ? null : str(v, opts));
const int = (v, { min = 0, max = 1e9, name = "value" } = {}) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail("invalid-argument", `${name} must be a whole number between ${min} and ${max}`);
  return n;
};
const num = (v, { min = -1e12, max = 1e12, name = "value" } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail("invalid-argument", `${name} must be a number`);
  return Math.round(n * 100) / 100;
};
const oneOf = (v, list, name = "value") => {
  if (!list.includes(v)) fail("invalid-argument", `${name} must be one of: ${list.join(", ")}`);
  return v;
};
const id = (v, name = "id") => {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v)) fail("invalid-argument", `${name} is not valid`);
  return v;
};
const dateKeyArg = (v, name = "date") => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) fail("invalid-argument", `${name} must be YYYY-MM-DD`);
  return v;
};
const hhmm = (v, name = "time") => {
  if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) fail("invalid-argument", `${name} must be HH:MM`);
  return v;
};
const isoTime = (v, name = "time") => {
  const d = new Date(v);
  if (typeof v !== "string" || Number.isNaN(+d)) fail("invalid-argument", `${name} must be a date and time`);
  return d;
};
const reason = (v) => str(v, { min: 5, max: 2000, name: "A written reason" });

/** Kenyan mobile number in E.164 (+2547XXXXXXXX or +2541XXXXXXXX). */
function kenyanPhone(v) {
  if (typeof v !== "string") fail("invalid-argument", "Phone number is required");
  let p = v.replace(/[\s-]/g, "");
  if (/^0[17]\d{8}$/.test(p)) p = "+254" + p.slice(1);
  if (/^254[17]\d{8}$/.test(p)) p = "+" + p;
  if (!/^\+254[17]\d{8}$/.test(p)) fail("invalid-argument", "Use a Kenyan mobile number, for example 0712 345 678");
  return p;
}

function email(v) {
  const e = str(v, { max: 254, min: 3, name: "Email" }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) fail("invalid-argument", "Email address is not valid");
  return e;
}

/* ------------------------------------------------------------------ */
/* Who is calling                                                       */
/* ------------------------------------------------------------------ */

function roles(token) {
  const r = [];
  for (const role of C.ROLES) if (token && token[role] === true) r.push(role);
  return r;
}

function hasSecondFactor(token) {
  return Boolean(token && token.firebase && token.firebase.sign_in_second_factor);
}

function staffMfaRequired() {
  return C.params.REQUIRE_STAFF_MFA.value() !== false;
}

/**
 * Defines an API action. The HTTP server (server.js) verifies the Firebase ID
 * token first, then calls run() with the decoded token. run() does the checks
 * every action needs: signed in, rate-limited, and (for staff) the right role
 * plus two-step login. `allow` lists the roles that may call; admin may always
 * call staff actions.
 */
function callable(name, handler, opts = {}) {
  const { allow = "member", limit = [60, 60] } = opts;
  async function run(req) {
    if (!req.auth) fail("unauthenticated", "Please log in again.");
    const uid = req.auth.uid;
    const token = req.auth.token || {};
    const myRoles = roles(token);
    if (allow !== "member" && allow !== "any") {
      const allowed = Array.isArray(allow) ? allow : [allow];
      if (!myRoles.includes("admin") && !allowed.some((r) => myRoles.includes(r))) {
        fail("permission-denied", "You do not have access to this action.");
      }
      if (staffMfaRequired() && !hasSecondFactor(token)) {
        fail("permission-denied", "Staff actions need two-step login. Log in again with your code.");
      }
    }
    await rateLimit(uid, name, limit[0], limit[1]);
    const ctx = { uid, token, roles: myRoles, isAdmin: myRoles.includes("admin"), data: req.data || {}, rawRequest: req.rawRequest };
    try {
      return await handler(ctx);
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      logger.error(`${name} failed`, { uid, error: err && err.message, stack: err && err.stack });
      await alertAdmin("job_failure", `${name} failed: ${err && err.message}`).catch(() => undefined);
      throw new HttpsError("internal", "Something went wrong on our side. Nothing was changed. Please try again.");
    }
  }
  return { kind: "callable", name, allow, run };
}

/* ------------------------------------------------------------------ */
/* Rate limiting (N-3)                                                  */
/* ------------------------------------------------------------------ */

async function rateLimit(key, action, max, windowSeconds) {
  const ref = db.collection("ratelimits").doc(`${action}_${key}`.slice(0, 1400));
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : null;
    if (!d || now - d.start > windowSeconds * 1000) {
      tx.set(ref, { start: now, count: 1, expireAt: Timestamp.fromMillis(now + windowSeconds * 2000) });
      return;
    }
    if (d.count >= max) fail("resource-exhausted", "Too many attempts. Please wait a few minutes and try again.");
    tx.update(ref, { count: d.count + 1 });
  });
}

/* ------------------------------------------------------------------ */
/* Audit log (P-16): append only, never edited                          */
/* ------------------------------------------------------------------ */

function auditEntry({ actor, action, object, before = null, after = null, reason: why = null, subjectUid = null }) {
  return {
    actor: actor || "system",
    action,
    object: object || null,
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
    reason: why || null,
    subjectUid: subjectUid || null,
    at: FieldValue.serverTimestamp(),
  };
}

/** Write an audit entry, inside a transaction/batch when given one. */
function audit(entry, txOrBatch) {
  const ref = db.collection("audit").doc();
  const data = auditEntry(entry);
  if (txOrBatch) txOrBatch.set(ref, data);
  else return ref.set(data);
  return ref;
}

/* ------------------------------------------------------------------ */
/* Settings, kept as data (P-8, R-2, A-2)                               */
/* ------------------------------------------------------------------ */

let cache = { at: 0, value: null };

async function loadSettings(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 60000) return cache.value;
  const ids = ["rules", "weightTable", "gates", "fees", "calendar", "consentVersions", "retention"];
  const snaps = await db.getAll(...ids.map((i) => db.collection("settings").doc(i)));
  const get = (i) => (snaps[ids.indexOf(i)].exists ? snaps[ids.indexOf(i)].data() : null);
  const rules = { ...E.DEFAULT_RULES, ...(get("rules") || {}) };
  rules.tierDays = { ...E.DEFAULT_RULES.tierDays, ...((get("rules") || {}).tierDays || {}) };
  const wt = get("weightTable");
  const value = {
    rules,
    weightTable: wt && wt.categories ? wt : E.DEFAULT_WEIGHT_TABLE,
    gates: { ...C.DEFAULT_GATES, ...(get("gates") || {}) },
    fees: { ...C.DEFAULT_FEES, ...(get("fees") || {}) },
    noTradeDays: new Set(((get("calendar") || {}).noTradeDays) || []),
    consentVersions: { ...C.DEFAULT_CONSENT_VERSIONS, ...(get("consentVersions") || {}) },
    retention: { ...C.RETENTION_DEFAULTS, ...(get("retention") || {}) },
  };
  cache = { at: Date.now(), value };
  return value;
}

function calOpts(settings, plan) {
  return { synthetic: Boolean(plan && plan.synthetic), noTradeDays: settings.noTradeDays };
}

async function outageActive() {
  const s = await db.collection("system").doc("outage").get();
  return s.exists && s.data().active === true;
}

/* ------------------------------------------------------------------ */
/* Records                                                              */
/* ------------------------------------------------------------------ */

function membershipId(uid, service) { return `${uid}_${service}`; }

async function getMembership(uid, service, tx) {
  const ref = db.collection("memberships").doc(membershipId(uid, service));
  const snap = tx ? await tx.get(ref) : await ref.get();
  return { ref, snap, data: snap.exists ? snap.data() : null };
}

async function mustGet(ref, what = "Record", tx) {
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) fail("not-found", `${what} not found`);
  return snap;
}

function todayKey(tz = C.TZ) { return E.dateKey(new Date(), tz); }

function now() { return FieldValue.serverTimestamp(); }

async function alertAdmin(kind, text) {
  // N-11: failures go to the admin. Written to the health log; the hourly
  // health check sends anything unsent by SMS/email.
  await db.collection("system").doc("health").collection("events").add({
    kind, text: String(text).slice(0, 1000), at: FieldValue.serverTimestamp(), sent: false,
  });
}

module.exports = {
  admin,
  db,
  FieldValue,
  Timestamp,
  logger,
  HttpsError,
  fail,
  str,
  optStr,
  int,
  num,
  oneOf,
  id,
  dateKeyArg,
  hhmm,
  isoTime,
  reason,
  kenyanPhone,
  email,
  roles,
  hasSecondFactor,
  staffMfaRequired,
  callable,
  rateLimit,
  audit,
  auditEntry,
  loadSettings,
  calOpts,
  outageActive,
  membershipId,
  getMembership,
  mustGet,
  todayKey,
  now,
  alertAdmin,
};
