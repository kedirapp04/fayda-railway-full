const crypto = require("crypto");

// Merged gateway+generator service: the OTP verify and the PDF render happen in
// the SAME process, so the old hybrid RSA/AES envelope (encrypt in gateway,
// decrypt in generator) is gone. The verify payload is passed in memory. Only
// API-key hashing and id generation remain.

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(String(rawKey)).digest("hex");
}

function generateApiKey() {
  const raw = `rk_${crypto.randomBytes(24).toString("hex")}`;
  return { rawKey: raw, keyHash: hashKey(raw), keyPrefix: raw.slice(0, 10) };
}

function generateSessionId() {
  return `sess_${crypto.randomBytes(18).toString("hex")}`;
}

function maskFan(fan) {
  const raw = String(fan || "");
  if (raw.length <= 4) return raw;
  return `${"*".repeat(Math.max(raw.length - 4, 0))}${raw.slice(-4)}`;
}

module.exports = { hashKey, generateApiKey, generateSessionId, maskFan };
