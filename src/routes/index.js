const express = require("express");
const env = require("../config/env");
const apiKeyAuth = require("../middleware/apiKeyAuth");
const { startSession, verifyAndGenerate } = require("../controllers/session.controller");
const { forgotFan } = require("../controllers/forgotFan.controller");

const router = express.Router();

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "fayda-railway",
    server: "server3",
    db: Boolean(env.DATABASE_URL),
    botEnabled: env.ENABLE_TELEGRAM_BOT && Boolean(env.TELEGRAM_BOT_TOKEN)
  });
});

// Single-key model: the per-user rental key authenticates both steps.
//   1) POST /api/session                 { individualId }            → send OTP
//   2) POST /api/session/:id/verify      { otp, format }             → verify + render
router.post("/session", apiKeyAuth, startSession);
router.post("/session/:id/verify", apiKeyAuth, verifyAndGenerate);

// Forgot FAN/FCN: SMS the caller's FCN to their registered phone.
//   POST /api/forgot-fan   { phone }   → { ok, phone (masked), message }
router.post("/forgot-fan", apiKeyAuth, forgotFan);

module.exports = router;
