"use strict";
/**
 * HexhaEdge API server (Render web service).
 *
 *   GET  /health                 liveness check for Render
 *   POST /api/<action>           website actions; needs a Firebase ID token
 *   POST /hooks/pay-confirm      M-Pesa STK callback       (?t=<MPESA_CALLBACK_TOKEN>)
 *   POST /hooks/c2b-validate     M-Pesa C2B validation     (?t=...)
 *   POST /hooks/c2b-confirm      M-Pesa C2B confirmation   (?t=...)
 *   POST /internal/tick          runs due scheduled jobs   (Bearer <CRON_TOKEN>)
 *
 * Plain Node http: one dependency (firebase-admin), nothing to keep patched.
 */
const http = require("http");
const { URL } = require("url");
const registry = require("./index");
const U = require("./util");
const C = require("./config");
const { tick } = require("./cron");

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 256 * 1024;
const ORIGINS = String(process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

const STATUS = {
  "invalid-argument": 400, "failed-precondition": 400, "out-of-range": 400,
  unauthenticated: 401, "permission-denied": 403, "not-found": 404, "already-exists": 409,
  "resource-exhausted": 429, unavailable: 503, internal: 500,
};

/* ---------- small per-IP limiter for anything before a login is checked ---------- */
const hits = new Map();
function ipLimited(ip, max = 240, windowMs = 60000) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > windowMs) { hits.set(ip, { start: now, n: 1 }); return false; }
  h.n += 1;
  return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > 120000) hits.delete(k); }, 60000).unref();

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function baseHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Frame-Options", "DENY");
}

function cors(req, res) {
  const origin = String(req.headers.origin || "").replace(/\/$/, "");
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Firebase-AppCheck");
    res.setHeader("Access-Control-Max-Age", "600");
    return true;
  }
  return !origin; // server-to-server calls (Safaricom, cron) carry no Origin
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(new Error("Body must be JSON"), { status: 400, code: "invalid-argument" })); }
    });
    req.on("error", reject);
  });
}

/** Adapts Node's response to the small (req, res) shape the webhook handlers use. */
function hookRes(res) {
  return {
    statusCode: 200,
    status(n) { this.statusCode = n; return this; },
    json(o) { send(res, this.statusCode, o); },
    send(t) { res.writeHead(this.statusCode, { "Content-Type": "text/plain" }); res.end(String(t)); },
  };
}

async function handleApi(req, res, name) {
  const action = registry[name];
  if (!action || action.kind !== "callable") return send(res, 404, { error: { status: "not-found", message: "Unknown action" } });
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return send(res, 401, { error: { status: "unauthenticated", message: "Please log in again." } });
  let decoded;
  try {
    // checkRevoked: a role change or sign-out-everywhere takes effect at once.
    decoded = await U.admin.auth().verifyIdToken(m[1], true);
  } catch (e) {
    return send(res, 401, { error: { status: "unauthenticated", message: "Please log in again." } });
  }
  if (C.params.ENFORCE_APP_CHECK.value()) {
    const ac = String(req.headers["x-firebase-appcheck"] || "");
    try { await U.admin.appCheck().verifyToken(ac); } catch (e) {
      return send(res, 401, { error: { status: "unauthenticated", message: "This app could not be verified. Refresh and try again." } });
    }
  }
  const body = await readBody(req);
  try {
    const result = await action.run({ auth: { uid: decoded.uid, token: decoded }, data: body.data || {}, rawRequest: { ip: clientIp(req) } });
    return send(res, 200, { result: result === undefined ? null : result });
  } catch (e) {
    const code = e && e.httpsError ? e.code : "internal";
    const message = e && e.httpsError ? e.message : "Something went wrong on our side. Nothing was changed. Please try again.";
    if (!(e && e.httpsError)) U.logger.error("api error", { name, error: e && e.message });
    return send(res, STATUS[code] || 500, { error: { status: code, message } });
  }
}

const HOOKS = { "pay-confirm": "payConfirm", "c2b-validate": "payC2bValidate", "c2b-confirm": "payC2bConfirm" };

async function handleHook(req, res, path) {
  const hook = registry[HOOKS[path]];
  if (!hook) return send(res, 404, { error: "not found" });
  const url = new URL(req.url, "http://x");
  const body = await readBody(req);
  return hook.handler({ method: req.method, query: Object.fromEntries(url.searchParams), body, headers: req.headers }, hookRes(res));
}

const server = http.createServer(async (req, res) => {
  baseHeaders(res);
  const ip = clientIp(req);
  try {
    if (ipLimited(ip)) return send(res, 429, { error: { status: "resource-exhausted", message: "Too many requests. Please slow down." } });
    const allowed = cors(req, res);
    if (req.method === "OPTIONS") { res.writeHead(allowed ? 204 : 403); return res.end(); }
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) return send(res, 200, { ok: true, service: "hexhaedge-api" });
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" });

    if (parts[0] === "api" && parts.length === 2 && /^[A-Za-z0-9]+$/.test(parts[1])) {
      if (!allowed) return send(res, 403, { error: { status: "permission-denied", message: "Origin not allowed" } });
      return await handleApi(req, res, parts[1]);
    }
    if (parts[0] === "hooks" && parts.length === 2 && HOOKS[parts[1]]) return await handleHook(req, res, parts[1]);
    if (url.pathname === "/internal/tick") {
      const token = C.secretValue(C.secrets.CRON_TOKEN);
      const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
      const a = Buffer.from(given);
      const b = Buffer.from(token);
      if (!token || a.length !== b.length || !require("crypto").timingSafeEqual(a, b)) return send(res, 403, { error: "Forbidden" });
      const ran = await tick();
      return send(res, 200, { ok: true, ran });
    }
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    U.logger.error("request failed", { path: req.url && req.url.split("?")[0], error: e && e.message });
    if (!res.headersSent) send(res, e && e.status ? e.status : 500, { error: { status: (e && e.code) || "internal", message: e && e.status ? e.message : "Server error" } });
  }
});

server.requestTimeout = 120000;
server.headersTimeout = 30000;

if (require.main === module) {
  server.listen(PORT, () => U.logger.info("hexhaedge-api listening", { port: PORT, origins: ORIGINS }));
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

module.exports = { server };
