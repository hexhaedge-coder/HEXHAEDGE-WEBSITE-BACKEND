"use strict";
/**
 * Publish the Firestore and Storage security rules, create the Firestore
 * indexes and switch on the TTL clean-up, without installing the Firebase CLI.
 *
 * Run it from Render → hexhaedge-api → Shell (the Firebase key is already there):
 *
 *   node scripts/deploy-rules.js
 *
 * or on your own computer: node --env-file=.env scripts/deploy-rules.js
 * Safe to run again: anything that already exists is skipped.
 */
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const ROOT = path.join(__dirname, "..", "firebase");

function serviceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
    ? Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
    : process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set.");
  return JSON.parse(raw);
}

function fieldBody(f) {
  if (f.arrayConfig) return { fieldPath: f.fieldPath, arrayConfig: f.arrayConfig };
  return { fieldPath: f.fieldPath, order: f.order || "ASCENDING" };
}

async function main() {
  const sa = serviceAccount();
  const credential = admin.credential.cert(sa);
  const bucket = process.env.FIREBASE_STORAGE_BUCKET || `${sa.project_id}.firebasestorage.app`;
  admin.initializeApp({ credential, projectId: sa.project_id, storageBucket: bucket });
  const project = sa.project_id;
  console.log(`Project: ${project}`);

  // 1. Security rules: check both with Google's compiler first and print any problem with its line.
  const firestoreRules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
  const storageRules = fs.readFileSync(path.join(ROOT, "storage.rules"), "utf8");
  const { access_token: rulesToken } = await credential.getAccessToken();
  let bad = false;
  for (const [name, content] of [["firestore.rules", firestoreRules], ["storage.rules", storageRules]]) {
    const res = await fetch(`https://firebaserules.googleapis.com/v1/projects/${project}:test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${rulesToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ source: { files: [{ name, content }] } }),
    });
    const json = await res.json().catch(() => ({}));
    const issues = (json.issues || []).filter((i) => i.severity === "ERROR");
    if (!res.ok && !issues.length) console.log(`? Could not check ${name}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
    for (const i of issues) {
      bad = true;
      const pos = i.sourcePosition || {};
      const line = content.split("\n")[(pos.line || 1) - 1] || "";
      console.log(`✗ ${name} line ${pos.line}:${pos.column}  ${i.description}\n    ${line.trim()}`);
    }
    if (!issues.length && res.ok) console.log(`✓ ${name} compiles`);
  }
  if (bad) throw new Error("Rules did not compile. Nothing was published. Send the lines above to fix.");
  await admin.securityRules().releaseFirestoreRulesetFromSource(firestoreRules);
  console.log("✓ Firestore rules published");
  await admin.securityRules().releaseStorageRulesetFromSource(storageRules, bucket);
  console.log(`✓ Storage rules published (${bucket})`);

  // 2. Indexes and TTL, through the Firestore Admin REST API
  const { access_token: token } = await credential.getAccessToken();
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "firestore.indexes.json"), "utf8"));

  let made = 0;
  let had = 0;
  const failed = [];
  for (const ix of spec.indexes) {
    const res = await fetch(`${base}/${encodeURIComponent(ix.collectionGroup)}/indexes`, {
      method: "POST",
      headers,
      body: JSON.stringify({ queryScope: ix.queryScope || "COLLECTION", fields: ix.fields.map(fieldBody) }),
    });
    if (res.ok) made++;
    else if (res.status === 409) had++;
    else failed.push(`${ix.collectionGroup}(${ix.fields.map((f) => f.fieldPath).join(",")}): ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
  console.log(`✓ Indexes: ${made} started, ${had} already there${failed.length ? `, ${failed.length} failed` : ""}`);
  for (const f of failed) console.log(`  ✗ ${f}`);

  for (const o of spec.fieldOverrides || []) {
    if (!o.ttl) continue;
    const url = `${base}/${encodeURIComponent(o.collectionGroup)}/fields/${encodeURIComponent(o.fieldPath)}?updateMask=ttlConfig`;
    const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ ttlConfig: {} }) });
    console.log(res.ok ? `✓ TTL clean-up on ${o.collectionGroup}.${o.fieldPath}` : `✗ TTL on ${o.collectionGroup}.${o.fieldPath}: ${res.status} ${(await res.text()).slice(0, 160)}`);
  }

  console.log("\nIndexes take a few minutes to build. Check them in Firebase console → Firestore → Indexes.");
  console.log("Storage rules read Firestore to check uploads. If you have not yet, grant that once (see README, 'Storage rules permission').");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(`✗ ${e.message}`);
  if (/permission|403/i.test(e.message)) console.error("The Firebase key's account needs the roles shown in the README (Firebase Admin SDK Administrator Service Agent).");
  process.exit(1);
});
