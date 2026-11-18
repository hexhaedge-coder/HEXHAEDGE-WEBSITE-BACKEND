"use strict";
/**
 * Cloudinary is used for profile images only. Trading clips and dashboard
 * evidence are personal records and stay in private Firebase Storage, served
 * by short-lived signed links (N-3, N-4).
 *
 * Uploads are signed by the server, so nobody can push files into the
 * Cloudinary account without a profile, and each person can only write their
 * own image.
 */
const crypto = require("crypto");
const U = require("./util");
const C = require("./config");

const { db, FieldValue, fail, callable } = U;

function cloud() {
  const name = C.params.CLOUDINARY_CLOUD_NAME.value();
  const key = C.params.CLOUDINARY_API_KEY.value();
  const secret = C.secretValue(C.secrets.CLOUDINARY_API_SECRET);
  if (!name || !key || !secret) fail("failed-precondition", "Image upload is not set up yet.");
  return { name, key, secret };
}

/** Cloudinary signature: sha1 of the sorted params joined with &, plus the secret. */
function sign(params, secret) {
  const str = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return crypto.createHash("sha1").update(str + secret).digest("hex");
}

const avatarSignature = callable("avatarSignature", async ({ uid }) => {
  const c = cloud();
  const params = {
    timestamp: Math.floor(Date.now() / 1000),
    folder: "hexhaedge/avatars",
    public_id: uid,
    overwrite: "true",
    invalidate: "true",
    allowed_formats: "jpg,jpeg,png,webp",
    transformation: "c_fill,g_face,w_320,h_320",
  };
  return { ...params, signature: sign(params, c.secret), api_key: c.key, cloud_name: c.name };
}, { secrets: [C.secrets.CLOUDINARY_API_SECRET], limit: [10, 3600] });

const setAvatar = callable("setAvatar", async ({ uid, data }) => {
  const name = C.params.CLOUDINARY_CLOUD_NAME.value();
  const url = String(data.url || "");
  const ok = new RegExp(`^https://res\\.cloudinary\\.com/${name}/image/upload/(?:[^/]+/)*hexhaedge/avatars/${uid}\\.(?:jpg|jpeg|png|webp)$`).test(url);
  if (!ok) fail("invalid-argument", "That image link is not from your upload.");
  await db.collection("users").doc(uid).update({ avatarUrl: url, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
}, { limit: [10, 3600] });

module.exports = { avatarSignature, setAvatar, sign };
