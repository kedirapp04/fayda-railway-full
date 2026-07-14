const { normalizePhone, redactPhone, requestFcnBySms } = require("../integrations/fayda/forgotFan");

// Per-PHONE rate limit (not per API key): a single caller serves many end-users,
// but we must stop anyone from spamming SMS at one number and getting our IP
// flagged upstream. Default: 3 attempts / 10 min per phone. In-memory.
const RATE_WINDOW_MS = Number(process.env.FORGOT_FAN_RATE_WINDOW_MS || 10 * 60 * 1000);
const RATE_MAX = Number(process.env.FORGOT_FAN_RATE_MAX || 3);
const bucket = new Map(); // phone -> { count, firstAt }

function rateLimited(phone) {
  const now = Date.now();
  const b = bucket.get(phone);
  if (!b || now - b.firstAt > RATE_WINDOW_MS) {
    bucket.set(phone, { count: 1, firstAt: now });
    return false;
  }
  if (b.count >= RATE_MAX) return true;
  b.count += 1;
  return false;
}
function resetRate(phone) {
  bucket.delete(phone);
}

function httpError(status, message) {
  const e = new Error(message);
  e.statusCode = status;
  e.publicMessage = message;
  return e;
}

// POST /api/forgot-fan  { phone }
// Triggers id.et to SMS the caller's FCN/FAN to their REGISTERED phone. The
// number itself is delivered by SMS and is never returned here.
async function forgotFan(req, res, next) {
  try {
    const phone = normalizePhone(req.body?.phone || req.body?.individualId || "");
    if (!phone) {
      throw httpError(400, "A valid Ethiopian phone number is required (e.g. 09XXXXXXXX).");
    }

    if (rateLimited(phone)) {
      throw httpError(429, "Too many recovery attempts for this number. Please try again in a few minutes.");
    }

    const result = await requestFcnBySms(phone);
    if (result.ok) {
      resetRate(phone);
      return res.json({
        ok: true,
        phone: redactPhone(phone),
        message: result.message || "Your FCN has been sent by SMS to the registered phone.",
      });
    }

    if (result.reason === "invalid_phone") throw httpError(400, "Invalid phone number.");
    if (result.reason === "not_registered") throw httpError(404, "No Fayda record is registered to that phone number.");
    if (result.reason === "rate_limited") throw httpError(429, "The recovery service is busy. Please try again shortly.");
    throw httpError(502, "Recovery service is temporarily unavailable. Please try again in a few minutes.");
  } catch (error) {
    if (error.statusCode) return next(error);
    return next(httpError(502, "Failed to process the FAN recovery request."));
  }
}

module.exports = { forgotFan };
