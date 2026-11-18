"use strict";
/**
 * Scheduled jobs (PRD "Scheduled jobs"). All run on Africa/Nairobi time.
 * Counting and issuing are automatic; anything that needs reading a clip
 * waits for a reviewer.
 */
const E = require("./engine");
const U = require("./util");
const C = require("./config");
const { notify, notifyAdmins } = require("./notify");
const { issueAutomatic } = require("./chamber");
const { ensureInvoice } = require("./payments");
const { transition } = require("./states");

const { db, FieldValue, Timestamp, logger, audit, membershipId, calOpts } = U;

const OWES = ["active", "timeout"];
const BOOKABLE = ["active", "timeout", "plan_rewrite"];

/**
 * A scheduled job. `when` says when it is due, in Nairobi time; cron.js runs
 * every few minutes and starts each job once per period when it is due, so a
 * missed tick catches up instead of skipping. Every run is recorded in
 * system/jobs, and a failure alerts the admin.
 */
function job(name, when, fn) {
  async function run() {
    const started = Date.now();
    try {
      const out = await fn();
      await db.collection("system").doc("jobs").set({ [name]: { lastRunAt: FieldValue.serverTimestamp(), ok: true, ms: Date.now() - started, out: out || null } }, { merge: true });
      return out;
    } catch (e) {
      logger.error(`job ${name} failed`, { error: e.message, stack: e.stack });
      await db.collection("system").doc("jobs").set({ [name]: { lastRunAt: FieldValue.serverTimestamp(), ok: false, error: String(e.message).slice(0, 500) } }, { merge: true });
      await U.alertAdmin("job_failure", `${name}: ${e.message}`);
      throw e;
    }
  }
  return { kind: "schedule", name, when, run };
}

async function chamberMembers(states) {
  const q = await db.collection("memberships").where("service", "==", "chamber").where("state", "in", states).get();
  return q.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
}

/* ------------------------------------------------------------------ */
/* C-1: daily obligations, 00:05 every day (weekday check per plan)     */
/* ------------------------------------------------------------------ */

const createDailyObligations = job("createDailyObligations", { every: "day", at: "00:05" }, async () => {
  const settings = await U.loadSettings();
  let created = 0;
  for (const m of await chamberMembers(OWES)) {
    const plans = await db.collection("plans").where("uid", "==", m.uid).where("status", "==", "locked").get();
    for (const p of plans.docs) {
      const plan = p.data();
      const tz = plan.timezone || C.TZ;
      const today = E.dateKey(new Date(), tz);
      if (!E.isTradingDay(today, calOpts(settings, plan))) continue;
      const ref = db.collection("obligations").doc(`${m.uid}_${p.id}_${today}`);
      const exists = await ref.get();
      if (exists.exists) continue;
      await ref.set({
        uid: m.uid, planId: p.id, accountLabel: plan.accountLabel || null, date: today,
        sodDue: Timestamp.fromDate(E.zonedTime(today, plan.sodDeadline, tz)),
        eodDue: Timestamp.fromDate(E.zonedTime(today, plan.eodDeadline, tz)),
        sodStatus: "pending", eodStatus: "pending", open: true, reminders: {},
        createdAt: FieldValue.serverTimestamp(),
      });
      created++;
    }
  }
  return { created };
});

/* ------------------------------------------------------------------ */
/* Every 15 minutes: clip reminders, late flags, missing clips,          */
/* booking reminders, weekly reports one hour before each review        */
/* ------------------------------------------------------------------ */

async function sweepObligations(now, settings, outage) {
  const open = await db.collection("obligations").where("open", "==", true).get();
  let missing = 0;
  for (const d of open.docs) {
    const o = d.data();
    const r = { ...(o.reminders || {}) };
    const update = {};
    for (const kind of ["sod", "eod"]) {
      const status = o[`${kind}Status`];
      if (status !== "pending") continue;
      const due = o[`${kind}Due`].toDate();
      const label = kind.toUpperCase();
      if (kind === "sod" && !r.sod30 && +now >= +due - 30 * 60000 && +now < +due) {
        r.sod30 = true;
        await notify(o.uid, { event: "clip_due", title: `${label} clip due in 30 minutes`, body: "Record about 10 seconds showing balance and equity, then type the two numbers.", link: "/app/#record" });
      }
      if (!r[`${kind}Due`] && +now >= +due) {
        r[`${kind}Due`] = true;
        await notify(o.uid, { event: "clip_due", title: `${label} deadline reached`, body: `Your ${label} for ${o.date} is not in yet. Send it now; it will be recorded as late.`, link: "/app/#record" });
      }
      if (kind === "eod" && !r.eod2h && +now >= +due + 2 * 3600000) {
        r.eod2h = true;
        await notify(o.uid, { event: "clip_due", title: "EOD still missing", body: `Your EOD for ${o.date} is not in. After 24 hours it is recorded as not submitted.`, link: "/app/#record" });
      }
      if (E.isMissing(due, now, settings.rules)) {
        // N-8: if our platform was down, the deadline extends and nothing is issued.
        update[`${kind}Status`] = outage ? "excused" : "missing";
        if (!outage) {
          await issueAutomatic(o.uid, { category: "clip_not_submitted", tradingDate: o.date, planId: o.planId, evidence: { detail: `${label} for ${o.date} not submitted within 24 hours of the deadline` } });
          missing++;
        }
      }
    }
    update.reminders = r;
    const sod = update.sodStatus || o.sodStatus;
    const eod = update.eodStatus || o.eodStatus;
    if (sod !== "pending" && eod !== "pending") update.open = false;
    await d.ref.update(update);
  }
  return missing;
}

async function buildWeeklyReport(uid, weekStart, weekEnd, extra = {}) {
  const settings = await U.loadSettings();
  const get = async (col) => (await db.collection(col).where("uid", "==", uid).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const [obligations, submissions, violations, timeouts, pauses] = await Promise.all([get("obligations"), get("submissions"), get("violations"), get("timeouts"), get("pauses")]);
  const plans = (await get("plans")).filter((p) => p.lockedOn).map((p) => ({ date: p.lockedOn, version: p.version, accountLabel: p.accountLabel }));
  const share = await db.collection("users").doc(uid).collection("consents").doc("share_chamber_mindspace").get();
  let mindspace = null;
  if (share.exists && share.data().given) {
    const ms = await db.collection("mindspaceShared").doc(uid).get();
    const m = await db.collection("memberships").doc(membershipId(uid, "chamber")).get();
    mindspace = { attended: ms.exists ? ms.data().attendedCount || 0 : 0, cleared: m.exists ? Boolean(m.data().clearedToReturn) : false };
  }
  const streak = E.cleanStreak(obligations, violations, weekEnd, { noTradeDays: settings.noTradeDays });
  const figures = E.buildWeeklyReport({
    weekStart, weekEnd, obligations, submissions, violations, timeouts,
    planChanges: plans, pauses: pauses.map((p) => ({ date: p.requestedOn, returnedOn: p.returnedOn })), mindspaceShared: mindspace, streak,
  });
  const ref = db.collection("weeklyReports").doc(`${uid}_${weekStart}_${extra.kind || "review"}`);
  await ref.set({ uid, weekStart, weekEnd, figures, kind: extra.kind || "review", bookingId: extra.bookingId || null, sentAt: FieldValue.serverTimestamp() });
  await audit({ actor: "system", action: "engine.weekly_report", object: ref.path, subjectUid: uid, after: { clips: figures.clips, byTier: figures.violationsByTier, streak } });
  return ref.id;
}

async function sweepBookings(now) {
  const soon = await db.collection("bookings").where("status", "==", "booked").where("start", "<=", Timestamp.fromMillis(+now + 24 * 3600000)).get();
  for (const d of soon.docs) {
    const b = d.data();
    const r = { ...(b.reminders || {}) };
    const startMs = +b.start.toDate();
    const what = b.service === "chamber" ? "weekly review" : "MindSpace session";
    if (!r.h24 && startMs - +now <= 24 * 3600000 && startMs - +now > 60 * 60000) {
      r.h24 = true;
      await notify(b.uid, { event: "review_reminder", title: `Your ${what} is tomorrow`, body: `${new Date(startMs).toLocaleString("en-KE", { timeZone: C.TZ, weekday: "long", hour: "2-digit", minute: "2-digit" })}, ${b.minutes} minutes.`, link: "/app/" });
    }
    if (!r.h1 && startMs - +now <= 60 * 60000 && startMs > +now) {
      r.h1 = true;
      if (b.service === "chamber" && !b.reportId) {
        const wk = E.weekMonday(E.addDays(E.dateKey(new Date(startMs), C.TZ), -7));
        const prevWeekEnd = E.addDays(wk, 6);
        const reportId = await buildWeeklyReport(b.uid, wk, prevWeekEnd, { bookingId: d.id });
        await d.ref.update({ reportId });
        await notify(b.uid, { event: "weekly_report", title: "Your weekly report is ready", body: "It is the preparation for today's review.", link: "/app/#chamber" });
      }
      await notify(b.uid, { event: "review_reminder", title: `Your ${what} starts in an hour`, body: `${b.minutes} minutes. Join from your dashboard.`, link: "/app/" });
    }
    if (startMs + (b.minutes + 120) * 60000 < +now && !r.staffNudge) {
      r.staffNudge = true;
      await notify(b.staffUid, { event: "booking_open", title: "Close the session", body: "Mark it done, not attended, or reschedule.", link: "/staff/#calendar", urgent: false, email: false });
    }
    await d.ref.update({ reminders: r });
  }
}

async function sweepTraining(now) {
  const soon = await db.collection("trainingSessions").where("status", "==", "scheduled").where("start", "<=", Timestamp.fromMillis(+now + 60 * 60000)).where("start", ">", Timestamp.fromMillis(+now)).get();
  for (const d of soon.docs) {
    if (d.data().reminded) continue;
    for (const t of d.data().participants || [d.data().uid]) {
      await notify(t, { event: "session_soon", title: "Training starts within the hour", body: d.data().meetLink ? `Join on Google Meet: ${d.data().meetLink}` : "Open your dashboard for the link.", link: "/app/#build" });
    }
    await d.ref.update({ reminded: true });
  }
}

const quarterHourly = job("quarterHourly", { every: "minutes", minutes: 15 }, async () => {
  const settings = await U.loadSettings();
  const outage = await U.outageActive();
  const now = new Date();
  const missing = await sweepObligations(now, settings, outage);
  await sweepBookings(now);
  await sweepTraining(now);
  // evidence past due → tell the reviewer
  const overdue = await db.collection("evidenceRequests").where("status", "==", "open").where("dueAt", "<=", Timestamp.fromDate(now)).get();
  for (const e of overdue.docs) {
    await e.ref.update({ status: "overdue" });
    await notify(e.data().requestedBy, { event: "evidence_overdue", title: "Evidence not received", body: "A member did not send the requested dashboard evidence in time. Record the result in the queue.", link: "/staff/#queue", urgent: false, email: false });
  }
  return { missing, outage };
});

/* ------------------------------------------------------------------ */
/* 00:10: timeout countdown                                             */
/* ------------------------------------------------------------------ */

const timeoutCountdown = job("timeoutCountdown", { every: "day", at: "00:10" }, async () => {
  const settings = await U.loadSettings();
  const today = U.todayKey();
  const active = await db.collection("timeouts").where("status", "==", "active").get();
  const ended = new Set();
  for (const d of active.docs) {
    const t = d.data();
    const left = E.timeoutDaysRemaining(t, today, { noTradeDays: settings.noTradeDays });
    if (left <= 0) {
      await d.ref.update({ status: "ended", daysRemaining: 0, endedOn: today });
      ended.add(t.uid);
    } else {
      await d.ref.update({ daysRemaining: left });
    }
  }
  for (const uid of ended) {
    const stillActive = await db.collection("timeouts").where("uid", "==", uid).where("status", "==", "active").limit(1).get();
    if (!stillActive.empty) continue;
    const mRef = db.collection("memberships").doc(membershipId(uid, "chamber"));
    await db.runTransaction(async (tx) => {
      const m = await tx.get(mRef);
      if (m.exists && m.data().state === "timeout") transition(tx, mRef, m.data(), "active", { actor: "system", service: "chamber", reason: "Timeout days ended" });
    });
    await notify(uid, { event: "timeout_ended", title: "Your timeout has ended", body: "You may trade today under your locked plan. Your SOD still comes first.", link: "/app/#chamber", urgent: false, email: false });
  }
  return { ended: ended.size };
});

/* ------------------------------------------------------------------ */
/* Weekly review booking: Thursday reminder, Friday 18:00 cut-off       */
/* ------------------------------------------------------------------ */

async function membersWithoutBooking(nextMonday) {
  const out = [];
  for (const m of await chamberMembers(BOOKABLE)) {
    const b = await db.collection("bookings").where("uid", "==", m.uid).where("service", "==", "chamber").where("weekKey", "==", nextMonday).where("status", "in", ["booked", "done"]).limit(1).get();
    if (b.empty) out.push(m);
  }
  return out;
}

const bookingReminder = job("bookingReminder", { every: "week", weekday: 4, at: "18:00" }, async () => {
  const nextMonday = E.addDays(E.weekMonday(U.todayKey()), 7);
  const list = await membersWithoutBooking(nextMonday);
  for (const m of list) {
    await notify(m.uid, { event: "review_reminder", title: "Book next week's review", body: "Pick a slot by Friday 18:00. One 20-minute review a week.", link: "/app/#chamber" });
  }
  return { reminded: list.length };
});

const bookingCutoff = job("bookingCutoff", { every: "week", weekday: 5, at: "18:00" }, async () => {
  const settings = await U.loadSettings();
  const nextMonday = E.addDays(E.weekMonday(U.todayKey()), 7);
  const slots = await db.collection("slots").where("service", "==", "chamber").where("weekKey", "==", nextMonday).limit(1).get();
  if (slots.empty) {
    // No slots published: members cannot be at fault.
    await U.alertAdmin("job_failure", `No review slots published for the week of ${nextMonday}. No booking timeouts issued.`);
    return { skipped: "no slots" };
  }
  const list = await membersWithoutBooking(nextMonday);
  for (const m of list) {
    await db.collection("memberships").doc(m.id).update({ noBookingFlag: nextMonday });
    if (settings.rules.autoNoBookingTimeout && m.paymentStatus === "paid") {
      await issueAutomatic(m.uid, { category: "no_review_booked", tradingDate: U.todayKey(), evidence: { detail: `No review booked for the week of ${nextMonday} by the Friday 18:00 cut-off` } });
    }
  }
  return { flagged: list.length };
});

/* ------------------------------------------------------------------ */
/* Sunday 18:00: weekly summary to all                                  */
/* ------------------------------------------------------------------ */

const weeklySummary = job("weeklySummary", { every: "week", weekday: 0, at: "18:00" }, async () => {
  const today = U.todayKey();
  const weekStart = E.weekMonday(today);
  let n = 0;
  for (const m of await chamberMembers(["active", "timeout", "plan_rewrite", "suspended"])) {
    await buildWeeklyReport(m.uid, weekStart, today, { kind: "summary" });
    await notify(m.uid, { event: "weekly_report", title: "Your week in the Chamber", body: "Your weekly summary is ready: clips, rulings and your clean-day streak.", link: "/app/#chamber" });
    n++;
  }
  return { sent: n };
});

/* ------------------------------------------------------------------ */
/* 02:30 daily: payments, invoices, unlocks, training, retention         */
/* ------------------------------------------------------------------ */

async function paymentCheck(settings, today) {
  const paid = await db.collection("memberships").where("paymentStatus", "==", "paid").get();
  for (const d of paid.docs) {
    const m = d.data();
    if (m.paidUntil && m.paidUntil < today) {
      await d.ref.update({ paymentStatus: "unpaid" });
      await audit({ actor: "system", action: "payment.lapsed", object: d.ref.path, subjectUid: m.uid, after: { paidUntil: m.paidUntil } });
      await notify(m.uid, { event: "payment_due", title: `${C.SERVICES[m.service]}: fee unpaid`, body: m.service === "chamber" ? "Booking is paused until the fee is paid. Your daily clips still apply." : "Sessions open again once the fee is paid.", link: "/app/#billing" });
    }
  }
  // Invoices go out a few days before each due date, with one reminder (P-11).
  const billable = await db.collection("memberships").where("service", "in", ["chamber", "build"]).where("state", "in", ["plan_review", "active", "timeout", "suspended", "plan_rewrite", "accepted"]).get();
  for (const d of billable.docs) {
    const m = d.data();
    if (m.exitRequested) continue;
    const nextDue = m.paidUntil ? E.addDays(m.paidUntil, 1) : null;
    if (nextDue && E.addDays(today, settings.fees.invoiceDaysBefore) >= nextDue) {
      const inv = await ensureInvoice(m.uid, m.service).catch(() => null);
      if (inv && !inv.notified) {
        await db.collection("invoices").doc(inv.id).update({ notified: true });
        await notify(m.uid, { event: "payment_due", title: "Invoice", body: `KES ${inv.amountKes} for ${C.SERVICES[m.service]}, due ${inv.dueOn}. Pay by M-Pesa in Billing, or Paybill ${C.params.MPESA_SHORTCODE.value()} with account ${inv.reference}.`, link: "/app/#billing" });
      }
    }
  }
  const unpaid = await db.collection("invoices").where("status", "in", ["unpaid", "failed"]).get();
  for (const d of unpaid.docs) {
    const inv = d.data();
    if ((inv.reminders || 0) < 1 && E.addDays(today, settings.fees.reminderDaysBefore) >= inv.dueOn) {
      await d.ref.update({ reminders: 1 });
      await notify(inv.uid, { event: "payment_due", title: "Payment reminder", body: `KES ${inv.amountKes} due ${inv.dueOn}. Reference ${inv.reference}.`, link: "/app/#billing" });
    }
  }
}

async function unlockOffers(settings, today) {
  const locked = await db.collection("plans").where("status", "==", "locked").get();
  for (const d of locked.docs) {
    const p = d.data();
    if (p.unlockOffered) continue;
    const obs = (await db.collection("obligations").where("uid", "==", p.uid).where("planId", "==", d.id).get()).docs.map((x) => x.data());
    const vs = (await db.collection("violations").where("uid", "==", p.uid).where("status", "==", "confirmed").get()).docs.map((x) => x.data());
    const clean = E.cleanStreak(obs.map((o) => ({ date: o.date, sodStatus: o.sodStatus, eodStatus: o.eodStatus })), vs, today, calOpts(settings, p));
    const reasons = E.unlockReasons({ lockedOn: p.lockedOn, today, cleanTradingDays: clean }, calOpts(settings, p), settings.rules);
    if (reasons.length) {
      await d.ref.update({ unlockOffered: reasons });
      await notify(p.uid, { event: "unlock_available", title: "Plan unlock available", body: reasons.includes("clean_month") ? "A clean month: you can ask to unlock your plan early." : "Your monthly checkpoint is here. You can ask to unlock your plan.", link: "/app/#chamber", urgent: false, email: false });
    }
  }
}

async function trainingSchedule(settings, today) {
  const tomorrow = E.addDays(today, 1);
  const wd = E.weekday(tomorrow);
  if (settings.noTradeDays.has(tomorrow)) return 0;
  let n = 0;
  const active = await db.collection("memberships").where("service", "==", "build").where("state", "==", "active").get();
  const buildCfg = (await db.collection("settings").doc("build").get()).data() || {};
  for (const d of active.docs) {
    const m = d.data();
    if (!m.trainerUid || !m.trainingHour) continue;
    if (settings.gates.buildNeedsPayment && (m.paymentStatus !== "paid" || (m.paidUntil && m.paidUntil < tomorrow))) continue;
    if (wd >= 1 && wd <= 4) {
      const ref = db.collection("trainingSessions").doc(`${m.uid}_${tomorrow}`);
      if ((await ref.get()).exists) continue;
      const trainer = (await db.collection("trainers").doc(m.trainerUid).get()).data() || {};
      await ref.set({
        uid: m.uid, participants: [m.uid], trainerUid: m.trainerUid, kind: "one_to_one",
        start: Timestamp.fromDate(E.zonedTime(tomorrow, m.trainingHour, C.TZ)), minutes: 45,
        date: tomorrow, meetLink: trainer.meetLink || null, status: "scheduled", createdAt: FieldValue.serverTimestamp(),
      });
      n++;
    } else if (wd === 5 && buildCfg.xSpaceLink) {
      // Friday: the weekly X Space, mandatory for trainees; attendance recorded.
      await db.collection("trainingSessions").doc(`${m.uid}_${tomorrow}_x`).set({
        uid: m.uid, participants: [m.uid], trainerUid: m.trainerUid, kind: "x_space",
        start: Timestamp.fromDate(E.zonedTime(tomorrow, buildCfg.xSpaceTime || "18:00", C.TZ)), minutes: 60,
        date: tomorrow, meetLink: buildCfg.xSpaceLink, status: "scheduled", createdAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
  // B-11: on Mondays, prompt trainers about a pattern of missed sessions. Never a penalty.
  if (E.weekday(today) === 1) {
    const lastWeek = E.addDays(today, -7);
    const sessions = await db.collection("trainingSessions").where("date", ">=", lastWeek).where("date", "<", today).get();
    const byTrainee = new Map();
    for (const s of sessions.docs) {
      const k = s.data().uid;
      if (!byTrainee.has(k)) byTrainee.set(k, []);
      byTrainee.get(k).push({ date: s.data().date, status: s.data().status === "absent" ? "missed" : s.data().status, trainerUid: s.data().trainerUid });
    }
    for (const [, list] of byTrainee) {
      const r = E.missedSessionPrompt(list, lastWeek, E.addDays(today, -1));
      if (r.prompt) await notify(list[0].trainerUid, { event: "missed_pattern", title: "A trainee missed several sessions", body: `${r.missed} missed last week. Your three steps: a word, a direct conversation, then a pause at the end of the paid period.`, link: `/staff/#training`, urgent: false, email: false });
    }
  }
  // B-10: exits with notice take effect after the paid period.
  const exiting = await db.collection("memberships").where("service", "==", "build").where("exitRequested", "==", true).get();
  for (const d of exiting.docs) {
    const m = d.data();
    if (m.state !== "exited" && (!m.paidUntil || m.paidUntil < today)) {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(d.ref);
        transition(tx, d.ref, s.data(), "exited", { actor: "system", service: "build", reason: `Exit with notice: ${m.exitReason || ""}` });
      });
    }
  }
  return n;
}

async function retention(settings) {
  const bucket = U.admin.storage().bucket();
  const cutoff = Timestamp.fromMillis(Date.now() - settings.retention.clipsDays * 86400000);
  const old = await db.collection("submissions").where("uploadedAt", "<", cutoff).limit(500).get();
  let removed = 0;
  for (const d of old.docs) {
    const s = d.data();
    if (!s.clipPath) continue;
    // Keep clips a ruling still depends on (open or disputed).
    const open = await db.collection("violations").where("evidence.submissionId", "==", d.id).where("status", "in", ["issued", "escalated"]).limit(1).get();
    if (!open.empty) continue;
    await bucket.file(s.clipPath).delete({ ignoreNotFound: true });
    await d.ref.update({ clipPath: null, clipDeleted: true, clipDeletedAt: FieldValue.serverTimestamp() });
    removed++;
  }
  const evCut = Timestamp.fromMillis(Date.now() - settings.retention.evidenceDays * 86400000);
  const ev = await db.collection("evidenceRequests").where("createdAt", "<", evCut).limit(200).get();
  for (const d of ev.docs) {
    if (d.data().keep) continue;
    for (const f of d.data().files || []) await bucket.file(f).delete({ ignoreNotFound: true });
    if ((d.data().files || []).length) await d.ref.update({ files: [], filesDeleted: true });
  }
  const nCut = Timestamp.fromMillis(Date.now() - settings.retention.notificationsDays * 86400000);
  const notes = await db.collection("notifications").where("createdAt", "<", nCut).limit(500).get();
  for (const d of notes.docs) await d.ref.delete();
  return removed;
}

const daily = job("daily", { every: "day", at: "02:30" }, async () => {
  const settings = await U.loadSettings(true);
  const today = U.todayKey();
  await paymentCheck(settings, today);
  await unlockOffers(settings, today);
  const sessions = await trainingSchedule(settings, today);
  const removed = await retention(settings);
  return { sessions, removed };
});

/* ------------------------------------------------------------------ */
/* Hourly health check (N-8, N-11)                                      */
/* ------------------------------------------------------------------ */

const healthCheck = job("healthCheck", { every: "minutes", minutes: 60 }, async () => {
  const since = Timestamp.fromMillis(Date.now() - 3600000);
  const events = await db.collection("system").doc("health").collection("events").where("sent", "==", false).limit(200).get();
  const counts = {};
  for (const d of events.docs) counts[d.data().kind] = (counts[d.data().kind] || 0) + 1;
  const uploadFailures = events.docs.filter((d) => d.data().kind === "upload_failure" && d.data().at && d.data().at >= since).length;
  if (uploadFailures >= 5) {
    const o = await db.collection("system").doc("outage").get();
    if (!o.exists || !o.data().active) {
      // Switched on automatically; an admin confirms or turns it off.
      await db.collection("system").doc("outage").set({ active: true, confirmed: false, since: FieldValue.serverTimestamp(), note: `${uploadFailures} upload failures in the last hour` }, { merge: true });
      await audit({ actor: "system", action: "outage.auto_on", object: "system/outage", reason: `${uploadFailures} upload failures in the last hour` });
    }
  }
  if (events.size) {
    const text = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ");
    await notifyAdmins(`Health check: ${text}. Details in the admin console.`);
    const batch = db.batch();
    for (const d of events.docs) batch.update(d.ref, { sent: true });
    await batch.commit();
  }
  return { events: events.size, uploadFailures };
});

module.exports = { createDailyObligations, quarterHourly, timeoutCountdown, bookingReminder, bookingCutoff, weeklySummary, daily, healthCheck, buildWeeklyReport };
