const store = require("../services/store.service");

// Per-user API-key auth backed by Supabase. Resolves the raw key to its owner,
// checks key + account status, and attaches { user, key } to req. The SAME key
// authenticates both send-OTP and verify+generate (single-key model).
async function apiKeyAuth(req, res, next) {
  try {
    const provided = req.get("x-api-key") || req.query.api_key || "";
    if (!provided) {
      return res.status(401).json({ ok: false, error: "Missing x-api-key." });
    }
    const resolved = await store.resolveApiKey(provided);
    if (resolved.error) {
      return res.status(403).json({ ok: false, error: resolved.error });
    }
    req.rentalUser = resolved.user;
    req.rentalKey = resolved.key;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = apiKeyAuth;
