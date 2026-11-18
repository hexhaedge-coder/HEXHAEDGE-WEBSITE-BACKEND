"use strict";
// Run with: npm test   (or: node --test test/)
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../src/engine");

const FX = { synthetic: false, noTradeDays: [] };

test("dateKey and zonedTime use Nairobi time", () => {
  // 2026-11-18 21:30 UTC is 2026-11-19 00:30 in Nairobi
  assert.equal(E.dateKey(new Date("2026-11-18T21:30:00Z")), "2026-11-19");
  const t = E.zonedTime("2026-11-19", "09:00");
  assert.equal(t.toISOString(), "2026-11-19T06:00:00.000Z");
  assert.equal(E.zoneOffsetMinutes(new Date(), "Africa/Nairobi"), 180);
});

test("trading days skip weekends and the no-trade calendar", () => {
  assert.equal(E.isTradingDay("2026-11-21", FX), false); // Saturday
  assert.equal(E.isTradingDay("2026-11-21", { synthetic: true }), true);
  assert.equal(E.isTradingDay("2026-12-25", { noTradeDays: ["2026-12-25"] }), false);
  assert.equal(E.nextTradingDay("2026-11-20", FX), "2026-11-23"); // Fri → Mon
  assert.equal(E.prevTradingDay("2026-11-23", FX), "2026-11-20");
  assert.equal(E.tradingDaysBetween("2026-11-16", "2026-11-22", FX), 5);
});

test("timeouts start the next trading day and run in trading days", () => {
  // Critical (5) issued Wed 18 Nov → Thu 19 … Wed 25 Nov
  assert.deepEqual(E.timeoutWindow("2026-11-18", 5, FX), { start: "2026-11-19", end: "2026-11-25" });
  // Minor issued Friday → Monday only
  assert.deepEqual(E.timeoutWindow("2026-11-20", 1, FX), { start: "2026-11-23", end: "2026-11-23" });
  const t = { status: "active", start: "2026-11-19", end: "2026-11-25" };
  assert.equal(E.timeoutDaysRemaining(t, "2026-11-19", FX), 5);
  assert.equal(E.timeoutDaysRemaining(t, "2026-11-24", FX), 2);
  assert.equal(E.timeoutDaysRemaining(t, "2026-11-26", FX), 0);
});

test("several timeouts run together and the longest sets the end", () => {
  const ts = [
    { status: "active", start: "2026-11-19", end: "2026-11-19" },
    { status: "active", start: "2026-11-19", end: "2026-11-25" },
    { status: "reversed", start: "2026-11-19", end: "2026-12-30" },
  ];
  assert.equal(E.activeTimeoutEnd(ts, "2026-11-20", FX), "2026-11-25");
});

test("pause freezes remaining timeout days and resumes them", () => {
  const t = { id: "t1", status: "active", start: "2026-11-19", end: "2026-11-25" };
  const frozen = E.freezeTimeout(t, "2026-11-23", FX); // Mon: 23, 24, 25 left
  assert.equal(frozen.frozenRemaining, 3);
  const back = E.resumeTimeout(frozen, "2026-12-07", FX); // Monday
  assert.deepEqual([back.status, back.start, back.end], ["active", "2026-12-07", "2026-12-09"]);
});

test("suspension counts Serious/Critical days in 20 trading days; Minor never counts", () => {
  const v = (date, tier, status = "confirmed") => ({ tradingDate: date, tier, status });
  const list = [
    v("2026-11-02", "serious"),
    v("2026-11-10", "minor"),
    v("2026-11-12", "critical"),
    v("2026-11-12", "serious"), // same day counts once
    v("2026-11-16", "serious", "reversed"),
  ];
  let r = E.suspensionCount(list, "2026-11-18", FX);
  assert.equal(r.count, 2);
  assert.equal(r.suspend, false);
  r = E.suspensionCount([...list, v("2026-11-18", "critical")], "2026-11-18", FX);
  assert.equal(r.count, 3);
  assert.equal(r.suspend, true);
  // the oldest one drops out of the window 20 trading days later
  r = E.suspensionCount([...list, v("2026-11-18", "critical")], "2026-12-01", FX);
  assert.equal(r.windowStart > "2026-11-02", true);
  assert.equal(r.count, 2);
});

test("SOD must match the prior EOD to the cent by default", () => {
  assert.equal(E.matchCheck({ balance: 1000, equity: 1000 }, { balance: 1000, equity: 1000 }).match, true);
  assert.equal(E.matchCheck({ balance: 1000, equity: 1000 }, { balance: 1000.01, equity: 1000 }).match, false);
  assert.equal(E.matchCheck({ balance: 1000, equity: 1000 }, { balance: 999.7, equity: 999.7 }, 0.5).match, true);
  assert.equal(E.matchCheck(null, { balance: 5, equity: 5 }).reason, "no_prior");
});

test("upload started before the deadline and finished within 30 min is on time", () => {
  const due = new Date("2026-11-18T06:00:00Z");
  const ok = E.uploadTiming({ dueAt: due, startedAt: new Date("2026-11-18T05:59:00Z"), finishedAt: new Date("2026-11-18T06:20:00Z") });
  assert.equal(ok.status, "on_time");
  const late = E.uploadTiming({ dueAt: due, startedAt: new Date("2026-11-18T06:01:00Z"), finishedAt: new Date("2026-11-18T06:05:00Z") });
  assert.deepEqual(late, { status: "late", lateMinutes: 5 });
  assert.equal(E.isMissing(due, new Date("2026-11-19T06:00:00Z")), true);
  assert.equal(E.isMissing(due, new Date("2026-11-19T05:59:00Z")), false);
});

test("evaluateSubmission: late clip is automatic Minor; mismatch waits for a reviewer", () => {
  const base = {
    kind: "sod",
    dueAt: new Date("2026-11-18T06:00:00Z"),
    startedAt: new Date("2026-11-18T06:10:00Z"),
    finishedAt: new Date("2026-11-18T06:11:00Z"),
    clipSeconds: 10,
    prevEod: { balance: 500, equity: 500 },
    typed: { balance: 480, equity: 480 },
    memberState: "active",
  };
  const r = E.evaluateSubmission(base);
  assert.equal(r.auto.length, 1);
  assert.equal(r.auto[0].category, "late_clip");
  assert.ok(r.flags.find((f) => f.code === "mismatch" && f.needsDecision));
  const during = E.evaluateSubmission({ ...base, memberState: "timeout" });
  assert.ok(during.flags.find((f) => f.code === "trading_during_timeout"));
  const outage = E.evaluateSubmission({ ...base, outage: true });
  assert.equal(outage.auto.length, 0, "never punished for our outage");
  const shortClip = E.evaluateSubmission({ ...base, clipSeconds: 3, typed: { balance: 500, equity: 500 } });
  assert.ok(shortClip.flags.find((f) => f.code === "clip_length"));
});

test("state machine allows only the transitions in the PRD", () => {
  assert.equal(E.canTransition("plan_review", "active"), true);
  assert.equal(E.canTransition("applicant", "active"), false);
  assert.equal(E.canTransition("disqualified", "active"), false);
  assert.equal(E.canTransition("suspended", "active"), true);
  assert.throws(() => E.assertTransition("exited", "active"));
  assert.equal(E.owesDailyRecord("timeout"), true);
  assert.equal(E.owesDailyRecord("paused"), false);
});

test("a plan with a blank required category cannot be accepted", () => {
  const full = {
    accountType: "personal",
    sodDeadline: "09:00",
    eodDeadline: "21:00",
    rules: {
      stop_rule: "At entry, below the swing",
      risk_per_trade: "1%",
      daily_loss_limit: "3%",
      trades_per_day: 3,
      instruments: ["XAUUSD"],
      sessions: ["London"],
      setups: ["Break and retest"],
      adding_allowed: false,
      partials_allowed: true,
      breakeven_allowed: false,
      losing_streak_limit: 2,
    },
  };
  assert.deepEqual(E.planMissing(full), []);
  assert.deepEqual(E.planMissing({ ...full, rules: { ...full.rules, setups: [" "] } }), ["setups"]);
  const prop = { ...full, accountType: "prop", firmRules: { firm_name: "X" } };
  assert.deepEqual(E.planMissing(prop), ["firm_daily_loss", "firm_max_loss", "firm_other_rules"]);
});

test("weight table suggests tiers and records its version", () => {
  const s = E.suggestTier("size_above_plan");
  assert.deepEqual([s.tier, s.days, s.weightTableVersion], ["critical", 5, 1]);
  assert.equal(E.suggestTier("late_clip").days, 1);
  assert.throws(() => E.suggestTier("made_up"));
});

test("clean streak and the weekly report", () => {
  const obligations = [
    { date: "2026-11-16", sodStatus: "on_time", eodStatus: "on_time" },
    { date: "2026-11-17", sodStatus: "late", eodStatus: "on_time" },
    { date: "2026-11-18", sodStatus: "on_time", eodStatus: "on_time" },
    { date: "2026-11-19", sodStatus: "on_time", eodStatus: "on_time" },
  ];
  assert.equal(E.cleanStreak(obligations, [], "2026-11-19", FX), 2);
  const report = E.buildWeeklyReport({
    weekStart: "2026-11-16", weekEnd: "2026-11-22", obligations,
    submissions: [
      { tradingDate: "2026-11-16", kind: "eod", balance: 101, equity: 101 },
      { tradingDate: "2026-11-16", kind: "sod", balance: 100, equity: 100 },
    ],
    violations: [{ id: "v1", tradingDate: "2026-11-17", category: "late_clip", tier: "minor", status: "confirmed" }],
    timeouts: [], streak: 2,
  });
  assert.deepEqual(report.clips, { onTime: 7, late: 1, missing: 0 });
  assert.equal(report.violationsByTier.minor, 1);
  assert.deepEqual(report.balanceLine.map((b) => b.kind), ["sod", "eod"]);
});

test("booking cut-off is the Friday 18:00 before the review week", () => {
  const cut = E.bookingCutoff("2026-11-23");
  assert.equal(cut.toISOString(), "2026-11-20T15:00:00.000Z");
  assert.equal(E.weekMonday("2026-11-22"), "2026-11-16"); // Sunday belongs to the week before
  assert.equal(E.cancellationCountsAsMiss(new Date("2026-11-20T10:00:00Z"), new Date("2026-11-20T00:00:00Z")), true);
});

test("unlock reasons and review length", () => {
  const r = E.unlockReasons({ lockedOn: "2026-10-01", today: "2026-11-02", cleanTradingDays: 22 }, FX);
  assert.deepEqual(r, ["monthly_checkpoint", "clean_month"]);
  assert.equal(E.reviewLengthFor("2026-11-17", "2026-11-18", FX), 20);
  assert.equal(E.reviewLengthFor(null, "2026-11-18", FX), 10);
});

test("Build Your Edge: fee kept without a gap; trainer prompt at three misses", () => {
  assert.equal(E.feeFor({ joinedFee: 75, currentFee: 90, lastPaidPeriodEnd: "2026-11-30", newPeriodStart: "2026-12-01" }), 75);
  assert.equal(E.feeFor({ joinedFee: 75, currentFee: 90, lastPaidPeriodEnd: "2026-10-31", newPeriodStart: "2026-12-01" }), 90);
  const p = E.missedSessionPrompt([
    { date: "2026-11-16", status: "missed" }, { date: "2026-11-17", status: "missed" }, { date: "2026-11-18", status: "missed" },
  ], "2026-11-16", "2026-11-22");
  assert.equal(p.prompt, true);
});
