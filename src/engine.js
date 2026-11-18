"use strict";
/**
 * HexhaEdge Chamber rules engine.
 *
 * Pure functions only: no database, no clock, no network. Every function gets
 * what it needs as arguments, so the same inputs always give the same result
 * (PRD R-6). The API and job layer reads records, calls these functions,
 * writes the result and logs what the engine saw and decided.
 *
 * Dates are "date keys" (YYYY-MM-DD) in the member's plan time zone.
 * Times are JS Date objects (UTC instants).
 */

const DEFAULT_TZ = "Africa/Nairobi";

/* ------------------------------------------------------------------ */
/* Settings: rules kept as data. Admin edits these; each edit is a new */
/* version and every violation stores the version it was issued under. */
/* ------------------------------------------------------------------ */

const TIERS = Object.freeze(["minor", "serious", "critical"]);

const DEFAULT_RULES = Object.freeze({
  tierDays: { minor: 1, serious: 3, critical: 5 },
  suspensionWindowDays: 20,      // trading days
  suspensionThreshold: 3,        // Serious or Critical timeouts in the window
  clipMinSeconds: 8,
  clipMaxSeconds: 15,
  balanceTolerance: 0,           // account currency; 0 = must match to the cent
  uploadGraceMinutes: 30,        // upload started before deadline, finished within this
  missingAfterHours: 24,         // not submitted this long after due = clip not submitted
  reversalWindowHours: 24,       // reviewer can reverse an automatic ruling
  reviewLengthMinutes: 20,
  shortReviewMinutes: 10,        // proposal: clean stretch shortens the next review
  cleanStreakForShortReview: 20, // proposal: trading days with no timeouts
  cancelCutoffHours: 12,         // later cancellation counts as a miss (proposed)
  bookingCutoffWeekday: 5,       // Friday (0 = Sunday)
  bookingCutoffTime: "18:00",
  reviewerTargetTradingDays: 1,  // rulings by end of next trading day
  planLockDays: 30,
  evidenceDueHours: 24,
  resubmitDueHours: 2,
  autoNoBookingTimeout: true,    // proposed rule, can be switched off
  autoMissedReviewTimeout: true, // proposed rule, can be switched off
});

/** Rule categories and the tier each maps to. Version 1 of the weight table. */
const DEFAULT_WEIGHT_TABLE = Object.freeze({
  version: 1,
  categories: {
    // Critical: 5 trading days
    daily_loss_limit: { tier: "critical", label: "Broke the daily loss limit" },
    max_loss_limit: { tier: "critical", label: "Broke the maximum loss limit" },
    no_stop: { tier: "critical", label: "Traded with no stop" },
    wider_stop: { tier: "critical", label: "Stop wider than plan" },
    size_above_plan: { tier: "critical", label: "Size or risk above plan" },
    record_mismatch: { tier: "critical", label: "Record does not match (SOD vs prior EOD)" },
    firm_rule: { tier: "critical", label: "Broke a prop firm rule" },
    // Serious: 3 trading days
    early_close: { tier: "serious", label: "Closed early against plan" },
    breakeven_against_plan: { tier: "serious", label: "Moved to break-even against plan" },
    adding_against_plan: { tier: "serious", label: "Added to a position against plan" },
    partials_against_plan: { tier: "serious", label: "Took partials against plan" },
    outside_setups: { tier: "serious", label: "Traded outside declared setups" },
    instrument_not_allowed: { tier: "serious", label: "Traded an instrument not in the plan" },
    session_not_allowed: { tier: "serious", label: "Traded outside declared sessions" },
    trades_over_limit: { tier: "serious", label: "More trades than allowed" },
    losing_streak_limit: { tier: "serious", label: "Kept trading past the losing-streak limit" },
    no_pretrade_analysis: { tier: "serious", label: "No pre-trade analysis" },
    clip_not_submitted: { tier: "serious", label: "A clip was not submitted" },
    // Minor: 1 trading day
    late_clip: { tier: "minor", label: "Clip submitted late" },
    clip_missing_part: { tier: "minor", label: "Clip missing a required part" },
    missed_checkin: { tier: "minor", label: "Missed check-in" },
    no_review_booked: { tier: "minor", label: "No weekly review booked by the cut-off" },
    missed_review: { tier: "minor", label: "Missed a booked weekly review" },
  },
});

/**
 * Plan categories a member must fill before a plan can be accepted (PRD
 * Door 2 step 1, W-6). `kind` drives the form and validation.
 */
const PLAN_CATEGORIES = Object.freeze([
  { key: "stop_rule", label: "Stop rule", kind: "text", help: "Where the stop goes and when it is placed.", required: true },
  { key: "risk_per_trade", label: "Size or risk per trade", kind: "text", help: "For example 1% of balance, or 0.10 lots.", required: true },
  { key: "daily_loss_limit", label: "Daily loss limit", kind: "text", help: "Amount or % at which you stop for the day.", required: true },
  { key: "trades_per_day", label: "Trades per day (maximum)", kind: "int", required: true },
  { key: "instruments", label: "Allowed instruments", kind: "list", help: "One per line.", required: true },
  { key: "sessions", label: "Sessions you trade", kind: "list", help: "For example London 10:00–13:00 EAT.", required: true },
  { key: "setups", label: "Setups you trade", kind: "list", help: "Name each setup. The daily form picks from these.", required: true },
  { key: "adding_allowed", label: "Adding to positions allowed", kind: "bool", required: true },
  { key: "partials_allowed", label: "Partial closes allowed", kind: "bool", required: true },
  { key: "breakeven_allowed", label: "Moving to break-even allowed", kind: "bool", required: true },
  { key: "losing_streak_limit", label: "Losing-streak limit (trades)", kind: "int", required: true },
]);

const FIRM_CATEGORIES = Object.freeze([
  { key: "firm_name", label: "Prop firm", kind: "text", required: true },
  { key: "firm_daily_loss", label: "Firm daily loss rule", kind: "text", required: true },
  { key: "firm_max_loss", label: "Firm maximum loss rule", kind: "text", required: true },
  { key: "firm_other_rules", label: "Other firm rules, in full", kind: "text", required: true },
]);

/* ------------------------------------------------------------------ */
/* Time and trading days                                               */
/* ------------------------------------------------------------------ */

function pad(n) { return String(n).padStart(2, "0"); }

/** YYYY-MM-DD of an instant in a time zone. */
function dateKey(date, tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function parseKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error(`Bad date key: ${key}`);
  const [y, m, d] = key.split("-").map(Number);
  return { y, m, d };
}

/** Day of week (0 Sunday) for a date key; calendar maths only, no zone. */
function weekday(key) {
  const { y, m, d } = parseKey(key);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(key, n) {
  const { y, m, d } = parseKey(key);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Offset in minutes of a zone at an instant (e.g. +180 for Nairobi). */
function zoneOffsetMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** The instant of a wall-clock time ("HH:MM") on a date key in a zone. */
function zonedTime(key, hhmm, tz = DEFAULT_TZ) {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`Bad time: ${hhmm}`);
  const { y, m, d } = parseKey(key);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const off1 = zoneOffsetMinutes(guess, tz);
  const first = new Date(guess.getTime() - off1 * 60000);
  const off2 = zoneOffsetMinutes(first, tz);
  return off1 === off2 ? first : new Date(guess.getTime() - off2 * 60000);
}

/**
 * A trading day: Monday to Friday, or every day for synthetic indices
 * (decided), minus the admin's no-trade calendar.
 * @param {string} key
 * @param {{synthetic?: boolean, noTradeDays?: Iterable<string>}} opts
 */
function isTradingDay(key, opts = {}) {
  const noTrade = toSet(opts.noTradeDays);
  if (noTrade.has(key)) return false;
  if (opts.synthetic) return true;
  const wd = weekday(key);
  return wd !== 0 && wd !== 6;
}

function toSet(x) {
  if (!x) return new Set();
  return x instanceof Set ? x : new Set(x);
}

function nextTradingDay(key, opts = {}) {
  let k = addDays(key, 1);
  for (let i = 0; i < 400; i++) {
    if (isTradingDay(k, opts)) return k;
    k = addDays(k, 1);
  }
  throw new Error("No trading day found within 400 days");
}

function prevTradingDay(key, opts = {}) {
  let k = addDays(key, -1);
  for (let i = 0; i < 400; i++) {
    if (isTradingDay(k, opts)) return k;
    k = addDays(k, -1);
  }
  throw new Error("No trading day found within 400 days");
}

/** Count trading days in [from, to], both included. */
function tradingDaysBetween(from, to, opts = {}) {
  if (from > to) return 0;
  let n = 0;
  for (let k = from; k <= to; k = addDays(k, 1)) if (isTradingDay(k, opts)) n++;
  return n;
}

/**
 * The first day of the window made of the last `n` trading days up to and
 * including `asOf` (or the closest trading day before it).
 */
function windowStart(asOf, n, opts = {}) {
  let k = isTradingDay(asOf, opts) ? asOf : prevTradingDay(asOf, opts);
  for (let i = 1; i < n; i++) k = prevTradingDay(k, opts);
  return k;
}

/* ------------------------------------------------------------------ */
/* Timeouts                                                            */
/* ------------------------------------------------------------------ */

function tierDays(tier, rules = DEFAULT_RULES) {
  if (!TIERS.includes(tier)) throw new Error(`Unknown tier: ${tier}`);
  return rules.tierDays[tier];
}

function tierRank(tier) { return TIERS.indexOf(tier); }

function suggestTier(category, weightTable = DEFAULT_WEIGHT_TABLE, rules = DEFAULT_RULES) {
  const row = weightTable.categories[category];
  if (!row) throw new Error(`Unknown rule category: ${category}`);
  return { tier: row.tier, days: tierDays(row.tier, rules), label: row.label, weightTableVersion: weightTable.version };
}

/**
 * A timeout issued on `issuedOn` covers the next `days` trading days.
 * Returns { start, end } date keys, both included.
 */
function timeoutWindow(issuedOn, days, opts = {}) {
  if (!Number.isInteger(days) || days < 1) throw new Error("Timeout days must be a positive integer");
  const start = nextTradingDay(issuedOn, opts);
  let end = start;
  for (let i = 1; i < days; i++) end = nextTradingDay(end, opts);
  return { start, end };
}

/** Trading days a timeout still has on `today` (today counts if inside). */
function timeoutDaysRemaining(t, today, opts = {}) {
  if (t.status === "reversed" || t.status === "ended") return 0;
  if (t.status === "frozen") return t.frozenRemaining || 0;
  const from = today > t.start ? today : t.start;
  return tradingDaysBetween(from, t.end, opts);
}

/** Is the member inside any active timeout today? The longest one sets the end. */
function activeTimeoutEnd(timeouts, today, opts = {}) {
  let end = null;
  for (const t of timeouts) {
    if (t.status !== "active") continue;
    if (timeoutDaysRemaining(t, today, opts) > 0 && (!end || t.end > end)) end = t.end;
  }
  return end;
}

/** Pause during a timeout: remaining days freeze and resume on return (proposed). */
function freezeTimeout(t, today, opts = {}) {
  return { ...t, status: "frozen", frozenRemaining: timeoutDaysRemaining({ ...t, status: "active" }, today, opts) };
}

function resumeTimeout(t, returnDay, opts = {}) {
  if (t.status !== "frozen") return t;
  if (!t.frozenRemaining) return { ...t, status: "ended", frozenRemaining: 0 };
  // The return day itself is the first day back under the timeout.
  const start = isTradingDay(returnDay, opts) ? returnDay : nextTradingDay(returnDay, opts);
  let end = start;
  for (let i = 1; i < t.frozenRemaining; i++) end = nextTradingDay(end, opts);
  return { ...t, status: "active", start, end, frozenRemaining: 0 };
}

/**
 * Rolling suspension count (R-5). Counts trading DAYS that carry at least one
 * confirmed Serious or Critical timeout inside the window; several violations on
 * one trading day count once, at the highest tier (proposed edge case).
 * Minor timeouts never count.
 */
function suspensionCount(violations, asOf, opts = {}, rules = DEFAULT_RULES) {
  const from = windowStart(asOf, rules.suspensionWindowDays, opts);
  const days = new Map();
  for (const v of violations) {
    if (v.status !== "confirmed") continue;
    if (v.tradingDate < from || v.tradingDate > asOf) continue;
    const prev = days.get(v.tradingDate);
    if (!prev || tierRank(v.tier) > tierRank(prev)) days.set(v.tradingDate, v.tier);
  }
  let count = 0;
  for (const tier of days.values()) if (tier === "serious" || tier === "critical") count++;
  return { count, windowStart: from, threshold: rules.suspensionThreshold, suspend: count >= rules.suspensionThreshold };
}

/* ------------------------------------------------------------------ */
/* Daily record checks                                                 */
/* ------------------------------------------------------------------ */

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * C-3: today's typed SOD against yesterday's typed EOD.
 * Returns match=true when both balance and equity sit within tolerance.
 * With no prior EOD (first day, or first day after a fresh plan) there is
 * nothing to compare and the check passes with reason "no_prior".
 */
function matchCheck(prevEod, sod, tolerance = 0) {
  if (!prevEod) return { match: true, reason: "no_prior", diffBalance: 0, diffEquity: 0 };
  const num = (x) => {
    const n = Number(x);
    if (!Number.isFinite(n)) throw new Error("Balance and equity must be numbers");
    return n;
  };
  const diffBalance = round2(num(sod.balance) - num(prevEod.balance));
  const diffEquity = round2(num(sod.equity) - num(prevEod.equity));
  const tol = Math.abs(Number(tolerance) || 0) + 1e-9;
  const match = Math.abs(diffBalance) <= tol && Math.abs(diffEquity) <= tol;
  return { match, reason: match ? "match" : "mismatch", diffBalance, diffEquity };
}

/**
 * C-5 and the upload edge case: a clip counts as on time if the upload
 * started before the deadline and finished within the grace minutes.
 */
function uploadTiming({ dueAt, startedAt, finishedAt }, rules = DEFAULT_RULES) {
  const due = +dueAt;
  const started = +startedAt;
  const finished = +finishedAt;
  if (!Number.isFinite(due) || !Number.isFinite(started) || !Number.isFinite(finished)) {
    throw new Error("dueAt, startedAt and finishedAt are required");
  }
  if (finished <= due) return { status: "on_time", lateMinutes: 0 };
  const graceEnd = due + rules.uploadGraceMinutes * 60000;
  if (started <= due && finished <= graceEnd) return { status: "on_time", lateMinutes: 0, usedGrace: true };
  return { status: "late", lateMinutes: Math.ceil((finished - due) / 60000) };
}

/** C-5: not submitted this long after the deadline = clip not submitted. */
function isMissing(dueAt, now, rules = DEFAULT_RULES) {
  return +now >= +dueAt + rules.missingAfterHours * 3600000;
}

function clipLengthOk(seconds, rules = DEFAULT_RULES) {
  const s = Number(seconds);
  return Number.isFinite(s) && s >= rules.clipMinSeconds && s <= rules.clipMaxSeconds;
}

/**
 * Evaluate one SOD or EOD submission. Returns the flags the reviewer sees and
 * the automatic rulings the system issues at once (R-3).
 *
 * Automatic (objective): late clip → Minor.
 * Sent to the reviewer first: SOD/EOD mismatch (Critical, may be a typing slip).
 * During a timeout or suspension a mismatch is raised as "trading_during_timeout".
 */
function evaluateSubmission(input, rules = DEFAULT_RULES) {
  const { kind, dueAt, startedAt, finishedAt, clipSeconds, prevEod, typed, memberState, outage } = input;
  if (kind !== "sod" && kind !== "eod") throw new Error("kind must be sod or eod");
  const flags = [];
  const auto = [];

  const timing = uploadTiming({ dueAt, startedAt, finishedAt }, rules);
  if (timing.status === "late") {
    flags.push({ code: "late", detail: `${timing.lateMinutes} min after the deadline` });
    // N-8: never punish members for our own outage.
    if (!outage) auto.push({ category: "late_clip", tier: "minor", reason: `Clip received ${timing.lateMinutes} minutes after the deadline.` });
  }

  if (!clipLengthOk(clipSeconds, rules)) {
    flags.push({ code: "clip_length", detail: `Clip is ${clipSeconds}s; allowed ${rules.clipMinSeconds}–${rules.clipMaxSeconds}s` });
  }

  let match = null;
  if (kind === "sod") {
    match = matchCheck(prevEod, typed, rules.balanceTolerance);
    if (!match.match) {
      const inTimeout = memberState === "timeout" || memberState === "suspended";
      flags.push({
        code: inTimeout ? "trading_during_timeout" : "mismatch",
        detail: `Balance moved by ${match.diffBalance}, equity by ${match.diffEquity} since the last EOD`,
        needsDecision: true,
      });
    }
  }
  return { timing, match, flags, auto };
}

/* ------------------------------------------------------------------ */
/* Member states (PRD "Member states")                                 */
/* ------------------------------------------------------------------ */

const CHAMBER_STATES = Object.freeze([
  "applicant", "onboarding", "plan_review", "active", "timeout", "paused",
  "suspended", "plan_rewrite", "exited", "disqualified", "declined",
]);

const TRANSITIONS = Object.freeze({
  applicant: ["onboarding", "declined", "exited"],
  onboarding: ["plan_review", "exited"],
  plan_review: ["active", "onboarding", "exited"],
  active: ["timeout", "paused", "suspended", "plan_rewrite", "exited", "disqualified"],
  timeout: ["active", "timeout", "paused", "suspended", "plan_rewrite", "exited", "disqualified"],
  paused: ["active", "timeout", "exited", "disqualified"],
  suspended: ["active", "exited", "disqualified"],
  plan_rewrite: ["plan_review", "exited", "disqualified", "paused"],
  exited: [],
  disqualified: [],
  declined: ["applicant"],
});

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`A member cannot move from ${from} to ${to}`);
}

/** Members who owe SOD and EOD clips (timeouts still need both, C-4). */
function owesDailyRecord(state) {
  return state === "active" || state === "timeout";
}

/* ------------------------------------------------------------------ */
/* Plans                                                                */
/* ------------------------------------------------------------------ */

function isBlank(v, kind) {
  if (kind === "bool") return typeof v !== "boolean";
  if (kind === "int") return !Number.isInteger(Number(v)) || v === "" || v === null || v === undefined || Number(v) < 0;
  if (kind === "list") return !Array.isArray(v) || v.filter((x) => String(x).trim()).length === 0;
  return typeof v !== "string" || v.trim().length === 0;
}

/**
 * W-6: a plan with a blank required category cannot be accepted.
 * Prop firm accounts must also carry the firm's rules in full.
 */
function planMissing(plan) {
  const missing = [];
  const rules = plan.rules || {};
  for (const c of PLAN_CATEGORIES) if (c.required && isBlank(rules[c.key], c.kind)) missing.push(c.key);
  if (plan.accountType === "prop") {
    const firm = plan.firmRules || {};
    for (const c of FIRM_CATEGORIES) if (c.required && isBlank(firm[c.key], c.kind)) missing.push(c.key);
  }
  if (!/^\d{2}:\d{2}$/.test(plan.sodDeadline || "")) missing.push("sodDeadline");
  if (!/^\d{2}:\d{2}$/.test(plan.eodDeadline || "")) missing.push("eodDeadline");
  if (!["prop", "personal", "practice"].includes(plan.accountType)) missing.push("accountType");
  return missing;
}

/**
 * C-12: when can a locked plan unlock?
 * Returns the reasons that apply today. A member still has to request it and
 * a reviewer decides.
 */
function unlockReasons({ lockedOn, today, cleanTradingDays = 0, newAccount = false, firmRuleChange = false, blownAccount = false }, opts = {}, rules = DEFAULT_RULES) {
  const reasons = [];
  if (lockedOn && addDays(lockedOn, rules.planLockDays) <= today) reasons.push("monthly_checkpoint");
  if (newAccount) reasons.push("new_account");
  if (firmRuleChange) reasons.push("firm_rule_change");
  if (blownAccount) reasons.push("blown_account");
  // A clean month: 20 clean trading days in a row since the lock (reward, early unlock).
  if (lockedOn && cleanTradingDays >= 20 && tradingDaysBetween(lockedOn, today, opts) >= 20) reasons.push("clean_month");
  return reasons;
}

/* ------------------------------------------------------------------ */
/* Clean streak and weekly report                                      */
/* ------------------------------------------------------------------ */

/**
 * Clean trading days in a row, counting back from `asOf`.
 * A day is clean when both clips were on time and no violation was confirmed for it.
 * @param {Array<{date:string, sodStatus:string, eodStatus:string}>} obligations
 */
function cleanStreak(obligations, violations, asOf, opts = {}) {
  const byDate = new Map(obligations.map((o) => [o.date, o]));
  const bad = new Set(violations.filter((v) => v.status === "confirmed").map((v) => v.tradingDate));
  let k = isTradingDay(asOf, opts) ? asOf : prevTradingDay(asOf, opts);
  let n = 0;
  for (let i = 0; i < 400; i++) {
    const o = byDate.get(k);
    if (!o) break;
    const clean = o.sodStatus === "on_time" && o.eodStatus === "on_time" && !bad.has(k);
    if (!clean) break;
    n++;
    k = prevTradingDay(k, opts);
  }
  return n;
}

function reviewLengthFor(lastTimeoutDate, asOf, opts = {}, rules = DEFAULT_RULES) {
  if (!lastTimeoutDate) return rules.shortReviewMinutes;
  const since = tradingDaysBetween(addDays(lastTimeoutDate, 1), asOf, opts);
  return since >= rules.cleanStreakForShortReview ? rules.shortReviewMinutes : rules.reviewLengthMinutes;
}

/**
 * C-10: the weekly report, built from the record. Figures only; the reviewer
 * adds the human note after the session.
 */
function buildWeeklyReport({ weekStart, weekEnd, obligations, submissions, violations, timeouts, planChanges = [], pauses = [], mindspaceShared = null, streak = 0 }) {
  const inWeek = (d) => d >= weekStart && d <= weekEnd;
  const obs = obligations.filter((o) => inWeek(o.date));
  const clip = { onTime: 0, late: 0, missing: 0 };
  for (const o of obs) {
    for (const s of [o.sodStatus, o.eodStatus]) {
      if (s === "on_time") clip.onTime++;
      else if (s === "late") clip.late++;
      else if (s === "missing") clip.missing++;
    }
  }
  const vs = violations.filter((v) => inWeek(v.tradingDate) && v.status !== "reversed");
  const byTier = { minor: 0, serious: 0, critical: 0 };
  for (const v of vs) if (v.status === "confirmed") byTier[v.tier]++;
  const balanceLine = submissions
    .filter((s) => inWeek(s.tradingDate))
    .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate) || (a.kind === "sod" ? -1 : 1) - (b.kind === "sod" ? -1 : 1))
    .map((s) => ({ date: s.tradingDate, kind: s.kind, balance: s.balance, equity: s.equity }));
  return {
    weekStart,
    weekEnd,
    clips: clip,
    violations: vs.map((v) => ({ id: v.id, date: v.tradingDate, category: v.category, tier: v.tier, status: v.status })),
    violationsByTier: byTier,
    timeouts: timeouts
      .filter((t) => (t.start <= weekEnd && t.end >= weekStart) && t.status !== "reversed")
      .map((t) => ({ id: t.id, tier: t.tier, start: t.start, end: t.end, status: t.status })),
    cleanStreak: streak,
    planChanges: planChanges.filter((p) => inWeek(p.date)),
    pauses: pauses.filter((p) => inWeek(p.date)),
    balanceLine,
    mindspace: mindspaceShared, // only what the member allowed to share
  };
}

/* ------------------------------------------------------------------ */
/* Weeks and booking                                                    */
/* ------------------------------------------------------------------ */

/** Monday of the week that contains `key`. */
function weekMonday(key) {
  const wd = weekday(key);
  return addDays(key, wd === 0 ? -6 : 1 - wd);
}

/** The booking cut-off instant for the week that starts on `nextMonday`. */
function bookingCutoff(nextMonday, tz = DEFAULT_TZ, rules = DEFAULT_RULES) {
  const back = (1 - rules.bookingCutoffWeekday + 7) % 7 || 7; // Friday before → 3 days back
  return zonedTime(addDays(nextMonday, -back), rules.bookingCutoffTime, tz);
}

/** Cancelling later than the cut-off before the slot counts as a miss (proposed). */
function cancellationCountsAsMiss(slotStart, now, rules = DEFAULT_RULES) {
  return +slotStart - +now < rules.cancelCutoffHours * 3600000;
}

/* ------------------------------------------------------------------ */
/* Build Your Edge helpers                                              */
/* ------------------------------------------------------------------ */

/** B-11: a pattern of missed sessions prompts the trainer. Never punishes. */
function missedSessionPrompt(sessions, weekStart, weekEnd, threshold = 3) {
  const missed = sessions.filter((s) => s.date >= weekStart && s.date <= weekEnd && s.status === "missed").length;
  return { missed, prompt: missed >= threshold };
}

/** B-9: fee kept while renewing without a gap; returning after a lapse pays the fee in force. */
function feeFor({ joinedFee, currentFee, lastPaidPeriodEnd, newPeriodStart }) {
  if (!lastPaidPeriodEnd || !joinedFee) return currentFee;
  return addDays(lastPaidPeriodEnd, 1) >= newPeriodStart ? joinedFee : currentFee;
}

module.exports = {
  DEFAULT_TZ,
  TIERS,
  DEFAULT_RULES,
  DEFAULT_WEIGHT_TABLE,
  PLAN_CATEGORIES,
  FIRM_CATEGORIES,
  CHAMBER_STATES,
  TRANSITIONS,
  dateKey,
  addDays,
  weekday,
  zonedTime,
  zoneOffsetMinutes,
  isTradingDay,
  nextTradingDay,
  prevTradingDay,
  tradingDaysBetween,
  windowStart,
  tierDays,
  tierRank,
  suggestTier,
  timeoutWindow,
  timeoutDaysRemaining,
  activeTimeoutEnd,
  freezeTimeout,
  resumeTimeout,
  suspensionCount,
  matchCheck,
  uploadTiming,
  isMissing,
  clipLengthOk,
  evaluateSubmission,
  canTransition,
  assertTransition,
  owesDailyRecord,
  planMissing,
  unlockReasons,
  cleanStreak,
  reviewLengthFor,
  buildWeeklyReport,
  weekMonday,
  bookingCutoff,
  cancellationCountsAsMiss,
  missedSessionPrompt,
  feeFor,
};
