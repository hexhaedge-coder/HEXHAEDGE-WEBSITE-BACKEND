"use strict";
/** Membership state changes, shared by every module. Always audited. */
const E = require("./engine");
const { db, FieldValue, audit, fail, todayKey, membershipId } = require("./util");

const SERVICE_STATES = {
  chamber: E.CHAMBER_STATES,
  build: ["applicant", "accepted", "active", "paused", "declined", "exited"],
  mindspace: ["active", "paused", "exited"],
  capital: ["invited", "active", "revoked"],
};

/**
 * Move a membership to a new state inside a transaction.
 * The Chamber uses the engine's state machine; other services use a simple list.
 */
function transition(tx, ref, current, to, { actor, reason, extra = {}, service }) {
  const from = current ? current.state : null;
  if (service === "chamber") {
    if (from && from !== to) E.assertTransition(from, to);
  } else if (!SERVICE_STATES[service].includes(to)) {
    fail("invalid-argument", `Unknown state ${to}`);
  }
  const after = { ...extra, state: to, stateSince: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
  if (current) tx.update(ref, after);
  else tx.set(ref, { ...after, createdAt: FieldValue.serverTimestamp() });
  audit({
    actor,
    action: `membership.${to}`,
    object: ref.path,
    before: from ? { state: from } : null,
    after: { state: to, ...plain(extra) },
    reason,
    subjectUid: current ? current.uid : extra.uid,
  }, tx);
}

function plain(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (v instanceof FieldValue) continue; // server timestamps are recorded by the entry itself
    out[k] = v;
  }
  return out;
}

/**
 * Pause a service (member request, consent withdrawn, or admin).
 * In the Chamber, remaining timeout days freeze (proposed edge case) and
 * clips are not required while paused.
 */
async function pauseService(uid, service, { actor, reason, byMember = false }) {
  const ref = db.collection("memberships").doc(membershipId(uid, service));
  const today = todayKey();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const m = snap.data();
    if (["paused", "exited", "disqualified", "declined", "revoked"].includes(m.state)) return;
    if (service === "chamber" && !E.canTransition(m.state, "paused")) return;
    let frozen = [];
    if (service === "chamber") {
      const ts = await tx.get(db.collection("timeouts").where("uid", "==", uid).where("status", "==", "active"));
      frozen = ts.docs;
    }
    for (const t of frozen) {
      const f = E.freezeTimeout(t.data(), today);
      tx.update(t.ref, { status: "frozen", frozenRemaining: f.frozenRemaining, updatedAt: FieldValue.serverTimestamp() });
    }
    const pauseRef = db.collection("pauses").doc();
    tx.set(pauseRef, {
      uid, service, requestedOn: today, byMember, reason: reason || null, returnedOn: null,
      lastEod: m.lastEod || null, mindspaceDone: false, createdAt: FieldValue.serverTimestamp(),
    });
    transition(tx, ref, m, "paused", { actor, reason, service, extra: { pauseId: pauseRef.id, stateBeforePause: m.state } });
  });
}

module.exports = { transition, pauseService, SERVICE_STATES };
