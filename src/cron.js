"use strict";
/**
 * Scheduled jobs runner.
 *
 *   node src/cron.js            run every job that is due now (Render Cron Job, every 5 minutes)
 *   node src/cron.js run <job>  run one job now, by name (for testing or recovery)
 *
 * Jobs say when they are due in Nairobi time (see jobs.js). Each job runs once
 * per period: the period is claimed in Firestore (system/cronLocks) inside a
 * transaction before the job starts, so two ticks never run the same job twice.
 * A tick that was missed catches up on the next one the same day.
 */
const E = require("./engine");
const C = require("./config");

function nairobiNow(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: C.TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  return { date, time: `${g("hour")}:${g("minute")}`, weekday: E.weekday(date) };
}

/** The period key a job should run for now, or null when it is not due. */
function duePeriod(when, d = new Date()) {
  const n = nairobiNow(d);
  if (when.every === "minutes") return `m${Math.floor(d.getTime() / (when.minutes * 60000))}`;
  if (when.every === "day") return n.time >= when.at ? n.date : null;
  if (when.every === "week") return n.weekday === when.weekday && n.time >= when.at ? n.date : null;
  return null;
}

async function claim(name, period) {
  const { db } = require("./util");
  const ref = db.collection("system").doc("cronLocks");
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const cur = s.exists ? s.data()[name] : null;
    if (cur === period) return false;
    tx.set(ref, { [name]: period }, { merge: true });
    return true;
  });
}

async function tick(d = new Date()) {
  const registry = require("./index");
  const ran = [];
  for (const job of Object.values(registry).filter((x) => x && x.kind === "schedule")) {
    const period = duePeriod(job.when, d);
    if (!period) continue;
    if (!(await claim(job.name, period))) continue;
    try {
      await job.run();
      ran.push({ job: job.name, ok: true });
    } catch (e) {
      ran.push({ job: job.name, ok: false, error: e.message });
    }
  }
  return ran;
}

module.exports = { tick, duePeriod, nairobiNow };

if (require.main === module) {
  const [cmd, name] = process.argv.slice(2);
  const go = cmd === "run"
    ? (async () => {
      const job = require("./index")[name];
      if (!job || job.kind !== "schedule") throw new Error(`No job called ${name}`);
      return [{ job: name, out: await job.run() }];
    })()
    : tick();
  go.then((ran) => {
    console.log(JSON.stringify({ level: "info", msg: "cron done", ran, at: new Date().toISOString() }));
    process.exit(ran.some((r) => r.ok === false) ? 1 : 0);
  }).catch((e) => {
    console.error(JSON.stringify({ level: "error", msg: "cron failed", error: e.message }));
    process.exit(1);
  });
}
