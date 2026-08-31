const { query, one, pool } = require("../db");
const env = require("../config/env");
const { generateApiKey, hashKey } = require("../utils/crypto");

const nowIso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);

// Async Supabase Postgres port of the former synchronous SQLite store. Same API
// surface, but every method returns a Promise — callers must await.

// ─── Settings (global price) ───────────────────────────────────────────────
async function getSetting(k, fallback) {
  const r = await one(`SELECT value FROM settings WHERE key = $1`, [k]);
  return r ? r.value : fallback;
}
async function setSetting(k, v) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [k, String(v)]
  );
}
async function globalPrice() {
  return Number(await getSetting("global_price", env.GLOBAL_PRICE_DEFAULT));
}
async function setGlobalPrice(p) {
  await setSetting("global_price", Math.max(0, Number(p) || 0));
  return globalPrice();
}

// ─── Server 4 token-pool X-CSRF-Token (admin-editable, .env fallback) ──────
// The pool (GET /token, /available) authenticates every call with an
// X-CSRF-Token. Stored here so a super-admin can rotate it from the bot
// (/server4csrf) without a redeploy. Falls back to SERVER4_TOKEN_API_CSRF /
// XCSRF_TOKEN from the environment when nothing is stored.
function envServer4Csrf() {
  return String(process.env.SERVER4_TOKEN_API_CSRF || process.env.XCSRF_TOKEN || "").trim();
}
async function getServer4Csrf() {
  const stored = String((await getSetting("server4_token_api_csrf", "")) || "").trim();
  return stored || envServer4Csrf();
}
async function setServer4Csrf(csrf) {
  const value = String(csrf || "").trim();
  await setSetting("server4_token_api_csrf", value);
  await setSetting("server4_token_api_csrf_at", value ? nowIso() : "");
  return value;
}
async function getServer4CsrfInfo() {
  const stored = String((await getSetting("server4_token_api_csrf", "")) || "").trim();
  const fromEnv = envServer4Csrf();
  const effective = stored || fromEnv;
  const at = String((await getSetting("server4_token_api_csrf_at", "")) || "");
  return {
    set: Boolean(effective),
    source: stored ? "admin" : (fromEnv ? "env" : "none"),
    preview: effective ? effective.slice(0, 6) + "…" : null,
    updatedAt: at || null
  };
}

// ─── Server 4 pause switch (maintenance) ───────────────────────────────────
// Temporarily stop serving Server 4 WITHOUT touching the CSRF/pool config, so a
// super-admin can pause and resume instantly from the bot.
async function getServer4Paused() {
  return String((await getSetting("server4_paused", "")) || "").trim() === "1";
}
async function setServer4Paused(paused) {
  await setSetting("server4_paused", paused ? "1" : "");
  await setSetting("server4_paused_at", paused ? nowIso() : "");
  return getServer4Paused();
}

// ─── Server 5 (resident portal) ────────────────────────────────────────────
// server5_active: the admin switch that makes Server 5 the DEFAULT engine. When
// on, ordinary requests (no explicit server chosen) with a 16-digit FAN are served
// by Server 5; 12-digit FINs and everything else fall back to the old flow. The
// end user picks nothing — only this admin choice decides.
async function getServer5Active() {
  return String((await getSetting("server5_active", "")) || "").trim() === "1";
}
async function setServer5Active(on) {
  await setSetting("server5_active", on ? "1" : "");
  await setSetting("server5_active_at", on ? nowIso() : "");
  return getServer5Active();
}

// resident_basic_auth: the api-resident Basic credential (base64 of
// "resident:<secret>"). Admin-editable, falls back to RESIDENT_BASIC_AUTH.
async function getResidentBasicAuth() {
  const stored = String((await getSetting("resident_basic_auth", "")) || "").trim();
  return stored || String(process.env.RESIDENT_BASIC_AUTH || "").trim();
}
async function setResidentBasicAuth(value) {
  await setSetting("resident_basic_auth", String(value || "").trim());
  return getResidentBasicAuth();
}

// server5_qr_gen: which generated-QR mode the server5 card carries. A generated
// QR cannot verify; this chooses HOW it fails — data (+sample sig), nosig (empty
// sig), blank (empty legacy QR), or unscannable (looks real, cannot be scanned).
const SERVER5_QR_MODES = ["data", "nosig", "blank", "unscannable"];
function normalizeQrGen(value) {
  const v = String(value || "").trim().toLowerCase();
  return SERVER5_QR_MODES.includes(v) ? v : null;
}
async function getServer5QrGen() {
  const stored = normalizeQrGen(await getSetting("server5_qr_gen", ""));
  return stored || normalizeQrGen(process.env.SERVER5_QR_GEN_DEFAULT) || "data";
}
async function setServer5QrGen(value) {
  const mode = normalizeQrGen(value);
  if (!mode) throw new Error(`Invalid QR mode. Use one of: ${SERVER5_QR_MODES.join(", ")}`);
  await setSetting("server5_qr_gen", mode);
  await setSetting("server5_qr_gen_at", nowIso());
  return mode;
}

// One price per generation: per-user override, else the global price.
async function effectivePrice(user) {
  if (user && user.price_override != null) return Number(user.price_override);
  return globalPrice();
}

// ─── Users ─────────────────────────────────────────────────────────────────
async function getUserById(id) {
  return one(`SELECT * FROM users WHERE id = $1`, [Number(id)]);
}
async function getUserByTelegramId(tg) {
  return one(`SELECT * FROM users WHERE telegram_id = $1`, [String(tg)]);
}
async function listUsers() {
  return query(`SELECT * FROM users ORDER BY id DESC`);
}
async function listPendingUsers() {
  return query(`SELECT * FROM users WHERE status = 'pending' ORDER BY id DESC`);
}

// Telegram ids to broadcast to. scope "active" = approved/trial users only;
// anything else = everyone except revoked. Null telegram_ids are dropped.
async function broadcastTargets(scope) {
  const sql =
    scope === "active"
      ? `SELECT telegram_id FROM users WHERE status IN ('approved','trial') AND telegram_id IS NOT NULL`
      : `SELECT telegram_id FROM users WHERE status <> 'revoked' AND telegram_id IS NOT NULL`;
  const rows = await query(sql);
  return rows.map((r) => r.telegram_id).filter(Boolean);
}

async function getOrCreateUser(telegramId, username) {
  const tg = String(telegramId);
  const existing = await getUserByTelegramId(tg);
  if (existing) {
    if (username && username !== existing.username) {
      await query(`UPDATE users SET username = $1 WHERE id = $2`, [username, existing.id]);
      existing.username = username;
    }
    return existing;
  }
  return one(
    `INSERT INTO users (telegram_id, username, status, daily_limit, total_limit, created_at)
     VALUES ($1, $2, 'pending', $3, $4, $5) RETURNING *`,
    [tg, username || null, env.DEFAULT_DAILY_LIMIT, env.DEFAULT_TOTAL_LIMIT, nowIso()]
  );
}

async function setUserStatus(userId, status) {
  const stamp = status === "approved" ? nowIso() : null;
  await query(
    `UPDATE users SET status = $1, approved_at = COALESCE($2, approved_at) WHERE id = $3`,
    [status, stamp, Number(userId)]
  );
  return getUserById(userId);
}

async function setLimits(userId, dailyLimit, totalLimit) {
  await query(
    `UPDATE users SET daily_limit = $1, total_limit = $2 WHERE id = $3`,
    [Math.max(0, Number(dailyLimit) || 0), Math.max(0, Number(totalLimit) || 0), Number(userId)]
  );
  return getUserById(userId);
}

// One-time free trial: grant a total quota, mark claimed, and issue a key.
async function claimTrial(userId, rewardCount) {
  const u = await getUserById(userId);
  if (!u || u.trial_claimed) return null;
  await query(
    `UPDATE users SET status='trial', billing_mode='counter', total_limit=$1, trial_claimed=1 WHERE id=$2`,
    [Math.max(0, Number(rewardCount) || 0), Number(userId)]
  );
  const { rawKey } = await issueKey(userId);
  return { rawKey };
}

// ─── API keys ────────────────────────────────────────────────────────────
async function getActiveKeyForUser(userId) {
  return one(
    `SELECT * FROM api_keys WHERE user_id = $1 AND status != 'revoked' ORDER BY id DESC LIMIT 1`,
    [Number(userId)]
  );
}

// Issue a fresh key; prior keys revoked first (one live key per user). Usage
// count carries over so a rotation can't reset the counter.
async function issueKey(userId) {
  const prev = await getActiveKeyForUser(userId);
  const carry = prev ? prev.success_count : 0;
  await query(`UPDATE api_keys SET status = 'revoked' WHERE user_id = $1 AND status != 'revoked'`, [Number(userId)]);
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  await query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, status, created_at, success_count)
     VALUES ($1, $2, $3, 'active', $4, $5)`,
    [Number(userId), keyHash, keyPrefix, nowIso(), carry]
  );
  return { rawKey, keyPrefix };
}

async function setKeyStatus(userId, status) {
  const key = await getActiveKeyForUser(userId);
  if (!key) return null;
  await query(`UPDATE api_keys SET status = $1 WHERE id = $2`, [status, key.id]);
  return { ...key, status };
}

// Hard-delete old key(s) and immediately issue a fresh one, carrying usage.
async function revokeAndReissue(userId) {
  const prev = await getActiveKeyForUser(userId);
  const carry = prev ? prev.success_count : 0;
  await query(`DELETE FROM api_keys WHERE user_id = $1`, [Number(userId)]);
  const { rawKey, keyHash, keyPrefix } = generateApiKey();
  await query(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, status, created_at, success_count)
     VALUES ($1, $2, $3, 'active', $4, $5)`,
    [Number(userId), keyHash, keyPrefix, nowIso(), carry]
  );
  return { rawKey, keyPrefix };
}

// Resolve a raw API key → { user, key } if usable, else { error }.
async function resolveApiKey(rawKey) {
  const key = await one(`SELECT * FROM api_keys WHERE key_hash = $1`, [hashKey(rawKey)]);
  if (!key) return { error: "Invalid API key." };
  if (key.status === "revoked") return { error: "API key has been revoked." };
  if (key.status === "paused") return { error: "API key is paused." };
  const user = await getUserById(key.user_id);
  if (!user) return { error: "Owner account not found." };
  if (user.status === "revoked") return { error: "Account access revoked." };
  if (user.status === "paused") return { error: "Account is paused." };
  if (user.status !== "approved" && user.status !== "trial") return { error: "Account is not approved yet." };
  return { user, key };
}

// ─── Usage / limits ─────────────────────────────────────────────────────
async function countTodaySuccess(userId) {
  const r = await one(
    `SELECT COUNT(*)::int AS n FROM usage_log WHERE user_id = $1 AND day = $2 AND success = 1`,
    [Number(userId), today()]
  );
  return r ? r.n : 0;
}

// Pre-check whether a counting request is allowed, by billing mode.
//   counter  → daily/total success limits
//   prepaid  → balance must cover the price
//   postpaid → owed + price must stay within the credit limit
async function checkBilling(user, key) {
  const price = await effectivePrice(user);
  if (user.billing_mode === "prepaid") {
    if (user.balance < price) {
      return { ok: false, reason: `Insufficient balance (need ${price}, have ${user.balance}). Ask admin to top up.` };
    }
  } else if (user.billing_mode === "postpaid") {
    if (!(user.credit_limit > 0)) {
      return { ok: false, reason: "No postpaid credit assigned. Contact admin." };
    }
    if (user.owed + price > user.credit_limit) {
      return { ok: false, reason: `Postpaid credit limit reached (owed ${user.owed}/${user.credit_limit}).` };
    }
  } else { // counter
    if (user.total_limit > 0 && key.success_count >= user.total_limit) {
      return { ok: false, reason: "Total success limit reached for this account." };
    }
    if (user.daily_limit > 0 && (await countTodaySuccess(user.id)) >= user.daily_limit) {
      return { ok: false, reason: "Daily success limit reached. Try again tomorrow." };
    }
  }
  return { ok: true, price };
}

// Apply the charge for one counted generation (after success).
async function chargeUsage(user, price) {
  if (user.billing_mode === "prepaid") {
    await query(`UPDATE users SET balance = balance - $1 WHERE id = $2`, [Number(price) || 0, Number(user.id)]);
  } else if (user.billing_mode === "postpaid") {
    await query(`UPDATE users SET owed = owed + $1 WHERE id = $2`, [Number(price) || 0, Number(user.id)]);
  }
  // counter: no money movement
}

// ─── Billing management (admin) ────────────────────────────────────────────
async function setBillingMode(userId, mode) {
  const m = ["counter", "prepaid", "postpaid"].includes(mode) ? mode : "counter";
  await query(`UPDATE users SET billing_mode = $1 WHERE id = $2`, [m, Number(userId)]);
  return getUserById(userId);
}
async function topUp(userId, amount) {
  await query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [Number(amount) || 0, Number(userId)]);
  return getUserById(userId);
}
async function setPrice(userId, price) {
  const p = (price === "" || price == null || Number(price) < 0) ? null : Number(price);
  await query(`UPDATE users SET price_override = $1 WHERE id = $2`, [p, Number(userId)]);
  return getUserById(userId);
}
async function setCreditLimit(userId, limit) {
  await query(`UPDATE users SET credit_limit = $1 WHERE id = $2`, [Math.max(0, Number(limit) || 0), Number(userId)]);
  return getUserById(userId);
}
async function settleOwed(userId) {
  await query(`UPDATE users SET owed = 0 WHERE id = $1`, [Number(userId)]);
  return getUserById(userId);
}

// counts=false logs the request but does NOT increment the counter.
async function recordUsage({ userId, apiKeyId, format, success, ip, detail, counts = true }) {
  await query(
    `INSERT INTO usage_log (user_id, api_key_id, ts, day, format, success, ip, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [Number(userId), Number(apiKeyId), nowIso(), today(), format || null, success ? 1 : 0, ip || null, detail || null]
  );
  if (success && counts) {
    await query(`UPDATE api_keys SET success_count = success_count + 1, last_used_at = $1 WHERE id = $2`, [nowIso(), Number(apiKeyId)]);
  } else {
    await query(`UPDATE api_keys SET last_used_at = $1 WHERE id = $2`, [nowIso(), Number(apiKeyId)]);
  }
}

// ─── Counter saves (save & reset / clear) ──────────────────────────────
async function listSaves(userId) {
  return query(`SELECT * FROM counter_saves WHERE user_id = $1 ORDER BY id DESC`, [Number(userId)]);
}
async function savesTotal(userId) {
  const r = await one(`SELECT COALESCE(SUM(saved_count),0)::int AS t FROM counter_saves WHERE user_id = $1`, [Number(userId)]);
  return r ? r.t : 0;
}
// Sum of saved payment amounts that are still unpaid (the frozen debt the user
// owes for past, already-archived periods).
async function unpaidSavedAmount(userId) {
  const r = await one(
    `SELECT COALESCE(SUM(amount),0)::float8 AS t FROM counter_saves WHERE user_id = $1 AND paid = 0`,
    [Number(userId)]
  );
  return r ? Number(r.t) : 0;
}
async function listUnpaidSaves(userId) {
  return query(`SELECT * FROM counter_saves WHERE user_id = $1 AND paid = 0 ORDER BY id DESC`, [Number(userId)]);
}
// Snapshot the current live count into a saved period AND freeze it as a payment
// record (price at save time → amount), then reset the live counter to 0.
async function saveCounterAndReset(userId, note) {
  const user = await getUserById(userId);
  const key = await getActiveKeyForUser(userId);
  const current = key ? key.success_count : 0;
  const price = await effectivePrice(user);
  const amount = current * price;
  await query(
    `INSERT INTO counter_saves (user_id, saved_count, saved_at, note, price, amount, paid)
     VALUES ($1, $2, $3, $4, $5, $6, 0)`,
    [Number(userId), current, nowIso(), note || null, price, amount]
  );
  if (key) await query(`UPDATE api_keys SET success_count = 0 WHERE id = $1`, [key.id]);
  return { saved: current, price, amount };
}
// One-tap settle of the CURRENT (unsaved) period: snapshot it as an already-PAID
// payment record at the current price, then reset the live counter. Use when the
// user has paid for everything they've generated this period.
async function settleCurrentPaid(userId, note) {
  const user = await getUserById(userId);
  const key = await getActiveKeyForUser(userId);
  const current = key ? key.success_count : 0;
  const price = await effectivePrice(user);
  const amount = current * price;
  const at = nowIso();
  await query(
    `INSERT INTO counter_saves (user_id, saved_count, saved_at, note, price, amount, paid, paid_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $3)`,
    [Number(userId), current, at, note || "settled paid", price, amount]
  );
  if (key) await query(`UPDATE api_keys SET success_count = 0 WHERE id = $1`, [key.id]);
  return { saved: current, price, amount };
}
// Mark a saved payment paid (or unpaid). Returns the updated row.
async function markSavePaid(saveId, paid = true) {
  await query(
    `UPDATE counter_saves SET paid = $1, paid_at = $2 WHERE id = $3`,
    [paid ? 1 : 0, paid ? nowIso() : null, Number(saveId)]
  );
  return one(`SELECT * FROM counter_saves WHERE id = $1`, [Number(saveId)]);
}
async function clearSave(saveId) {
  const r = await pool.query(`DELETE FROM counter_saves WHERE id = $1`, [Number(saveId)]);
  return r.rowCount;
}
// Settle every still-unpaid save for a user (used by an approved "Pay All").
async function markAllUnpaidPaid(userId) {
  await query(`UPDATE counter_saves SET paid = 1, paid_at = $1 WHERE user_id = $2 AND paid = 0`,
    [nowIso(), Number(userId)]);
}

// ─── Payment requests (user receipt → admin approve/reject) ─────────────
async function createPaymentRequest({ userId, scope, saveId, amount, receiptKind, receiptText, receiptFileId }) {
  return one(
    `INSERT INTO payment_requests
       (user_id, scope, save_id, amount, receipt_kind, receipt_text, receipt_file_id, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8) RETURNING *`,
    [Number(userId), String(scope), saveId != null ? Number(saveId) : null, Number(amount) || 0,
     receiptKind || null, receiptText || null, receiptFileId || null, nowIso()]
  );
}
async function getPaymentRequest(id) {
  return one(`SELECT * FROM payment_requests WHERE id = $1`, [Number(id)]);
}
async function decidePaymentRequest(id, status, decidedBy) {
  await query(`UPDATE payment_requests SET status = $1, decided_at = $2, decided_by = $3 WHERE id = $4`,
    [String(status), nowIso(), String(decidedBy || ""), Number(id)]);
  return getPaymentRequest(id);
}

async function getUserStats(userId) {
  const user = await getUserById(userId);
  if (!user) return null;
  const key = await getActiveKeyForUser(userId);
  const current = key ? key.success_count : 0;
  const saved = await savesTotal(userId);
  const saves = await listSaves(userId);
  const price = await effectivePrice(user);
  // Debt = the current (unsaved) period valued at the CURRENT price, plus any
  // already-saved payments still marked unpaid.
  const debtLive = current * price;
  const debtSaved = await unpaidSavedAmount(userId);
  return {
    user,
    key,
    totalSuccess: current,
    savedTotal: saved,
    lifetime: saved + current,
    savesCount: saves.length,
    todaySuccess: await countTodaySuccess(userId),
    dailyLimit: user.daily_limit,
    totalLimit: user.total_limit,
    billingMode: user.billing_mode,
    price,
    priceOverride: user.price_override,
    balance: user.balance,
    owed: user.owed,
    creditLimit: user.credit_limit,
    debtLive,
    debtSaved,
    debt: debtLive + debtSaved
  };
}

module.exports = {
  getOrCreateUser,
  getUserById,
  getUserByTelegramId,
  listUsers,
  listPendingUsers,
  broadcastTargets,
  setUserStatus,
  setLimits,
  claimTrial,
  issueKey,
  revokeAndReissue,
  setKeyStatus,
  getActiveKeyForUser,
  resolveApiKey,
  countTodaySuccess,
  checkBilling,
  chargeUsage,
  recordUsage,
  listSaves,
  savesTotal,
  unpaidSavedAmount,
  listUnpaidSaves,
  saveCounterAndReset,
  settleCurrentPaid,
  markSavePaid,
  clearSave,
  markAllUnpaidPaid,
  createPaymentRequest,
  getPaymentRequest,
  decidePaymentRequest,
  getUserStats,
  globalPrice,
  setGlobalPrice,
  effectivePrice,
  getServer4Csrf,
  setServer4Csrf,
  getServer4CsrfInfo,
  getServer4Paused,
  setServer4Paused,
  getResidentBasicAuth,
  setResidentBasicAuth,
  getServer5Active,
  setServer5Active,
  getServer5QrGen,
  setServer5QrGen,
  SERVER5_QR_MODES,
  setBillingMode,
  topUp,
  setPrice,
  setCreditLimit,
  settleOwed
};
