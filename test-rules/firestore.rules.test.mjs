// Security rules tests. They run against the Firebase emulator:
//   cd backend && npm install && npm run test:rules
// (needs the Firebase CLI and Java installed on your computer)
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, addDoc, collection, getDocs, query, where, serverTimestamp } from "firebase/firestore";

let env;
const MEMBER = { uid: "m1", token: { phone_number: "+254712345678" } };
const OTHER = { uid: "m2" };
const mfa = { firebase: { sign_in_second_factor: "phone" } };
const REVIEWER = { uid: "r1", token: { reviewer: true, ...mfa } };
const REVIEWER_NO_MFA = { uid: "r2", token: { reviewer: true } };
const ADMIN = { uid: "a1", token: { admin: true, ...mfa } };
const PRACT = { uid: "p1", token: { practitioner: true, ...mfa } };

const as = (who) => env.authenticatedContext(who.uid, who.token || {}).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "hexhaedge-rules-test",
    firestore: { rules: readFileSync(new URL("../firebase/firestore.rules", import.meta.url), "utf8") },
  });
});
after(async () => env && env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users/m1"), { name: "Amina", phone: "+254712345678", email: "a@x.co", timezone: "Africa/Nairobi", contactChannel: "sms", background: { instruments: [], years: 1, accounts: [] }, metMindspace: false });
    await setDoc(doc(db, "users/m2"), { name: "Brian", phone: "+254700000000", email: "b@x.co", timezone: "Africa/Nairobi", contactChannel: "sms", background: { instruments: [], years: 1, accounts: [] } });
    await setDoc(doc(db, "memberships/m1_chamber"), { uid: "m1", service: "chamber", state: "active" });
    await setDoc(doc(db, "violations/v1"), { uid: "m1", tier: "serious", status: "confirmed" });
    await setDoc(doc(db, "mindspaceNotes/n1"), { uid: "m1", practitionerUid: "p1", note: "private" });
    await setDoc(doc(db, "audit/x1"), { subjectUid: "m1", action: "violation.confirmed" });
    await setDoc(doc(db, "notifications/z1"), { uid: "m1", title: "t", body: "b", read: false });
    await setDoc(doc(db, "settings/rules"), { tierDays: { minor: 1, serious: 3, critical: 5 } });
  });
});

test("a member reads their own profile but not someone else's", async () => {
  await assertSucceeds(getDoc(doc(as(MEMBER), "users/m1")));
  await assertFails(getDoc(doc(as(MEMBER), "users/m2")));
});

test("a member can edit only safe profile fields", async () => {
  const db = as(MEMBER);
  await assertSucceeds(updateDoc(doc(db, "users/m1"), { name: "Amina W", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, "users/m1"), { phone: "+254799999999", updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, "users/m1"), { metMindspace: true, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, "users/m1"), { admin: true, updatedAt: serverTimestamp() }));
});

test("nobody can create a profile, membership, ruling or payment from the app", async () => {
  await assertFails(setDoc(doc(as(OTHER), "users/m2x"), { name: "x" }));
  await assertFails(setDoc(doc(as(MEMBER), "memberships/m1_build"), { uid: "m1", service: "build", state: "active" }));
  await assertFails(updateDoc(doc(as(MEMBER), "violations/v1"), { status: "reversed" }));
  await assertFails(setDoc(doc(as(MEMBER), "invoices/i1"), { uid: "m1", status: "paid" }));
  await assertFails(updateDoc(doc(as(ADMIN), "violations/v1"), { status: "reversed" }));
});

test("members see only their own rulings; reviewers need two-step login", async () => {
  await assertSucceeds(getDoc(doc(as(MEMBER), "violations/v1")));
  await assertFails(getDoc(doc(as(OTHER), "violations/v1")));
  await assertSucceeds(getDoc(doc(as(REVIEWER), "violations/v1")));
  await assertFails(getDoc(doc(as(REVIEWER_NO_MFA), "violations/v1")));
});

test("a member's list query must be limited to their own records", async () => {
  await assertSucceeds(getDocs(query(collection(as(MEMBER), "violations"), where("uid", "==", "m1"))));
  await assertFails(getDocs(collection(as(MEMBER), "violations")));
});

test("MindSpace notes: only the writing practitioner and the admin", async () => {
  await assertSucceeds(getDoc(doc(as(PRACT), "mindspaceNotes/n1")));
  await assertSucceeds(getDoc(doc(as(ADMIN), "mindspaceNotes/n1")));
  await assertFails(getDoc(doc(as(MEMBER), "mindspaceNotes/n1")));
  await assertFails(getDoc(doc(as(REVIEWER), "mindspaceNotes/n1")));
});

test("audit log: members read their own entries; nobody writes", async () => {
  await assertSucceeds(getDoc(doc(as(MEMBER), "audit/x1")));
  await assertFails(getDoc(doc(as(OTHER), "audit/x1")));
  await assertFails(setDoc(doc(as(ADMIN), "audit/x2"), { action: "fake" }));
  await assertFails(updateDoc(doc(as(ADMIN), "audit/x1"), { action: "edited" }));
});

test("notifications: a member may only mark their own as read", async () => {
  await assertSucceeds(updateDoc(doc(as(MEMBER), "notifications/z1"), { read: true }));
  await assertFails(updateDoc(doc(as(MEMBER), "notifications/z1"), { title: "changed" }));
  await assertFails(updateDoc(doc(as(OTHER), "notifications/z1"), { read: true }));
});

test("messages: a member writes only in their own thread, as themselves", async () => {
  const db = as(MEMBER);
  await assertSucceeds(addDoc(collection(db, "threads/m1/messages"), { from: "m1", text: "hello", at: serverTimestamp(), byStaff: false }));
  await assertFails(addDoc(collection(db, "threads/m2/messages"), { from: "m1", text: "hello", at: serverTimestamp(), byStaff: false }));
  await assertFails(addDoc(collection(db, "threads/m1/messages"), { from: "m1", text: "x", at: serverTimestamp(), byStaff: true }));
  await assertFails(addDoc(collection(db, "threads/m1/messages"), { from: "m2", text: "x", at: serverTimestamp(), byStaff: false }));
});

test("settings are readable by members and writable by nobody from the app", async () => {
  await assertSucceeds(getDoc(doc(as(MEMBER), "settings/rules")));
  await assertFails(setDoc(doc(as(ADMIN), "settings/rules"), { tierDays: { minor: 0 } }));
});

test("signed-out visitors can read nothing", async () => {
  const anon = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anon, "settings/rules")));
  await assertFails(getDoc(doc(anon, "users/m1")));
});
