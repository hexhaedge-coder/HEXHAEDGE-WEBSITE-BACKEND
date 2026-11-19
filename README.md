# HexhaEdge API (backend)

The server side of the HexhaEdge platform. It runs on **Render** and keeps its data in **Firebase**
(Firestore, Authentication, Storage). The website lives in
[HEXHAEDGE-LANDINGPAGE-WEBSITE](https://github.com/hexhaedge-coder/HEXHAEDGE-LANDINGPAGE-WEBSITE) on Cloudflare Pages.

```
Website (Cloudflare Pages) ──login──▶ Firebase Auth
        │  POST /api/<action> + ID token
        ▼
hexhaedge-api (Render web service) ──▶ Firestore, Storage (Firebase Admin)
        ▲                          ──▶ M-Pesa, SMS, WhatsApp, email, Cloudinary
        │  /hooks/... callbacks
     Safaricom
hexhaedge-jobs (Render cron, every 5 min) ──▶ reminders, counting, invoices, retention
```

## What's here

```
src/engine.js      The Chamber rules engine: pure, deterministic, unit-tested
src/server.js      HTTP API: /health, /api/<action>, /hooks/<m-pesa>, /internal/tick
src/cron.js        Scheduled jobs runner (Nairobi time, once per period, catches up)
src/*.js           Profiles and consent, Chamber, bookings, payments, training, admin, media, jobs
firebase/          Firestore and Storage security rules and indexes (deployed with the Firebase CLI)
test/              Engine and scheduler tests (npm test, no install needed)
test-rules/        Security-rules tests against the Firebase emulator
render.yaml        Render Blueprint: API + cron job + shared settings
```

## Setup

### 1. Firebase
1. Create the project on the **Blaze** plan (no-cost allowances still apply) with Firestore and Storage in
   **europe-west1** (Belgium; this project already uses it, and the location cannot be changed). Enable **Phone** and **Email/Password** sign-in, upgrade to **Identity Platform** and turn
   on **SMS multi-factor** (staff need it). Add the website domain to Authorized domains.
2. Deploy the rules: `npm install -g firebase-tools && firebase login`, copy `firebase/.firebaserc.example` to
   `firebase/.firebaserc` with your project id, then `npm run deploy:rules`.
3. Project settings → Service accounts → **Generate new private key**. Keep the file off GitHub. Base64 it on one
   line (`base64 -w0 key.json`, or on Windows `[Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json"))`).
4. Signed clip links: in Google Cloud → IAM, the service account needs **Service Account Token Creator**.

### 2. Render
1. Render → **New → Blueprint** → choose this repository. It creates `hexhaedge-api` and `hexhaedge-jobs` in Frankfurt.
2. Fill in the **hexhaedge-shared** environment group (all names are in `.env.example`):
   `FIREBASE_SERVICE_ACCOUNT_BASE64`, `FIREBASE_STORAGE_BUCKET`, `APP_URL` (website), `PUBLIC_API_URL`
   (the API's own onrender.com address), `ALLOWED_ORIGINS` (the website address), and providers as you get them.
3. Check `https://<your-api>.onrender.com/health` returns `{"ok":true}`.
4. Put the API address in the website's `public/assets/js/firebase-config.js` (`apiBase`).

**Plans.** The Blueprint uses paid **Starter** instances. Free Render web services sleep after 15 minutes
without traffic and take about a minute to wake, which members would feel and M-Pesa callbacks could miss.
Cron jobs are billed per minute while running, with a small monthly minimum. Check render.com/pricing.
If you want no cron service, delete it and let any scheduler call `POST /internal/tick` every 5 minutes with
`Authorization: Bearer <CRON_TOKEN>`.

### 3. First admin
`cp .env.example .env`, fill in the Firebase lines, then
`npm install && node --env-file=.env scripts/bootstrap-admin.js you@example.com`.
Log in on the website with email and password; the staff page asks you to turn on two-step login.

### 4. Providers
- **M-Pesa:** Daraja app (sandbox works at once). Production needs a Safaricom-issued Paybill or Till and go-live
  approval. Then press *Register Paybill confirmation URLs* in the admin Payments screen.
- **SMS:** Africa's Talking username, API key, optional sender ID.
- **WhatsApp:** template `hx_notice` (Utility, one body variable), phone number id and token.
- **Email:** Resend key and a verified sending domain.
- **Cloudinary:** cloud name, API key and API secret (profile photos only; clips stay in private Firebase Storage).

## API contract

`POST /api/<action>` with `Authorization: Bearer <Firebase ID token>` and body `{"data": {...}}`.
Success: `200 {"result": ...}`. Failure: `4xx/5xx {"error": {"status": "<code>", "message": "<plain words>"}}`.
Every action checks the login, role, two-step login for staff, a per-user rate limit and its input, and writes
the audit log. Actions are listed in `src/index.js`.

## Checks

```
npm test            # 19 tests: rules engine and scheduler timing
npm run test:rules  # security rules (needs Firebase CLI + Java + npm install)
```

## Security notes

Only server code writes rulings, payments, roles and settings (see `firebase/firestore.rules`). Secrets are
environment variables on Render, never in Git. Logs are one JSON line each and never include tokens or keys.
Webhooks check a secret token in constant time, and an STK "paid" callback is confirmed with an STK query
before anything is marked paid.
