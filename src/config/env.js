const dotenv = require("dotenv");
dotenv.config();

function intValue(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

// Merged Fayda OTP gateway + PDF generator, single service for Railway.
const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  // Railway injects PORT. The admin/health/API server binds to it.
  PORT: intValue(process.env.PORT, 8090),
  TRUST_PROXY: boolValue(process.env.TRUST_PROXY, true),
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",

  // ── Supabase Postgres ──────────────────────────────────────────────────
  DATABASE_URL: process.env.DATABASE_URL || "",

  // ── OTP session (in-memory, gateway concern) ───────────────────────────
  SESSION_TTL_MINUTES: intValue(process.env.SESSION_TTL_MINUTES, 10),
  UPSTREAM_REQUEST_TIMEOUT_MS: intValue(process.env.UPSTREAM_REQUEST_TIMEOUT_MS, 60_000),

  // ── Server 3 (eSignet / Fayda backend) — server3AuthFlow reads process.env
  //    directly; mirrored here for visibility. ────────────────────────────
  FAYDA_API_BASE: process.env.FAYDA_API_BASE || process.env.NEW_FAYDA_API_BASE || "https://fayda-app-backend.fayda.et",
  ESIGNET_BASE: process.env.ESIGNET_BASE || process.env.FAYDA_ESIGNET_BASE || "https://auth.fayda.et",
  FAYDA_API_KEY: process.env.FAYDA_API_KEY || "",
  SERVER_THREE_OTP_CHANNELS: process.env.SERVER_THREE_OTP_CHANNELS || "email,phone",

  // ── Telegram management bot (admin: approve users, keys, limits, billing) ─
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  ADMIN_TELEGRAM_IDS: String(process.env.ADMIN_TELEGRAM_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
  ENABLE_TELEGRAM_BOT: boolValue(process.env.ENABLE_TELEGRAM_BOT, true),

  // Default per-user limits applied when a user is approved (0 = unlimited).
  DEFAULT_DAILY_LIMIT: intValue(process.env.DEFAULT_DAILY_LIMIT, 0),
  DEFAULT_TOTAL_LIMIT: intValue(process.env.DEFAULT_TOTAL_LIMIT, 0),

  // Free self-service trial: total generations granted once per user.
  TRIAL_REWARD_COUNT: intValue(process.env.TRIAL_REWARD_COUNT, 15),

  // Default price per generation (used until an admin sets a global price).
  GLOBAL_PRICE_DEFAULT: Number(process.env.GLOBAL_PRICE || 5)
};

env.IS_PRODUCTION = env.NODE_ENV === "production";

module.exports = env;
