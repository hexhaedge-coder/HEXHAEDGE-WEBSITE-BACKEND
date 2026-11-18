"use strict";
/**
 * M-Pesa payments (P-9 to P-13, A-6).
 * STK Push (M-Pesa Express) with a callback, confirmed again with an STK query
 * before anything is marked paid. Manual Paybill/Till payments arrive by the
 * C2B confirmation and are matched by the invoice reference.
 *
 * Webhook paths avoid the word "mpesa": Daraja is reported to reject callback
 * URLs that contain it. server.js mounts them under /hooks/.
 */

/** A webhook handler: (req, res) with req.query, req.body and res.status().json(). */
function onRequest(_opts, handler) {
  return { kind: "http", handler };
}
const crypto = require("crypto");
const E = require("./engine");
const U = require("./util");
const C = require("./config");
const { notify } = require("./notify");
const { activateIfReady } = require("./chamber");
const { transition } = require("./states");

const { db, FieldValue, fail, oneOf, id, audit, callable, membershipId, logger } = U;

function base() {
  return C.params.MPESA_ENV.value() === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke";
}

function stamp() {
  // YYYYMMDDHHmmss in Nairobi time
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: C.TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}${g("month")}${g("day")}${g("hour")}${g("minute")}${g("second")}`;
}

async function darajaToken() {
  const key = C.secretValue(C.secrets.MPESA_CONSUMER_KEY);
  const secret = C.secretValue(C.secrets.MPESA_CONSUMER_SECRET);
  if (!key || !secret) fail("failed-precondition", "M-Pesa is not set up yet. Please try again later.");
  const res = await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: "Basic " + Buffer.from(`${key}:${secret}`).toString("base64") },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Daraja token failed: ${res.status}`);
  return json.access_token;
}

function stkPassword(ts) {
  const shortcode = C.params.MPESA_SHORTCODE.value();
  return Buffer.from(shortcode + C.secretValue(C.secrets.MPESA_PASSKEY) + ts).toString("base64");
}

function callbackUrl(fn) {
  const tokenValue = C.secretValue(C.secrets.MPESA_CALLBACK_TOKEN);
  const urlBase = process.env.PUBLIC_API_URL; // e.g. https://hexhaedge-api.onrender.com
  if (!urlBase) throw new Error("PUBLIC_API_URL is not set");
  const path = { payConfirm: "pay-confirm", payC2bConfirm: "c2b-confirm", payC2bValidate: "c2b-validate" }[fn];
  return `${urlBase.replace(/\/$/, "")}/hooks/${path}?t=${encodeURIComponent(tokenValue)}`;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function invoiceRef() {
  // Short reference members can type at a Paybill: HX + 6 characters, no look-alikes.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "HX";
  for (const b of crypto.randomBytes(6)) s += chars[b % chars.length];
  return s;
}

/* ------------------------------------------------------------------ */
/* Invoices                                                             */
/* ------------------------------------------------------------------ */

/** Monthly fee for a service, in KES. Build is USD 75 at the admin's rate (B-9). */
function feeKes(service, settings, membership) {
  if (service === "chamber") return settings.fees.chamberMonthlyKes;
  if (service === "build") {
    const usd = membership && membership.joinedFeeUsd ? membership.joinedFeeUsd : settings.fees.buildMonthlyUsd;
    return Math.round(usd * settings.fees.usdToKes);
  }
  return 0;
}

/**
 * The invoice for the member's next unpaid period, created if missing.
 * Periods roll from the paid-until date (or today). Build may split into two instalments.
 */
async function ensureInvoice(uid, service) {
  const settings = await U.loadSettings();
  const mRef = db.collection("memberships").doc(membershipId(uid, service));
  const m = await mRef.get();
  if (!m.exists) fail("failed-precondition", "You are not in this service.");
  const md = m.data();
  const open = await db.collection("invoices").where("uid", "==", uid).where("service", "==", service).where("status", "in", ["unpaid", "pending", "failed"]).limit(1).get();
  if (!open.empty) return { id: open.docs[0].id, ...open.docs[0].data() };

  const today = U.todayKey();
  const start = md.paidUntil && md.paidUntil >= today ? E.addDays(md.paidUntil, 1) : today;
  const [y, mo, d] = start.split("-").map(Number);
  const endDate = new Date(Date.UTC(y, mo, d - 1)); // one calendar month later, minus a day
  const periodEnd = endDate.toISOString().slice(0, 10);
  const total = feeKes(service, settings, md);
  if (!total) fail("failed-precondition", "There is no fee for this service.");
  const instalments = service === "build" && md.instalments === true;
  const mid = E.addDays(start, 14);
  const parts = instalments
    ? [{ amount: Math.ceil(total / 2), dueOn: start, coversUntil: mid, part: 1 }, { amount: Math.floor(total / 2), dueOn: E.addDays(mid, 1), coversUntil: periodEnd, part: 2 }]
    : [{ amount: total, dueOn: start, coversUntil: periodEnd, part: 0 }];
  let first = null;
  for (const p of parts) {
    const ref = db.collection("invoices").doc();
    const data = {
      uid, service, reference: invoiceRef(), amountKes: p.amount, currency: "KES", periodStart: start, periodEnd,
      dueOn: p.dueOn, coversUntil: p.coversUntil, instalment: p.part, status: "unpaid", reminders: 0,
      createdAt: FieldValue.serverTimestamp(),
    };
    await ref.set(data);
    if (!first) first = { id: ref.id, ...data };
  }
  await audit({ actor: "system", action: "invoice.created", object: `invoices/${first.id}`, subjectUid: uid, after: { service, amount: total, start, periodEnd, instalments } });
  return first;
}

const getInvoice = callable("getInvoice", async ({ uid, data }) => {
  const service = oneOf(data.service, ["chamber", "build"], "Service");
  const inv = await ensureInvoice(uid, service);
  return { id: inv.id, reference: inv.reference, amountKes: inv.amountKes, dueOn: inv.dueOn, status: inv.status, paybill: C.params.MPESA_SHORTCODE.value(), type: C.params.MPESA_TILL_OR_PAYBILL.value() };
}, { limit: [20, 3600] });

/* ------------------------------------------------------------------ */
/* STK Push                                                             */
/* ------------------------------------------------------------------ */

const startPayment = callable("startPayment", async ({ uid, data }) => {
  const invRef = db.collection("invoices").doc(id(data.invoiceId, "Invoice"));
  const inv = (await U.mustGet(invRef, "Invoice")).data();
  if (inv.uid !== uid) fail("permission-denied", "Not your invoice.");
  if (inv.status === "paid") fail("failed-precondition", "This invoice is already paid.");
  const user = (await db.collection("users").doc(uid).get()).data();
  const phone = U.kenyanPhone(data.phone || user.phone).replace("+", "");
  const ts = stamp();
  const till = C.params.MPESA_TILL_OR_PAYBILL.value() === "till";
  const body = {
    BusinessShortCode: C.params.MPESA_SHORTCODE.value(),
    Password: stkPassword(ts),
    Timestamp: ts,
    TransactionType: till ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
    Amount: Math.round(inv.amountKes),
    PartyA: phone,
    PartyB: C.params.MPESA_PARTY_B.value() || C.params.MPESA_SHORTCODE.value(),
    PhoneNumber: phone,
    CallBackURL: callbackUrl("payConfirm"),
    AccountReference: inv.reference.slice(0, 12),
    TransactionDesc: "HexhaEdge fee",
  };
  const token = await darajaToken();
  const res = await fetch(`${base()}/mpesa/stkpush/v1/processrequest`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ResponseCode !== "0") {
    logger.warn("STK push refused", { status: res.status, json });
    await U.alertAdmin("payment_failure", `STK push refused for ${uid}: ${json.errorMessage || json.ResponseDescription || res.status}`);
    fail("unavailable", "M-Pesa did not accept the request. Please check the number and try again.");
  }
  const pRef = db.collection("payments").doc();
  await pRef.set({
    uid, invoiceId: invRef.id, service: inv.service, amountKes: inv.amountKes, phoneLast3: phone.slice(-3), source: "stk",
    checkoutRequestId: json.CheckoutRequestID, merchantRequestId: json.MerchantRequestID, status: "pending",
    createdAt: FieldValue.serverTimestamp(),
  });
  await invRef.update({ status: "pending", lastPaymentId: pRef.id });
  return { ok: true, paymentId: pRef.id, message: "Check your phone and enter your M-Pesa PIN." };
}, { secrets: C.MPESA_SECRETS, limit: [6, 600] });

async function stkQuery(checkoutRequestId) {
  const ts = stamp();
  const token = await darajaToken();
  const res = await fetch(`${base()}/mpesa/stkpushquery/v1/query`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ BusinessShortCode: C.params.MPESA_SHORTCODE.value(), Password: stkPassword(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId }),
  });
  return res.json().catch(() => ({}));
}

/** Marks an invoice paid and opens what payment unlocks. One place for every route. */
async function markPaid(invoiceId, { actor, receipt, source, reason, paymentId }) {
  const invRef = db.collection("invoices").doc(invoiceId);
  let inv;
  await db.runTransaction(async (tx) => {
    const s = await tx.get(invRef);
    if (!s.exists) fail("not-found", "Invoice not found");
    inv = s.data();
    if (inv.status === "paid") return;
    const mRef = db.collection("memberships").doc(membershipId(inv.uid, inv.service));
    const m = await tx.get(mRef);
    tx.update(invRef, { status: "paid", paidAt: FieldValue.serverTimestamp(), receipt: receipt || null, paidVia: source, paymentId: paymentId || null });
    if (m.exists) {
      const md = m.data();
      const paidUntil = !md.paidUntil || inv.coversUntil > md.paidUntil ? inv.coversUntil : md.paidUntil;
      const extra = { paymentStatus: "paid", paidUntil, updatedAt: FieldValue.serverTimestamp() };
      if (inv.service === "build" && !md.joinedFeeUsd) {
        const settings = await U.loadSettings();
        extra.joinedFeeUsd = settings.fees.buildMonthlyUsd;
      }
      tx.update(mRef, extra);
      if (inv.service === "build" && md.state === "accepted") {
        transition(tx, mRef, { ...md, uid: inv.uid }, "active", { actor, service: "build", reason: "First payment received" });
      }
    }
    audit({ actor, action: source === "manual" ? "payment.manual" : "payment.received", object: invRef.path, subjectUid: inv.uid, after: { amount: inv.amountKes, receipt: receipt || null, source }, reason: reason || null }, tx);
  });
  if (inv.service === "chamber") await activateIfReady(inv.uid, actor);
  await notify(inv.uid, { event: "payment_received", title: "Payment received", body: `KES ${inv.amountKes} for ${C.SERVICES[inv.service]}${receipt ? `, receipt ${receipt}` : ""}. Thank you.`, link: "/app/#billing" });
}

/** Safaricom calls this after the member enters their PIN (or cancels). */
const payConfirm = onRequest({ secrets: [...C.MPESA_SECRETS, ...C.MESSAGING_SECRETS], cors: false, maxInstances: 5 }, async (req, res) => {
  const ack = () => res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  try {
    if (req.method !== "POST" || !safeEqual(req.query.t, C.secretValue(C.secrets.MPESA_CALLBACK_TOKEN))) {
      res.status(403).send("Forbidden");
      return;
    }
    const cb = req.body && req.body.Body && req.body.Body.stkCallback;
    if (!cb || !cb.CheckoutRequestID) return ack();
    const q = await db.collection("payments").where("checkoutRequestId", "==", String(cb.CheckoutRequestID)).limit(1).get();
    if (q.empty) {
      await U.alertAdmin("payment_failure", `Callback for unknown checkout ${cb.CheckoutRequestID}`);
      return ack();
    }
    const pRef = q.docs[0].ref;
    const p = q.docs[0].data();
    if (p.status !== "pending") return ack(); // already handled: callbacks can repeat
    const code = Number(cb.ResultCode);
    if (code !== 0) {
      const status = code === 1037 ? "expired" : "failed";
      await pRef.update({ status, resultCode: code, resultDesc: String(cb.ResultDesc || "").slice(0, 200), updatedAt: FieldValue.serverTimestamp() });
      await db.collection("invoices").doc(p.invoiceId).update({ status: "failed" });
      await audit({ actor: "safaricom", action: `payment.${status}`, object: pRef.path, subjectUid: p.uid, after: { code } });
      await notify(p.uid, { event: "payment_failed", title: "Payment not completed", body: code === 1032 ? "The M-Pesa request was cancelled. You can try again from Billing." : "M-Pesa did not complete the payment. You can try again from Billing.", link: "/app/#billing" });
      return ack();
    }
    // Do not trust the callback alone: ask Safaricom again.
    const check = await stkQuery(p.checkoutRequestId);
    if (String(check.ResultCode) !== "0") {
      await pRef.update({ status: "needs_check", updatedAt: FieldValue.serverTimestamp(), queryResult: JSON.stringify(check).slice(0, 300) });
      await U.alertAdmin("payment_failure", `Callback said paid but query disagreed for ${pRef.id}`);
      return ack();
    }
    const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
    const val = (n) => (items.find((i) => i.Name === n) || {}).Value;
    const amount = Number(val("Amount"));
    const receipt = String(val("MpesaReceiptNumber") || "");
    if (amount + 0.001 < p.amountKes) {
      await pRef.update({ status: "short", receipt, amountPaid: amount });
      await U.alertAdmin("payment_failure", `Short payment ${receipt}: ${amount} of ${p.amountKes}`);
      return ack();
    }
    await pRef.update({ status: "paid", receipt, amountPaid: amount, updatedAt: FieldValue.serverTimestamp() });
    await markPaid(p.invoiceId, { actor: "safaricom", receipt, source: "stk", paymentId: pRef.id });
    return ack();
  } catch (e) {
    logger.error("payConfirm failed", { error: e.message });
    await U.alertAdmin("payment_failure", `payConfirm error: ${e.message}`).catch(() => undefined);
    return ack();
  }
});

/* ------------------------------------------------------------------ */
/* C2B: manual Paybill / Till payments                                  */
/* ------------------------------------------------------------------ */

const payC2bValidate = onRequest({ secrets: C.MPESA_SECRETS, maxInstances: 5 }, async (req, res) => {
  if (!safeEqual(req.query.t, C.secretValue(C.secrets.MPESA_CALLBACK_TOKEN))) { res.status(403).send("Forbidden"); return; }
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
});

const payC2bConfirm = onRequest({ secrets: [...C.MPESA_SECRETS, ...C.MESSAGING_SECRETS], maxInstances: 5 }, async (req, res) => {
  const ack = () => res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });
  try {
    if (!safeEqual(req.query.t, C.secretValue(C.secrets.MPESA_CALLBACK_TOKEN))) { res.status(403).send("Forbidden"); return; }
    const b = req.body || {};
    const transId = String(b.TransID || "").slice(0, 40);
    if (!transId) return ack();
    const ref = db.collection("payments").doc(`c2b_${transId}`);
    const exists = await ref.get();
    if (exists.exists) return ack();
    const billRef = String(b.BillRefNumber || "").trim().toUpperCase().slice(0, 20);
    const amount = Number(b.TransAmount || 0);
    const inv = billRef ? await db.collection("invoices").where("reference", "==", billRef).limit(1).get() : { empty: true };
    const matched = !inv.empty && inv.docs[0].data().status !== "paid" && amount + 0.001 >= inv.docs[0].data().amountKes;
    await ref.set({
      source: "c2b", receipt: transId, amountPaid: amount, billRef, uid: matched ? inv.docs[0].data().uid : null,
      invoiceId: matched ? inv.docs[0].id : null, status: matched ? "paid" : "unmatched", createdAt: FieldValue.serverTimestamp(),
    });
    if (matched) await markPaid(inv.docs[0].id, { actor: "safaricom", receipt: transId, source: "c2b", paymentId: ref.id });
    else await U.alertAdmin("payment_unmatched", `Unmatched payment ${transId}: KES ${amount}, reference "${billRef}"`);
    return ack();
  } catch (e) {
    logger.error("payC2bConfirm failed", { error: e.message });
    return ack();
  }
});

const registerC2bUrls = callable("registerC2bUrls", async ({ uid }) => {
  const token = await darajaToken();
  const res = await fetch(`${base()}/mpesa/c2b/v1/registerurl`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ShortCode: C.params.MPESA_SHORTCODE.value(), ResponseType: "Completed", ConfirmationURL: callbackUrl("payC2bConfirm"), ValidationURL: callbackUrl("payC2bValidate") }),
  });
  const json = await res.json().catch(() => ({}));
  await audit({ actor: uid, action: "payments.c2b_registered", object: "settings/payments", after: { status: res.status } });
  if (!res.ok) fail("unavailable", `Safaricom said: ${json.errorMessage || res.status}`);
  return { ok: true };
}, { allow: ["admin"], secrets: C.MPESA_SECRETS });

/* ------------------------------------------------------------------ */
/* Admin: manual confirmation and matching (P-12, A-6)                  */
/* ------------------------------------------------------------------ */

const markPaidManually = callable("markPaidManually", async ({ uid, data }) => {
  const invoiceId = id(data.invoiceId, "Invoice");
  const why = U.reason(data.reason);
  const receipt = U.optStr(data.reference, { max: 40 });
  await markPaid(invoiceId, { actor: uid, receipt, source: "manual", reason: why });
  return { ok: true };
}, { allow: ["admin"] });

const matchPayment = callable("matchPayment", async ({ uid, data }) => {
  const pRef = db.collection("payments").doc(id(data.paymentId, "Payment"));
  const invoiceId = id(data.invoiceId, "Invoice");
  const why = U.reason(data.reason);
  const p = (await U.mustGet(pRef, "Payment")).data();
  if (p.status !== "unmatched") fail("failed-precondition", "Only an unmatched payment can be matched.");
  const inv = (await U.mustGet(db.collection("invoices").doc(invoiceId), "Invoice")).data();
  await pRef.update({ status: "paid", invoiceId, uid: inv.uid, matchedBy: uid });
  await markPaid(invoiceId, { actor: uid, receipt: p.receipt, source: "c2b_matched", reason: why, paymentId: pRef.id });
  return { ok: true };
}, { allow: ["admin"] });

/** Build: the member chooses two instalments a month (B-9). */
const setInstalments = callable("setInstalments", async ({ uid, data }) => {
  const on = data.on === true;
  const ref = db.collection("memberships").doc(membershipId(uid, "build"));
  await U.mustGet(ref, "Membership");
  await ref.update({ instalments: on });
  await audit({ actor: uid, action: "billing.instalments", object: ref.path, subjectUid: uid, after: { on } });
  return { ok: true };
}, { limit: [10, 3600] });

module.exports = { getInvoice, startPayment, payConfirm, payC2bValidate, payC2bConfirm, registerC2bUrls, markPaidManually, matchPayment, setInstalments, ensureInvoice, feeKes };
