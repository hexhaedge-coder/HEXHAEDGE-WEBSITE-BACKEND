"use strict";
/**
 * Configuration, read from environment variables. On Render, set them in the
 * service's Environment tab (or an Environment Group shared by the web service
 * and the cron job). Locally, copy .env.example to .env.
 *
 * Secrets are environment variables too, but are never committed and never
 * logged. Any provider whose key is empty or the word "unset" is switched off:
 * messages are still written in-app and logged, but not sent on that channel.
 */

// Firestore and Storage location (chosen when the Firebase project is created).
const REGION = process.env.FIREBASE_REGION || "africa-south1";
const TZ = "Africa/Nairobi";

const env = (name, fallback = "") => ({ name, value: () => (process.env[name] !== undefined && process.env[name] !== "" ? process.env[name] : fallback) });
const flag = (name, fallback) => ({ name, value: () => (process.env[name] === undefined || process.env[name] === "" ? fallback : process.env[name] === "true") });

const params = {
  APP_URL: env("APP_URL", "https://hexhaedge.pages.dev"),
  REQUIRE_STAFF_MFA: flag("REQUIRE_STAFF_MFA", true),
  ENFORCE_APP_CHECK: flag("ENFORCE_APP_CHECK", false),

  MPESA_ENV: env("MPESA_ENV", "sandbox"), // sandbox | production
  MPESA_SHORTCODE: env("MPESA_SHORTCODE", "174379"),
  MPESA_TILL_OR_PAYBILL: env("MPESA_TILL_OR_PAYBILL", "paybill"), // paybill | till
  MPESA_PARTY_B: env("MPESA_PARTY_B", ""),

  AT_USERNAME: env("AT_USERNAME", "sandbox"),
  AT_SENDER_ID: env("AT_SENDER_ID", ""),
  WHATSAPP_PHONE_ID: env("WHATSAPP_PHONE_ID", ""),
  EMAIL_FROM: env("EMAIL_FROM", "HexhaEdge <no-reply@example.com>"),
  CLOUDINARY_CLOUD_NAME: env("CLOUDINARY_CLOUD_NAME", ""),
  CLOUDINARY_API_KEY: env("CLOUDINARY_API_KEY", ""),
  ADMIN_ALERT_PHONE: env("ADMIN_ALERT_PHONE", ""),
  ADMIN_ALERT_EMAIL: env("ADMIN_ALERT_EMAIL", ""),
};

const secrets = {
  MPESA_CONSUMER_KEY: env("MPESA_CONSUMER_KEY"),
  MPESA_CONSUMER_SECRET: env("MPESA_CONSUMER_SECRET"),
  MPESA_PASSKEY: env("MPESA_PASSKEY"),
  MPESA_CALLBACK_TOKEN: env("MPESA_CALLBACK_TOKEN"),
  AT_API_KEY: env("AT_API_KEY"),
  WHATSAPP_TOKEN: env("WHATSAPP_TOKEN"),
  RESEND_API_KEY: env("RESEND_API_KEY"),
  CLOUDINARY_API_SECRET: env("CLOUDINARY_API_SECRET"),
  CRON_TOKEN: env("CRON_TOKEN"),
};

// Kept so module code reads the same as before; secrets are plain env vars on Render.
const MESSAGING_SECRETS = [];
const MPESA_SECRETS = [];

function secretValue(s) {
  const v = s.value();
  return v && v !== "unset" ? v : "";
}

const SERVICES = Object.freeze({
  build: "Build Your Edge",
  chamber: "Follow Your Edge",
  capital: "Execute Your Edge",
  mindspace: "Talk Your Edge",
});

const ROLES = Object.freeze(["admin", "reviewer", "trainer", "practitioner"]);

const CONSENT_PURPOSES = Object.freeze({
  terms: { label: "Terms of use", required: true },
  privacy: { label: "Privacy notice", required: true },
  clips: { label: "Recording and storage of my trading clips", service: "chamber" },
  sessions_ai: { label: "Recording of sessions and AI note-taking", service: "build" },
  share_chamber_mindspace: { label: "Sharing my record between the Chamber and MindSpace" },
  training_agreement: { label: "Training Agreement", service: "build" },
  risk_statement: { label: "Risk statement", service: "build" },
});

// Wording versions. Bump a version when the wording changes; members are asked again.
const DEFAULT_CONSENT_VERSIONS = Object.freeze({
  terms: "0.1",
  privacy: "0.1",
  clips: "0.1",
  sessions_ai: "0.1",
  share_chamber_mindspace: "0.1",
  training_agreement: "0.1",
  risk_statement: "0.1",
});

// P-8: gate rules are settings, not code.
const DEFAULT_GATES = Object.freeze({
  mindspaceFirst: { build: true, chamber: true, capital: false, mindspace: false },
  chamberNeedsPayment: true,
  buildNeedsPayment: true,
  chamberCapacity: 5,
});

// P-11 / B-9. Amounts are placeholders until confirmed (open item).
const DEFAULT_FEES = Object.freeze({
  chamberMonthlyKes: 7500,
  buildMonthlyUsd: 75,
  usdToKes: 129,
  invoiceDaysBefore: 3,
  reminderDaysBefore: 1,
  mindspaceSessionKes: 0,
});

const RETENTION_DEFAULTS = Object.freeze({
  clipsDays: 180,
  evidenceDays: 14,
  notificationsDays: 365,
});

module.exports = {
  REGION,
  TZ,
  params,
  secrets,
  secretValue,
  MESSAGING_SECRETS,
  MPESA_SECRETS,
  SERVICES,
  ROLES,
  CONSENT_PURPOSES,
  DEFAULT_CONSENT_VERSIONS,
  DEFAULT_GATES,
  DEFAULT_FEES,
  RETENTION_DEFAULTS,
};
