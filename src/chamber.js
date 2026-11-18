"use strict";
/**
 * Follow Your Edge — the Chamber. Plan lock, daily record, rulings,
 * timeouts, suspension, pause, evidence (Door 2, C-1 to C-16, R-1 to R-6, W-1 to W-6).
 * The system counts and issues; people judge.
 */
const E = require("./engine");
const U = require("./util");
const C = require("./config");
const { transition, pauseService } = require("./states");
const { notify } = require("./notify");

const { db, FieldValue, Timestamp, fail, str, optStr, int, num, oneOf, id, audit, callable, membershipId, calOpts } = U;

const OPEN_STATES = ["onboarding", "plan_review", "active", "timeout", "paused", "suspended", "plan_rewrite"];

// Which weight-table category a broken plan rule points to by default.
const RULE_TO_CATEGORY = {
  stop_rule: "no_stop",
  risk_per_trade: "size_above_plan",
  daily_loss_limit: "daily_loss_limit",
  trades_per_day: "trades_over_limit",
  instruments: "instrument_not_allowed",
  sessions: "session_not_allowed",
  setups: "outside_setups",
  adding_allowed: "adding_against_plan",
  partials_allowed: "partials_against_plan",
  breakeven_allowed: "breakeven_against_plan",
  losing_streak_limit: "losing_streak_limit",
  firm_daily_loss: "firm_rule",
  firm_max_loss: "firm_rule",
  firm_other_rules: "firm_rule",
  pretrade_analysis: "no_pretrade_analysis",
  clip_parts: "clip_missing_part",
};

/* ------------------------------------------------------------------ */
/* Plans (step 1, C-12, W-6)                                            */
/* ------------------------------------------------------------------ */

function cleanPlanInput(d) {
  const rules = {};
  const src = d.rules || {};
  for (const c of E.PLAN_CATEGORIES) {
    const v = src[c.key];
    if (v === undefined || v === null || v === "") continue;
    if (c.kind === "text") rules[c.key] = str(v, { max: 600, name: c.label });
    else if (c.kind === "int") rules[c.key] = int(v, { min: 0, max: 500, name: c.label });
    else if (c.kind === "bool") rules[c.key] = v === true || v === "true";
    else if (c.kind === "list") {
      const arr = Array.isArray(v) ? v : String(v).split("\n");
      rules[c.key] = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, 30).map((x) => str(x, { max: 120, name: c.label }));
    }
  }
  const firmRules = {};
  for (const c of E.FIRM_CATEGORIES) {
    const v = (d.firmRules || {})[c.key];
    if (v !== undefined && v !== null && v !== "") firmRules[c.key] = str(v, { max: 3000, name: c.label });
  }
  return {
    accountType: oneOf(d.accountType, ["prop", "personal", "practice"], "Account type"),
    accountLabel: str(d.accountLabel || "Main account", { max: 60, name: "Account name" }),
    synthetic: d.synthetic === true,
    timezone: d.timezone && typeof d.timezone === "string" ? str(d.timezone, { max: 60 }) : C.TZ,
    sodDeadline: d.sodDeadline ? U.hhmm(d.sodDeadline, "SOD deadline") : null,
    eodDeadline: d.eodDeadline ? U.hhmm(d.eodDeadline, "EOD deadline") : null,
    rules,
    firmRules,
  };
}

const savePlanDraft = callable("savePlanDraft", async ({ uid, data }) => {
  const input = cleanPlanInput(data);
  const mRef = db.collection("memberships").doc(membershipId(uid, "chamber"));
  const planId = data.planId ? id(data.planId, "Plan") : null;
  return db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (!m.exists || !["onboarding", "plan_rewrite"].includes(m.data().state)) {
      fail("failed-precondition", "You can write a plan once you are accepted, or when your plan is unlocked.");
    }
    let ref;
    if (planId) {
      ref = db.collection("plans").doc(planId);
      const p = await tx.get(ref);
      if (!p.exists || p.data().uid !== uid) fail("not-found", "Plan not found");
      if (p.data().status !== "draft") fail("failed-precondition", "Only a draft plan can be edited.");
      tx.update(ref, { ...input, updatedAt: FieldValue.serverTimestamp() });
    } else {
      const prev = await tx.get(db.collection("plans").where("uid", "==", uid).orderBy("version", "desc").limit(1));
      const version = prev.empty ? 1 : (prev.docs[0].data().version || 0) + 1;
      ref = db.collection("plans").doc();
      tx.set(ref, { ...input, uid, version, status: "draft", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
    return { planId: ref.id };
  });
}, { limit: [60, 3600] });

const submitPlan = callable("submitPlan", async ({ uid, data }) => {
  const ref = db.collection("plans").doc(id(data.planId, "Plan"));
  const mRef = db.collection("memberships").doc(membershipId(uid, "chamber"));
  await db.runTransaction(async (tx) => {
    const p = await tx.get(ref);
    const m = await tx.get(mRef);
    if (!p.exists || p.data().uid !== uid) fail("not-found", "Plan not found");
    if (p.data().status !== "draft") fail("failed-precondition", "This plan was already sent.");
    const missing = E.planMissing(p.data());
    if (missing.length) fail("failed-precondition", `Fill every required part first: ${missing.join(", ")}`);
    tx.update(ref, { status: "review", submittedAt: FieldValue.serverTimestamp() });
    transition(tx, mRef, m.data(), "plan_review", { actor: uid, service: "chamber", reason: "Plan submitted", extra: { reviewPlanId: ref.id } });
  });
  return { ok: true };
}, { limit: [20, 3600] });

/** W-6: accept (locks the plan) or return with a note on exactly what is missing. */
const decidePlan = callable("decidePlan", async ({ uid: actor, data }) => {
  const ref = db.collection("plans").doc(id(data.planId, "Plan"));
  const decision = oneOf(data.decision, ["accept", "return"], "Decision");
  const note = decision === "return" ? str(data.note, { min: 5, max: 2000, name: "Note on what to change" }) : optStr(data.note, { max: 2000 });
  const settings = await U.loadSettings();
  let memberUid;
  let activated = false;
  await db.runTransaction(async (tx) => {
    const p = await tx.get(ref);
    if (!p.exists) fail("not-found", "Plan not found");
    const plan = p.data();
    memberUid = plan.uid;
    if (plan.status !== "review") fail("failed-precondition", "This plan is not waiting for review.");
    const mRef = db.collection("memberships").doc(membershipId(plan.uid, "chamber"));
    const m = await tx.get(mRef);
    const olderLocked = await tx.get(db.collection("plans").where("uid", "==", plan.uid).where("accountLabel", "==", plan.accountLabel).where("status", "==", "locked"));
    if (decision === "return") {
      tx.update(ref, { status: "draft", returnNote: note, returnedBy: actor, returnedAt: FieldValue.serverTimestamp() });
      transition(tx, mRef, m.data(), "onboarding", { actor, service: "chamber", reason: `Plan returned: ${note}` });
      return;
    }
    const missing = E.planMissing(plan);
    if (missing.length) fail("failed-precondition", `A plan with a blank required category cannot be accepted: ${missing.join(", ")}`);
    const today = E.dateKey(new Date(), plan.timezone || C.TZ);
    for (const old of olderLocked.docs) tx.update(old.ref, { status: "replaced", replacedBy: ref.id, replacedAt: FieldValue.serverTimestamp() });
    tx.update(ref, { status: "locked", lockedOn: today, lockedBy: actor, acceptNote: note, lockedAt: FieldValue.serverTimestamp() });
    const paid = !settings.gates.chamberNeedsPayment || m.data().paymentStatus === "paid";
    if (paid) {
      transition(tx, mRef, m.data(), "active", { actor, service: "chamber", reason: "Plan accepted and locked; fee paid", extra: { planId: ref.id, awaitingPayment: false } });
      activated = true;
    } else {
      tx.update(mRef, { planId: ref.id, awaitingPayment: true, updatedAt: FieldValue.serverTimestamp() });
    }
    audit({ actor, action: "plan.locked", object: ref.path, subjectUid: plan.uid, after: { lockedOn: today, version: plan.version } }, tx);
  });
  await notify(memberUid, decision === "return"
    ? { event: "plan_returned", title: "Your plan needs a change", body: note, link: "/app/#chamber" }
    : { event: "plan_locked", title: "Your plan is locked", body: activated ? "Your daily record starts on the next trading day: an SOD clip and an EOD clip with the form." : "Your plan is locked. Pay the monthly fee to start the daily record.", link: activated ? "/app/#chamber" : "/app/#billing" });
  return { ok: true, activated };
}, { allow: ["reviewer"] });

/** Called when a payment lands: a locked plan plus a paid fee makes the member Active. */
async function activateIfReady(uid, actor = "system") {
  const mRef = db.collection("memberships").doc(membershipId(uid, "chamber"));
  let did = false;
  await db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (!m.exists) return;
    const d = m.data();
    if (d.state === "plan_review" && d.awaitingPayment && d.planId && d.paymentStatus === "paid") {
      transition(tx, mRef, d, "active", { actor, service: "chamber", reason: "Fee paid; plan already locked", extra: { awaitingPayment: false } });
      did = true;
    }
  });
  if (did) await notify(uid, { event: "chamber_active", title: "The Chamber is open for you", body: "Your daily record starts on the next trading day.", link: "/app/#chamber" });
  return did;
}

const requestUnlock = callable("requestUnlock", async ({ uid, data }) => {
  const planId = id(data.planId, "Plan");
  const why = oneOf(data.reason, ["monthly_checkpoint", "new_account", "firm_rule_change", "blown_account", "clean_month", "other"], "Reason");
  const text = str(data.text || "", { min: 5, max: 1500, name: "Reason" });
  const p = await U.mustGet(db.collection("plans").doc(planId), "Plan");
  if (p.data().uid !== uid || p.data().status !== "locked") fail("failed-precondition", "Only your locked plan can be unlocked.");
  const open = await db.collection("unlockRequests").where("uid", "==", uid).where("status", "==", "open").limit(1).get();
  if (!open.empty) fail("already-exists", "You already have an unlock request waiting.");
  const ref = db.collection("unlockRequests").doc();
  await ref.set({ uid, planId, reason: why, text, status: "open", createdAt: FieldValue.serverTimestamp() });
  await audit({ actor: uid, action: "plan.unlock_requested", object: ref.path, subjectUid: uid, reason: `${why}: ${text}` });
  return { ok: true };
}, { limit: [10, 86400] });

const decideUnlock = callable("decideUnlock", async ({ uid: actor, data }) => {
  const ref = db.collection("unlockRequests").doc(id(data.requestId, "Request"));
  const approve = data.approve === true;
  const note = str(data.note || "", { min: 2, max: 1500, name: "Note" });
  let memberUid;
  await db.runTransaction(async (tx) => {
    const r = await tx.get(ref);
    if (!r.exists || r.data().status !== "open") fail("failed-precondition", "This request is not open.");
    memberUid = r.data().uid;
    const mRef = db.collection("memberships").doc(membershipId(memberUid, "chamber"));
    const m = await tx.get(mRef);
    tx.update(ref, { status: approve ? "approved" : "declined", note, decidedBy: actor, decidedAt: FieldValue.serverTimestamp() });
    if (approve) {
      tx.update(db.collection("plans").doc(r.data().planId), { unlockReason: r.data().reason, unlockApprovedAt: FieldValue.serverTimestamp() });
      if (m.exists && E.canTransition(m.data().state, "plan_rewrite")) {
        transition(tx, mRef, m.data(), "plan_rewrite", { actor, service: "chamber", reason: `Unlock approved (${r.data().reason}): ${note}` });
      }
    }
  });
  await notify(memberUid, { event: "unlock_decided", title: approve ? "Plan unlocked" : "Unlock request declined", body: approve ? "Write the new version of your plan. Your current plan stays in force until the new one is locked." : note, link: "/app/#chamber" });
  return { ok: true };
}, { allow: ["reviewer"] });

/* ------------------------------------------------------------------ */
/* Daily record (C-1 to C-8)                                            */
/* ------------------------------------------------------------------ */

/** The member says "I'm starting an upload". The server time is the start time. */
const beginUpload = callable("beginUpload", async ({ uid, data }) => {
  const obligationId = id(data.obligationId, "Day");
  const kind = oneOf(data.kind, ["sod", "eod"], "Clip");
  const ref = db.collection("obligations").doc(obligationId);
  const o = await U.mustGet(ref, "Day");
  if (o.data().uid !== uid) fail("permission-denied", "Not your record.");
  const token = db.collection("uploads").doc();
  await token.set({ uid, obligationId, kind, startedAt: FieldValue.serverTimestamp(), used: false, expireAt: Timestamp.fromMillis(Date.now() + 6 * 3600000) });
  return { uploadId: token.id, path: `clips/${uid}/${obligationId}/${kind}-${token.id}` };
}, { limit: [40, 3600] });

function cleanTrades(list, plan) {
  if (!Array.isArray(list)) return [];
  const setups = (plan.rules && plan.rules.setups) || [];
  return list.slice(0, 50).map((t, i) => {
    const setup = str(t.setup || "", { min: 1, max: 120, name: `Setup on trade ${i + 1}` });
    if (!setups.includes(setup)) fail("invalid-argument", `Trade ${i + 1}: pick a setup from your locked plan.`);
    return {
      setup,
      instrument: str(t.instrument || "", { min: 1, max: 40, name: `Instrument on trade ${i + 1}` }),
      plannedEntry: num(t.plannedEntry, { name: "Planned entry" }),
      actualEntry: num(t.actualEntry, { name: "Actual entry" }),
      plannedStop: num(t.plannedStop, { name: "Planned stop" }),
      actualStop: num(t.actualStop, { name: "Actual stop" }),
      plannedSize: num(t.plannedSize, { min: 0, name: "Planned size" }),
      actualSize: num(t.actualSize, { min: 0, name: "Actual size" }),
      result: num(t.result, { name: "Result" }),
      analysis: str(t.analysis || "", { min: 1, max: 1500, name: `Pre-trade analysis on trade ${i + 1}` }),
    };
  });
}

/**
 * Submit an SOD or EOD. The clip is already in Storage under the path that
 * beginUpload returned; the server reads its upload time from Storage, so
 * timing cannot be typed in by hand.
 */
const submitRecord = callable("submitRecord", async ({ uid, data }) => {
  const uploadId = id(data.uploadId, "Upload");
  const upRef = db.collection("uploads").doc(uploadId);
  const up = await U.mustGet(upRef, "Upload");
  const u = up.data();
  if (u.uid !== uid || u.used) fail("failed-precondition", "This upload was already used. Start again.");
  const oRef = db.collection("obligations").doc(u.obligationId);
  const o = (await U.mustGet(oRef, "Day")).data();
  const kind = u.kind;
  const plan = (await U.mustGet(db.collection("plans").doc(o.planId), "Plan")).data();
  const settings = await U.loadSettings();

  // The clip itself: must exist at the agreed path, be a video and not be huge.
  const path = `clips/${uid}/${u.obligationId}/${kind}-${uploadId}`;
  const file = U.admin.storage().bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) fail("failed-precondition", "We could not find your clip. Please upload it again.");
  const [meta] = await file.getMetadata();
  if (!/^video\//.test(meta.contentType || "")) fail("invalid-argument", "The clip must be a video.");
  if (Number(meta.size) > 60 * 1024 * 1024) fail("invalid-argument", "The clip is too large (60 MB maximum).");
  const finishedAt = new Date(meta.timeCreated);
  const startedAt = u.startedAt.toDate();

  const balance = num(data.balance, { name: "Balance" });
  const equity = num(data.equity, { name: "Equity" });
  const clipSeconds = num(data.clipSeconds, { min: 0, max: 600, name: "Clip length" });
  let form = null;
  if (kind === "eod") {
    const noTrade = data.form && data.form.noTrade === true;
    const trades = noTrade ? [] : cleanTrades((data.form || {}).trades, plan);
    if (!noTrade && trades.length === 0) fail("invalid-argument", "Add your trades, or mark the day as a no-trade day.");
    form = { noTrade, timeoutDay: Boolean(data.form && data.form.timeoutDay), trades, note: optStr((data.form || {}).note, { max: 2000 }) };
  }

  const mRef = db.collection("memberships").doc(membershipId(uid, "chamber"));
  const outage = await U.outageActive();
  const subRef = db.collection("submissions").doc();
  let result;
  let autoViolations = [];
  await db.runTransaction(async (tx) => {
    const ob = await tx.get(oRef);
    const m = await tx.get(mRef);
    const upNow = await tx.get(upRef);
    if (upNow.data().used) fail("failed-precondition", "This upload was already used.");
    const od = ob.data();
    const already = od[kind] && od[kind].submissionId && !od[kind].resubmitRequested;
    if (already) fail("already-exists", `Your ${kind.toUpperCase()} for this day is already in.`);
    const prevEod = kind === "sod" ? (m.data().lastEod || null) : null;
    const dueAt = (kind === "sod" ? od.sodDue : od.eodDue).toDate();
    const resubmission = Boolean(od[kind] && od[kind].resubmitRequested);
    result = E.evaluateSubmission({
      kind, dueAt, startedAt, finishedAt, clipSeconds, prevEod,
      typed: { balance, equity }, memberState: m.data().state, outage: outage || resubmission,
    }, settings.rules);

    const needsDecision = result.flags.some((f) => f.needsDecision);
    tx.set(subRef, {
      uid, planId: od.planId, obligationId: oRef.id, tradingDate: od.date, kind,
      clipPath: path, clipSeconds, contentType: meta.contentType, sizeBytes: Number(meta.size),
      balance, equity, form, startedAt: Timestamp.fromDate(startedAt), uploadedAt: Timestamp.fromDate(finishedAt),
      timing: result.timing.status, lateMinutes: result.timing.lateMinutes || 0,
      match: result.match, flags: result.flags,
      reviewStatus: "pending", priority: needsDecision ? 1 : 2, resubmission,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(upRef, { used: true });
    // A resubmission asked for by a reviewer keeps the status of the first, valid upload.
    const status = resubmission ? (od[kind].status || "on_time") : result.timing.status;
    tx.update(oRef, {
      [kind]: { submissionId: subRef.id, status, at: Timestamp.fromDate(finishedAt), resubmitRequested: false },
      [`${kind}Status`]: status,
      updatedAt: FieldValue.serverTimestamp(),
    });
    if (kind === "eod") tx.update(mRef, { lastEod: { balance, equity, date: od.date, submissionId: subRef.id } });
    else tx.update(mRef, { lastSod: { balance, equity, date: od.date, submissionId: subRef.id } });

    // Mismatch: Critical, but to the reviewer first (may be a typing slip).
    for (const f of result.flags.filter((x) => x.needsDecision)) {
      const vRef = db.collection("violations").doc();
      tx.set(vRef, {
        uid, planId: od.planId, membershipId: mRef.id, tradingDate: od.date,
        category: "record_mismatch",
        tier: "critical", status: "issued", auto: false, needsIntent: true,
        tradingDuringTimeout: f.code === "trading_during_timeout",
        evidence: { submissionId: subRef.id, detail: f.detail }, weightTableVersion: settings.weightTable.version,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    audit({ actor: uid, action: `record.${kind}`, object: subRef.path, subjectUid: uid, after: { timing: result.timing.status, match: result.match ? result.match.reason : null, flags: result.flags.map((f) => f.code) } }, tx);
    autoViolations = result.auto;
  });

  // Objective rulings are issued at once (R-3); a reviewer can reverse within 24 h.
  for (const a of autoViolations) {
    await issueAutomatic(uid, { category: a.category, tradingDate: o.date, planId: o.planId, evidence: { submissionId: subRef.id, detail: a.reason } });
  }
  await notify(uid, { event: "clip_received", title: `${kind.toUpperCase()} received`, body: result.timing.status === "late" ? `Received ${result.timing.lateMinutes} minutes after the deadline.` : "Received on time.", link: "/app/#chamber", urgent: false });
  return { ok: true, submissionId: subRef.id, timing: result.timing, match: result.match, flags: result.flags };
}, { limit: [30, 3600] });

/** Members report failed uploads so the health check can see a pattern (N-8). */
const reportUploadIssue = callable("reportUploadIssue", async ({ uid, data }) => {
  await db.collection("system").doc("health").collection("events").add({
    kind: "upload_failure", uid, text: optStr(data.detail, { max: 300 }) || "upload failed", at: FieldValue.serverTimestamp(), sent: false,
  });
  return { ok: true };
}, { limit: [10, 3600] });

/* ------------------------------------------------------------------ */
/* Violations, timeouts, suspension                                     */
/* ------------------------------------------------------------------ */

/** Creates and issues an automatic (objective) ruling. Used by jobs too. */
async function issueAutomatic(uid, { category, tradingDate, planId, evidence }) {
  if (await U.outageActive()) return null; // N-8
  const settings = await U.loadSettings();
  const s = E.suggestTier(category, settings.weightTable, settings.rules);
  const vRef = db.collection("violations").doc();
  await vRef.set({
    uid, planId: planId || null, membershipId: membershipId(uid, "chamber"), tradingDate, category,
    tier: s.tier, status: "issued", auto: true, evidence: evidence || null, weightTableVersion: s.weightTableVersion,
    createdAt: FieldValue.serverTimestamp(),
  });
  return confirmAndIssue(vRef.id, { actor: "system", auto: true });
}

/**
 * Confirm a violation and issue its timeout (C-7). Then run the suspension
 * count (R-5) and tell the member: the rule, the evidence, the days, the end date.
 */
async function confirmAndIssue(violationId, { actor, tier, category, clipTimestamp, note, auto = false }) {
  const settings = await U.loadSettings();
  const vRef = db.collection("violations").doc(violationId);
  let out;
  await db.runTransaction(async (tx) => {
    const v = await tx.get(vRef);
    if (!v.exists) fail("not-found", "Violation not found");
    const vd = v.data();
    if (vd.status !== "issued") fail("failed-precondition", "This violation is already decided.");
    const mRef = db.collection("memberships").doc(vd.membershipId || membershipId(vd.uid, "chamber"));
    const m = await tx.get(mRef);
    const plan = vd.planId ? await tx.get(db.collection("plans").doc(vd.planId)) : null;
    const pd = plan && plan.exists ? plan.data() : {};
    const finalCategory = category || vd.category;
    const finalTier = tier || vd.tier;
    const days = E.tierDays(finalTier, settings.rules);
    const opts = calOpts(settings, pd);
    const today = E.dateKey(new Date(), pd.timezone || C.TZ);
    const win = E.timeoutWindow(today, days, opts);
    const tRef = db.collection("timeouts").doc();
    const state = m.exists ? m.data().state : null;
    const paused = state === "paused";
    tx.set(tRef, {
      uid: vd.uid, violationId, tier: finalTier, days, start: win.start, end: win.end,
      status: paused ? "frozen" : "active", frozenRemaining: paused ? days : 0,
      planId: vd.planId || null, createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(vRef, {
      status: "confirmed", category: finalCategory, tier: finalTier, timeoutId: tRef.id,
      confirmedBy: actor, confirmedAt: FieldValue.serverTimestamp(), auto,
      clipTimestamp: clipTimestamp || null, reviewerNote: note || null,
      weightTableVersion: settings.weightTable.version,
      reversibleUntil: auto ? Timestamp.fromMillis(Date.now() + settings.rules.reversalWindowHours * 3600000) : null,
    });
    // Only an Active member moves to Timeout; in plan rewrite or suspension the timeout is recorded and counted.
    if (state === "active") {
      transition(tx, mRef, m.data(), "timeout", { actor, service: "chamber", reason: `${finalTier} timeout: ${finalCategory}` });
    }
    audit({ actor, action: "violation.confirmed", object: vRef.path, subjectUid: vd.uid, after: { category: finalCategory, tier: finalTier, days, start: win.start, end: win.end, auto, weightTableVersion: settings.weightTable.version }, reason: note || null }, tx);
    out = { uid: vd.uid, tier: finalTier, category: finalCategory, days, ...win, evidence: vd.evidence };
  });

  const label = (settings.weightTable.categories[out.category] || {}).label || out.category;
  await notify(out.uid, {
    event: "timeout_issued",
    title: `Timeout: ${out.days} trading day${out.days > 1 ? "s" : ""}`,
    body: `Rule: ${label}. Evidence: ${(out.evidence && out.evidence.detail) || "see your record"}. No trading from ${out.start} to ${out.end}. Keep sending your SOD and EOD clips. The rule applies to the behaviour, not to you. You can add a written response in the app.`,
    link: "/app/#chamber",
  });
  await suspensionCheck(out.uid, actor);
  return out;
}

/** R-5: three Serious or Critical timeout days in 20 trading days → suspension. */
async function suspensionCheck(uid, actor = "system") {
  const settings = await U.loadSettings();
  const mRef = db.collection("memberships").doc(membershipId(uid, "chamber"));
  const m = await mRef.get();
  if (!m.exists || ["suspended", "disqualified", "exited"].includes(m.data().state)) return null;
  const since = m.data().lastSuspensionClearedOn || "0000-00-00";
  const vs = (await db.collection("violations").where("uid", "==", uid).where("status", "==", "confirmed").get()).docs
    .map((d) => d.data()).filter((v) => v.tradingDate > since);
  const today = U.todayKey();
  const r = E.suspensionCount(vs, today, { noTradeDays: settings.noTradeDays }, settings.rules);
  await audit({ actor, action: "engine.suspension_count", object: mRef.path, subjectUid: uid, after: { count: r.count, windowStart: r.windowStart, suspend: r.suspend } });
  if (!r.suspend) return r;
  await createSuspension(uid, { actor, trigger: `${r.count} Serious or Critical timeout days since ${r.windowStart}` });
  return r;
}

async function createSuspension(uid, { actor, trigger }) {
  const mRef = db.collection("memberships").doc(membershipId(uid, "chamber"));
  let number = 0;
  await db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (!m.exists || !E.canTransition(m.data().state, "suspended")) return;
    const prior = await tx.get(db.collection("suspensions").where("uid", "==", uid));
    number = prior.size + 1;
    const sRef = db.collection("suspensions").doc();
    tx.set(sRef, { uid, trigger, number, start: U.todayKey(), mindspaceBookingId: null, clearedBy: null, clearedOn: null, createdAt: FieldValue.serverTimestamp() });
    transition(tx, mRef, m.data(), "suspended", { actor, service: "chamber", reason: trigger, extra: { suspensionId: sRef.id } });
    if (number >= 3) {
      // Disqualification is never automatic (C-15): open a case for the admin.
      tx.set(db.collection("cases").doc(), { uid, kind: "third_suspension", status: "open", detail: trigger, createdAt: FieldValue.serverTimestamp() });
    }
  });
  if (!number) return;
  await notify(uid, {
    event: "suspension",
    title: "Suspension: no trading for now",
    body: `${trigger}. You are not allowed to trade until you are cleared to return. The next step is a MindSpace session; book it from your dashboard. Keep your plan; the rule applies to the behaviour, not to you.`,
    link: "/app/#mindspace",
  });
}

const markSubmission = callable("markSubmission", async ({ uid: actor, data }) => {
  const sRef = db.collection("submissions").doc(id(data.submissionId, "Submission"));
  const marks = data.marks || {};
  const note = optStr(data.note, { max: 2000 });
  const allowedKeys = Object.keys(RULE_TO_CATEGORY);
  const clean = {};
  for (const [k, v] of Object.entries(marks)) {
    if (!allowedKeys.includes(k)) continue;
    clean[k] = oneOf(v, ["kept", "broken", "unclear"], "Mark");
  }
  if (!Object.keys(clean).length) fail("invalid-argument", "Mark at least one rule.");
  const settings = await U.loadSettings();
  const created = [];
  let needsEvidence = false;
  let memberUid;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(sRef);
    if (!s.exists) fail("not-found", "Submission not found");
    const sd = s.data();
    memberUid = sd.uid;
    tx.update(sRef, { marks: clean, reviewNote: note, reviewStatus: "reviewed", reviewedBy: actor, reviewedAt: FieldValue.serverTimestamp() });
    for (const [rule, mark] of Object.entries(clean)) {
      if (mark === "unclear") needsEvidence = true;
      if (mark !== "broken") continue;
      const category = RULE_TO_CATEGORY[rule];
      const t = E.suggestTier(category, settings.weightTable, settings.rules);
      const vRef = db.collection("violations").doc();
      tx.set(vRef, {
        uid: sd.uid, planId: sd.planId, membershipId: membershipId(sd.uid, "chamber"), tradingDate: sd.tradingDate,
        planRule: rule, category, tier: t.tier, status: "issued", auto: false,
        evidence: { submissionId: sRef.id, detail: note || `Marked broken: ${rule}` }, weightTableVersion: t.weightTableVersion,
        createdAt: FieldValue.serverTimestamp(), proposedBy: actor,
      });
      created.push({ violationId: vRef.id, rule, category, tier: t.tier, days: t.days });
    }
    audit({ actor, action: "review.marked", object: sRef.path, subjectUid: sd.uid, after: clean, reason: note }, tx);
  });
  return { ok: true, violations: created, needsEvidence, memberUid };
}, { allow: ["reviewer"] });

const confirmViolation = callable("confirmViolation", async ({ uid: actor, data }) => {
  const vId = id(data.violationId, "Violation");
  const tier = data.tier ? oneOf(data.tier, E.TIERS, "Tier") : undefined;
  const settings = await U.loadSettings();
  const category = data.category ? oneOf(data.category, Object.keys(settings.weightTable.categories), "Rule") : undefined;
  const clipTimestamp = optStr(data.clipTimestamp, { max: 20 });
  const note = optStr(data.note, { max: 2000 });
  const v = await U.mustGet(db.collection("violations").doc(vId), "Violation");
  if (v.data().needsIntent) fail("failed-precondition", "A record mismatch needs an intent ruling (honest slip or falsification).");
  return confirmAndIssue(vId, { actor, tier, category, clipTimestamp, note });
}, { allow: ["reviewer"] });

const dismissViolation = callable("dismissViolation", async ({ uid: actor, data }) => {
  const ref = db.collection("violations").doc(id(data.violationId, "Violation"));
  const why = U.reason(data.reason);
  await db.runTransaction(async (tx) => {
    const v = await tx.get(ref);
    if (!v.exists || v.data().status !== "issued") fail("failed-precondition", "Only a proposed violation can be dismissed.");
    tx.update(ref, { status: "dismissed", dismissedBy: actor, dismissReason: why, dismissedAt: FieldValue.serverTimestamp() });
    audit({ actor, action: "violation.dismissed", object: ref.path, subjectUid: v.data().uid, reason: why }, tx);
  });
  return { ok: true };
}, { allow: ["reviewer"] });

/** W-5: honest slip → Critical timeout; falsification → disqualification case for the admin. */
const intentRuling = callable("intentRuling", async ({ uid: actor, data }) => {
  const vId = id(data.violationId, "Violation");
  const ruling = oneOf(data.ruling, ["honest_slip", "falsification", "typing_corrected"], "Ruling");
  const note = U.reason(data.note);
  const ref = db.collection("violations").doc(vId);
  const v = (await U.mustGet(ref, "Violation")).data();
  if (!v.needsIntent || v.status !== "issued") fail("failed-precondition", "This item does not need an intent ruling.");
  if (ruling === "typing_corrected") {
    // A typing slip proved by the clip: no timeout, and the record is noted.
    await ref.update({ status: "dismissed", intent: ruling, dismissReason: note, dismissedBy: actor, needsIntent: false });
    await audit({ actor, action: "violation.typing_slip", object: ref.path, subjectUid: v.uid, reason: note });
    return { ok: true };
  }
  if (ruling === "falsification") {
    await ref.update({ status: "escalated", intent: ruling, needsIntent: false, escalatedBy: actor });
    await db.collection("cases").add({ uid: v.uid, kind: "falsification", violationId: vId, status: "open", detail: note, createdAt: FieldValue.serverTimestamp() });
    await audit({ actor, action: "violation.falsification_case", object: ref.path, subjectUid: v.uid, reason: note });
    return { ok: true, escalated: true };
  }
  if (v.tradingDuringTimeout) {
    // Trading during a timeout goes straight to a suspension ruling (R-5).
    await ref.update({ needsIntent: false, intent: ruling });
    const out = await confirmAndIssue(vId, { actor, note, tier: "critical" });
    await createSuspension(v.uid, { actor, trigger: "Trading during a timeout (reviewer confirmed)" });
    return out;
  }
  await ref.update({ needsIntent: false, intent: ruling });
  return confirmAndIssue(vId, { actor, note, tier: "critical" });
}, { allow: ["reviewer"] });

/**
 * R-3 / A-3: reverse a ruling with a written reason. A reviewer may reverse an
 * automatic ruling within 24 h; an admin may reverse any ruling.
 */
const reverseViolation = callable("reverseViolation", async ({ uid: actor, isAdmin, data }) => {
  const ref = db.collection("violations").doc(id(data.violationId, "Violation"));
  const why = U.reason(data.reason);
  let memberUid;
  await db.runTransaction(async (tx) => {
    const v = await tx.get(ref);
    if (!v.exists || v.data().status !== "confirmed") fail("failed-precondition", "Only a confirmed ruling can be reversed.");
    const vd = v.data();
    memberUid = vd.uid;
    if (!isAdmin) {
      if (!vd.auto) fail("permission-denied", "Only an admin can reverse a reviewer's ruling.");
      if (!vd.reversibleUntil || vd.reversibleUntil.toMillis() < Date.now()) fail("failed-precondition", "The 24-hour window has passed. Ask an admin to override.");
    }
    const tRef = vd.timeoutId ? db.collection("timeouts").doc(vd.timeoutId) : null;
    const mRef = db.collection("memberships").doc(membershipId(vd.uid, "chamber"));
    const m = await tx.get(mRef);
    const others = await tx.get(db.collection("timeouts").where("uid", "==", vd.uid).where("status", "==", "active"));
    tx.update(ref, { status: "reversed", reversedBy: actor, reverseReason: why, reversedAt: FieldValue.serverTimestamp() });
    if (tRef) tx.update(tRef, { status: "reversed", updatedAt: FieldValue.serverTimestamp() });
    const stillActive = others.docs.filter((d) => d.id !== vd.timeoutId).length;
    if (m.exists && m.data().state === "timeout" && !stillActive) {
      transition(tx, mRef, m.data(), "active", { actor, service: "chamber", reason: `Ruling reversed: ${why}` });
    }
    audit({ actor, action: isAdmin ? "violation.override_reversed" : "violation.reversed", object: ref.path, subjectUid: vd.uid, reason: why }, tx);
  });
  await notify(memberUid, { event: "ruling_reversed", title: "A ruling was reversed", body: why, link: "/app/#chamber", urgent: false });
  return { ok: true };
}, { allow: ["reviewer"] });

/** C-7: the member adds a written response to a violation. */
const respondToViolation = callable("respondToViolation", async ({ uid, data }) => {
  const ref = db.collection("violations").doc(id(data.violationId, "Violation"));
  const text = str(data.text, { min: 5, max: 3000, name: "Response" });
  await db.runTransaction(async (tx) => {
    const v = await tx.get(ref);
    if (!v.exists || v.data().uid !== uid) fail("not-found", "Violation not found");
    if (v.data().response) fail("already-exists", "You already added a response.");
    tx.update(ref, { response: text, respondedAt: FieldValue.serverTimestamp() });
    audit({ actor: uid, action: "violation.response", object: ref.path, subjectUid: uid, after: { response: text } }, tx);
  });
  return { ok: true };
}, { limit: [20, 3600] });

/* ------------------------------------------------------------------ */
/* Evidence and resubmission (W-3, edge cases)                          */
/* ------------------------------------------------------------------ */

const requestEvidence = callable("requestEvidence", async ({ uid: actor, data }) => {
  const memberUid = id(data.uid, "Member");
  const settings = await U.loadSettings();
  const hours = data.dueHours ? int(data.dueHours, { min: 1, max: 168, name: "Hours" }) : settings.rules.evidenceDueHours;
  const ref = db.collection("evidenceRequests").doc();
  await ref.set({
    uid: memberUid, submissionId: data.submissionId ? id(data.submissionId) : null, violationId: data.violationId ? id(data.violationId) : null,
    note: str(data.note || "Please send your balance and trade history from your firm's or broker's dashboard.", { max: 1000 }),
    dueAt: Timestamp.fromMillis(Date.now() + hours * 3600000), status: "open", files: [], requestedBy: actor,
    createdAt: FieldValue.serverTimestamp(),
  });
  await audit({ actor, action: "evidence.requested", object: ref.path, subjectUid: memberUid });
  await notify(memberUid, { event: "evidence_requested", title: "Please send dashboard evidence", body: `Send your balance and trade history from your firm's or broker's dashboard within ${hours} hours, as screenshots or an exported file. Never send a login or password.`, link: "/app/#chamber" });
  return { ok: true, requestId: ref.id };
}, { allow: ["reviewer"] });

const submitEvidence = callable("submitEvidence", async ({ uid, data }) => {
  const ref = db.collection("evidenceRequests").doc(id(data.requestId, "Request"));
  const r = (await U.mustGet(ref, "Request")).data();
  if (r.uid !== uid || r.status !== "open") fail("failed-precondition", "This request is not open.");
  const prefix = `evidence/${uid}/${ref.id}/`;
  const [files] = await U.admin.storage().bucket().getFiles({ prefix });
  if (!files.length) fail("failed-precondition", "Upload at least one file first.");
  await ref.update({ status: "submitted", files: files.map((f) => f.name), submittedAt: FieldValue.serverTimestamp() });
  await audit({ actor: uid, action: "evidence.submitted", object: ref.path, subjectUid: uid, after: { files: files.length } });
  return { ok: true };
}, { limit: [10, 3600] });

const recordEvidenceResult = callable("recordEvidenceResult", async ({ uid: actor, data }) => {
  const ref = db.collection("evidenceRequests").doc(id(data.requestId, "Request"));
  const result = oneOf(data.result, ["consistent", "inconsistent", "not_received"], "Result");
  const keep = data.keep === true; // a ruling depends on it
  const note = U.reason(data.note);
  const r = (await U.mustGet(ref, "Request")).data();
  if (!keep) {
    for (const f of r.files || []) await U.admin.storage().bucket().file(f).delete({ ignoreNotFound: true });
  }
  await ref.update({ status: "checked", result, keep, checkNote: note, checkedBy: actor, checkedAt: FieldValue.serverTimestamp(), files: keep ? r.files : [], filesDeleted: !keep });
  await audit({ actor, action: "evidence.checked", object: ref.path, subjectUid: r.uid, after: { result, keep }, reason: note });
  return { ok: true };
}, { allow: ["reviewer"] });

const requestResubmission = callable("requestResubmission", async ({ uid: actor, data }) => {
  const sRef = db.collection("submissions").doc(id(data.submissionId, "Submission"));
  const note = U.reason(data.note);
  const settings = await U.loadSettings();
  const s = (await U.mustGet(sRef, "Submission")).data();
  const oRef = db.collection("obligations").doc(s.obligationId);
  const due = Timestamp.fromMillis(Date.now() + settings.rules.resubmitDueHours * 3600000);
  await oRef.update({ [`${s.kind}.resubmitRequested`]: true, [`${s.kind}.resubmitDue`]: due });
  await sRef.update({ reviewStatus: "resubmit_requested", reviewNote: note });
  await audit({ actor, action: "record.resubmit_requested", object: sRef.path, subjectUid: s.uid, reason: note });
  await notify(s.uid, { event: "resubmit_requested", title: `Please resend your ${s.kind.toUpperCase()} clip`, body: `${note} Send it within ${settings.rules.resubmitDueHours} hours. There is no penalty: your first upload was on time.`, link: "/app/#chamber" });
  return { ok: true };
}, { allow: ["reviewer"] });

/* ------------------------------------------------------------------ */
/* Pause, return, exit, suspension clearance, disqualification          */
/* ------------------------------------------------------------------ */

const requestPause = callable("requestPause", async ({ uid, data }) => {
  const service = oneOf(data.service || "chamber", ["chamber", "build"], "Service");
  await pauseService(uid, service, { actor: uid, reason: optStr(data.note, { max: 500 }) || "Member asked for a pause", byMember: true });
  await notify(uid, {
    event: "paused", title: "Pause started",
    body: service === "chamber"
      ? "Your pause has started. No clips are needed while you are paused. When you are ready to come back, book a MindSpace session first; your first SOD back needs to match your last EOD. Asking for a pause is always fine."
      : "Your training is paused. The paid period is not refunded or carried over.",
    link: "/app/#services", urgent: false,
  });
  return { ok: true };
}, { limit: [5, 3600] });

/** Practitioner or admin marks the MindSpace step done for a return (T-3). */
const clearToReturn = callable("clearToReturn", async ({ uid: actor, data }) => {
  const memberUid = id(data.uid, "Member");
  const note = U.reason(data.note);
  const mRef = db.collection("memberships").doc(membershipId(memberUid, "chamber"));
  const m = await U.mustGet(mRef, "Membership");
  await mRef.update({ clearedToReturn: true, clearedBy: actor, clearedAt: FieldValue.serverTimestamp() });
  if (m.data().pauseId) await db.collection("pauses").doc(m.data().pauseId).update({ mindspaceDone: true });
  await audit({ actor, action: "mindspace.cleared_to_return", object: mRef.path, subjectUid: memberUid, reason: note });
  await notify(memberUid, { event: "cleared", title: "You can come back", body: "You are cleared to return. Press Return in your dashboard when you are ready.", link: "/app/#chamber", urgent: false });
  return { ok: true };
}, { allow: ["practitioner"] });

const returnFromPause = callable("returnFromPause", async ({ uid, data }) => {
  const service = oneOf(data.service || "chamber", ["chamber", "build"], "Service");
  const mRef = db.collection("memberships").doc(membershipId(uid, service));
  const today = U.todayKey();
  const settings = await U.loadSettings();
  await db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (!m.exists || m.data().state !== "paused") fail("failed-precondition", "You are not paused.");
    const md = m.data();
    if (service === "chamber" && !md.clearedToReturn) fail("failed-precondition", "Book and attend a MindSpace session first. The practitioner will mark you ready.");
    const frozen = service === "chamber" ? await tx.get(db.collection("timeouts").where("uid", "==", uid).where("status", "==", "frozen")) : { docs: [] };
    let anyTimeout = false;
    for (const t of frozen.docs) {
      const r = E.resumeTimeout(t.data(), today, { noTradeDays: settings.noTradeDays });
      tx.update(t.ref, { status: r.status, start: r.start || t.data().start, end: r.end || t.data().end, frozenRemaining: 0 });
      if (r.status === "active") anyTimeout = true;
    }
    if (md.pauseId) tx.update(db.collection("pauses").doc(md.pauseId), { returnedOn: today });
    const to = service === "chamber" ? (anyTimeout ? "timeout" : md.stateBeforePause === "plan_rewrite" ? "plan_rewrite" : "active") : "active";
    transition(tx, mRef, md, to, { actor: uid, service, reason: "Returned from pause", extra: { clearedToReturn: false, pauseId: null } });
  });
  return { ok: true };
}, { limit: [5, 3600] });

const clearSuspension = callable("clearSuspension", async ({ uid: actor, data }) => {
  const memberUid = id(data.uid, "Member");
  const note = U.reason(data.note);
  const mRef = db.collection("memberships").doc(membershipId(memberUid, "chamber"));
  await db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (!m.exists || m.data().state !== "suspended") fail("failed-precondition", "This member is not suspended.");
    const sId = m.data().suspensionId;
    if (sId) tx.update(db.collection("suspensions").doc(sId), { clearedBy: actor, clearedOn: U.todayKey(), clearNote: note });
    transition(tx, mRef, m.data(), "active", { actor, service: "chamber", reason: `Cleared to return: ${note}`, extra: { lastSuspensionClearedOn: U.todayKey(), suspensionId: null } });
  });
  await notify(memberUid, { event: "suspension_cleared", title: "Suspension cleared", body: "You are cleared to return. Your first SOD back needs to match your last EOD.", link: "/app/#chamber" });
  return { ok: true };
}, { allow: ["admin"] });

const leaveService = callable("leaveService", async ({ uid, data }) => {
  const service = oneOf(data.service, ["chamber", "build", "mindspace"], "Service");
  const why = str(data.reason || "", { min: 3, max: 1000, name: "Reason for leaving" });
  const mRef = db.collection("memberships").doc(membershipId(uid, service));
  await db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (!m.exists || ["exited", "disqualified", "declined"].includes(m.data().state)) fail("failed-precondition", "You are not in this service.");
    if (service === "build") {
      // B-10: at least seven days' notice before the renewal date.
      tx.update(mRef, { exitRequested: true, exitReason: why, exitRequestedAt: FieldValue.serverTimestamp() });
      audit({ actor: uid, action: "membership.exit_requested", object: mRef.path, subjectUid: uid, reason: why }, tx);
      return;
    }
    transition(tx, mRef, m.data(), "exited", { actor: uid, service, reason: why, extra: { exitReason: why } });
  });
  return { ok: true };
}, { limit: [5, 3600] });

const DQ_REASONS = ["falsified_record", "abuse", "third_suspension", "trading_during_suspension"];
const disqualify = callable("disqualify", async ({ uid: actor, data }) => {
  const memberUid = id(data.uid, "Member");
  const code = oneOf(data.reasonCode, DQ_REASONS, "Reason");
  const note = U.reason(data.note);
  const mRef = db.collection("memberships").doc(membershipId(memberUid, "chamber"));
  await db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (!m.exists) fail("not-found", "Membership not found");
    transition(tx, mRef, m.data(), "disqualified", { actor, service: "chamber", reason: `${code}: ${note}`, extra: { disqualifyReason: code } });
  });
  await notify(memberUid, { event: "disqualified", title: "Chamber membership ended", body: `Reason: ${code.replace(/_/g, " ")}. ${note}`, link: "/app/#chamber" });
  return { ok: true };
}, { allow: ["admin"] });

/** A-3: admin pauses or reinstates a member, with a written reason. */
const adminSetState = callable("adminSetState", async ({ uid: actor, data }) => {
  const memberUid = id(data.uid, "Member");
  const service = oneOf(data.service, Object.keys(C.SERVICES), "Service");
  const action = oneOf(data.action, ["pause", "reinstate"], "Action");
  const note = U.reason(data.note);
  if (action === "pause") {
    await pauseService(memberUid, service, { actor, reason: note });
    return { ok: true };
  }
  const mRef = db.collection("memberships").doc(membershipId(memberUid, service));
  await db.runTransaction(async (tx) => {
    const m = await tx.get(mRef);
    if (!m.exists) fail("not-found", "Membership not found");
    transition(tx, mRef, m.data(), "active", { actor, service, reason: `Reinstated: ${note}` });
  });
  return { ok: true };
}, { allow: ["admin"] });

/* ------------------------------------------------------------------ */
/* Clip playback: short-lived signed links only (N-3)                   */
/* ------------------------------------------------------------------ */

const getClipUrl = callable("getClipUrl", async ({ uid, roles, token, data }) => {
  const kind = oneOf(data.kind || "submission", ["submission", "evidence"], "Kind");
  let path;
  let owner;
  if (kind === "submission") {
    const s = (await U.mustGet(db.collection("submissions").doc(id(data.id, "Submission")), "Submission")).data();
    path = s.clipPath;
    owner = s.uid;
  } else {
    const r = (await U.mustGet(db.collection("evidenceRequests").doc(id(data.id, "Request")), "Request")).data();
    const f = String(data.file || "");
    if (!(r.files || []).includes(f)) fail("not-found", "File not found");
    path = f;
    owner = r.uid;
  }
  const staff = roles.includes("reviewer") || roles.includes("admin");
  if (owner !== uid && !staff) fail("permission-denied", "Not your record.");
  if (staff && owner !== uid && U.staffMfaRequired() && !U.hasSecondFactor(token)) {
    fail("permission-denied", "Staff need two-step login to view clips.");
  }
  const [url] = await U.admin.storage().bucket().file(path).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + 10 * 60 * 1000 });
  await audit({ actor: uid, action: "clip.viewed", object: path, subjectUid: owner });
  return { url, expiresInSeconds: 600 };
}, { limit: [120, 3600] });

module.exports = {
  savePlanDraft,
  submitPlan,
  decidePlan,
  requestUnlock,
  decideUnlock,
  beginUpload,
  submitRecord,
  reportUploadIssue,
  markSubmission,
  confirmViolation,
  dismissViolation,
  intentRuling,
  reverseViolation,
  respondToViolation,
  requestEvidence,
  submitEvidence,
  recordEvidenceResult,
  requestResubmission,
  requestPause,
  clearToReturn,
  returnFromPause,
  clearSuspension,
  leaveService,
  disqualify,
  adminSetState,
  getClipUrl,
  // for jobs and payments
  issueAutomatic,
  confirmAndIssue,
  suspensionCheck,
  activateIfReady,
  OPEN_STATES,
  RULE_TO_CATEGORY,
};
