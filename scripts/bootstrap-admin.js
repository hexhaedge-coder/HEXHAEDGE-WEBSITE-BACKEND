"use strict";
/**
 * Make the first admin. Run once, from your own computer, with a service
 * account key that you keep OUT of this repository:
 *
 *   node --env-file=.env scripts/bootstrap-admin.js owner@example.com
 *   (uses FIREBASE_SERVICE_ACCOUNT_BASE64 from .env, or GOOGLE_APPLICATION_CREDENTIALS)
 *
 * The person must already have signed up (or exist in Firebase Auth) and must
 * enrol a second factor (SMS) before staff screens will open for them.
 * After this, give every other role from the admin console.
 */
const admin = require("firebase-admin");

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node scripts/bootstrap-admin.js <email>");
    process.exit(1);
  }
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8") : process.env.FIREBASE_SERVICE_ACCOUNT;
  admin.initializeApp(raw ? { credential: admin.credential.cert(JSON.parse(raw)) } : {});
  const user = await admin.auth().getUserByEmail(email);
  const claims = { ...(user.customClaims || {}), admin: true };
  await admin.auth().setCustomUserClaims(user.uid, claims);
  await admin.auth().revokeRefreshTokens(user.uid);
  const db = admin.firestore();
  await db.collection("staff").doc(user.uid).set({ roles: ["admin"], email: user.email, name: user.displayName || null, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await db.collection("audit").add({ actor: "bootstrap", action: "roles.set", object: `users/${user.uid}`, after: { roles: ["admin"] }, reason: "First admin", subjectUid: user.uid, at: admin.firestore.FieldValue.serverTimestamp() });
  console.log(`${email} is now admin. They must log out and back in, and enrol two-step login.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
