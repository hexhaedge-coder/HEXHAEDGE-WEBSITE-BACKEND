"use strict";
/**
 * Notifications (P-14, P-15 and the notification schedule).
 * Every message is written in-app first. Time-bound items also go by SMS or
 * WhatsApp; everything else by email, or the member's chosen channel.
 * Wording states the fact, the rule and the next step. No pressure words.
 */
const { db, FieldValue, logger, alertAdmin } = require("./util");
const C = require("./config");

const URGENT_EVENTS = new Set([
  "clip_due", "clip_late", "reviewer_question", "mismatch_flag", "timeout_issued",
  "suspension", "review_reminder", "payment_due", "payment_received", "evidence_requested",
  "resubmit_requested", "session_soon",
]);
const EMAIL_TOO = new Set(["timeout_issued", "suspension", "weekly_report", "invitation", "disqualified", "payment_received"]);

function appUrl(path = "/app/") {
  let base = "https://hexhaedge.pages.dev";
  try { base = C.params.APP_URL.value() || base; } catch (e) { /* default */ }
  return base.replace(/\/$/, "") + path;
}

/* ---------- Providers ---------- */

async function sendSms(to, text) {
  const key = C.secretValue(C.secrets.AT_API_KEY);
  if (!key) return { status: "skipped", reason: "SMS provider not configured" };
  const username = C.params.AT_USERNAME.value();
  const sandbox = username === "sandbox";
  const url = sandbox ? "https://api.sandbox.africastalking.com/version1/messaging" : "https://api.africastalking.com/version1/messaging";
  const body = new URLSearchParams({ username, to, message: text.slice(0, 459) });
  const from = C.params.AT_SENDER_ID.value();
  if (from) body.set("from", from);
  const res = await fetch(url, {
    method: "POST",
    headers: { apiKey: key, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  const recipient = json && json.SMSMessageData && json.SMSMessageData.Recipients && json.SMSMessageData.Recipients[0];
  const ok = res.ok && recipient && /success/i.test(recipient.status || "");
  return { status: ok ? "sent" : "failed", ref: recipient && recipient.messageId, detail: ok ? null : JSON.stringify(json).slice(0, 300) };
}

async function sendWhatsApp(to, text) {
  const token = C.secretValue(C.secrets.WHATSAPP_TOKEN);
  const phoneId = C.params.WHATSAPP_PHONE_ID.value();
  if (!token || !phoneId) return { status: "skipped", reason: "WhatsApp not configured" };
  // Business-started messages must use an approved template. "hx_notice" has one
  // body variable and is created in Meta Business Manager (see docs/SETUP.md).
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace("+", ""),
      type: "template",
      template: { name: "hx_notice", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 1000) }] }] },
    }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.ok ? "sent" : "failed", ref: json.messages && json.messages[0] && json.messages[0].id, detail: res.ok ? null : JSON.stringify(json).slice(0, 300) };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function sendEmail(to, subject, text, link) {
  const key = C.secretValue(C.secrets.RESEND_API_KEY);
  if (!key) return { status: "skipped", reason: "Email provider not configured" };
  const html = `<div style="font-family:Georgia,serif;color:#3b2a1e;max-width:560px;margin:auto;padding:24px;background:#f3ede1">
<p style="font-size:18px;font-weight:bold;margin:0 0 12px">${escapeHtml(subject)}</p>
<p style="font-size:15px;line-height:1.6;white-space:pre-line">${escapeHtml(text)}</p>
${link ? `<p><a href="${escapeHtml(link)}" style="color:#7d5410">Open HexhaEdge</a></p>` : ""}
<p style="font-size:12px;color:#7a6450">You get this because you have a HexhaEdge profile. Change channels in Settings.</p></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: C.params.EMAIL_FROM.value(), to: [to], subject, text: link ? `${text}\n\n${link}` : text, html }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.ok ? "sent" : "failed", ref: json.id, detail: res.ok ? null : JSON.stringify(json).slice(0, 300) };
}

/* ---------- Main entry ---------- */

/**
 * @param {string} uid
 * @param {{event:string, title:string, body:string, link?:string, urgent?:boolean, email?:boolean}} n
 */
async function notify(uid, n) {
  const urgent = n.urgent !== undefined ? n.urgent : URGENT_EVENTS.has(n.event);
  const alsoEmail = n.email !== undefined ? n.email : EMAIL_TOO.has(n.event);
  const link = n.link ? (n.link.startsWith("http") ? n.link : appUrl(n.link)) : appUrl();
  const ref = db.collection("notifications").doc();
  await ref.set({
    uid, event: n.event, title: n.title, body: n.body, link, urgent,
    read: false, createdAt: FieldValue.serverTimestamp(), deliveries: {},
  });

  const user = await db.collection("users").doc(uid).get();
  if (!user.exists) return ref.id;
  const u = user.data();
  const pref = u.contactChannel || "sms"; // sms | whatsapp | email
  const text = `${n.title}. ${n.body}`;
  const deliveries = {};

  const tryChannel = async (ch, fn) => {
    try {
      deliveries[ch] = { ...(await fn()), at: new Date().toISOString() };
    } catch (e) {
      deliveries[ch] = { status: "failed", detail: String(e.message || e).slice(0, 300), at: new Date().toISOString() };
    }
  };

  if (urgent && u.phone) {
    if (pref === "whatsapp") {
      await tryChannel("whatsapp", () => sendWhatsApp(u.phone, `${text} ${link}`));
      if (deliveries.whatsapp.status !== "sent") await tryChannel("sms", () => sendSms(u.phone, `${text} ${link}`));
    } else {
      await tryChannel("sms", () => sendSms(u.phone, `${text} ${link}`));
    }
  }
  if (!urgent && pref !== "email" && u.phone && !alsoEmail) {
    // Non-urgent items go by the member's chosen channel (P-15).
    if (pref === "whatsapp") await tryChannel("whatsapp", () => sendWhatsApp(u.phone, `${text} ${link}`));
    else if (pref === "sms") await tryChannel("sms", () => sendSms(u.phone, `${text} ${link}`));
  }
  if ((alsoEmail || (!urgent && pref === "email")) && u.email) {
    await tryChannel("email", () => sendEmail(u.email, n.title, n.body, link));
  }

  await ref.update({ deliveries });
  const failed = Object.entries(deliveries).filter(([, d]) => d.status === "failed");
  if (failed.length) {
    logger.warn("notification delivery failed", { uid, event: n.event, failed });
    await alertAdmin("message_failure", `${n.event} to ${uid}: ${failed.map(([c]) => c).join(", ")} failed`);
  }
  return ref.id;
}

async function notifyAdmins(text) {
  const out = {};
  const phone = C.params.ADMIN_ALERT_PHONE.value();
  const mail = C.params.ADMIN_ALERT_EMAIL.value();
  if (phone) out.sms = await sendSms(phone, `HexhaEdge alert: ${text}`).catch((e) => ({ status: "failed", detail: e.message }));
  if (mail) out.email = await sendEmail(mail, "HexhaEdge alert", text).catch((e) => ({ status: "failed", detail: e.message }));
  return out;
}

module.exports = { notify, notifyAdmins, sendSms, sendEmail, sendWhatsApp, appUrl };
