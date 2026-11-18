"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { duePeriod, nairobiNow } = require("../src/cron");

test("cron: daily jobs are due once the Nairobi time has passed", () => {
  // 21:04 UTC = 00:04 Nairobi next day: not yet due for an 00:05 job
  assert.equal(duePeriod({ every: "day", at: "00:05" }, new Date("2026-11-18T21:04:00Z")), null);
  assert.equal(duePeriod({ every: "day", at: "00:05" }, new Date("2026-11-18T21:06:00Z")), "2026-11-19");
  // later the same day it is still the same period, so it runs only once
  assert.equal(duePeriod({ every: "day", at: "00:05" }, new Date("2026-11-19T10:00:00Z")), "2026-11-19");
});

test("cron: weekly jobs only on their weekday, after their time", () => {
  // Friday 20 Nov 2026, 18:00 Nairobi = 15:00 UTC
  assert.equal(duePeriod({ every: "week", weekday: 5, at: "18:00" }, new Date("2026-11-20T14:59:00Z")), null);
  assert.equal(duePeriod({ every: "week", weekday: 5, at: "18:00" }, new Date("2026-11-20T15:01:00Z")), "2026-11-20");
  assert.equal(duePeriod({ every: "week", weekday: 5, at: "18:00" }, new Date("2026-11-21T15:01:00Z")), null);
});

test("cron: interval jobs change period every N minutes", () => {
  const a = duePeriod({ every: "minutes", minutes: 15 }, new Date("2026-11-20T10:01:00Z"));
  const b = duePeriod({ every: "minutes", minutes: 15 }, new Date("2026-11-20T10:14:00Z"));
  const c = duePeriod({ every: "minutes", minutes: 15 }, new Date("2026-11-20T10:16:00Z"));
  assert.equal(a, b);
  assert.notEqual(b, c);
  assert.equal(nairobiNow(new Date("2026-11-20T21:30:00Z")).date, "2026-11-21");
});
