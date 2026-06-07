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
// Snapshot the current live count into a saved period, then reset to 0.
async function saveCounterAndReset(userId, note) {
  const key = await getActiveKeyForUser(userId);
  const current = key ? key.success_count : 0;
  await query(`INSERT INTO counter_saves (user_id, saved_count, saved_at, note) VALUES ($1, $2, $3, $4)`,
    [Number(userId), current, nowIso(), note || null]);
  if (key) await query(`UPDATE api_keys SET success_count = 0 WHERE id = $1`, [key.id]);
  return current;
}
async function clearSave(saveId) {
  const r = await pool.query(`DELETE FROM counter_saves WHERE id = $1`, [Number(saveId)]);
  return r.rowCount;
}

async function getUserStats(userId) {
  const user = await getUserById(userId);
  if (!user) return null;
  const key = await getActiveKeyForUser(userId);
  const current = key ? key.success_count : 0;
  const saved = await savesTotal(userId);
  const saves = await listSaves(userId);
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
    price: await effectivePrice(user),
    priceOverride: user.price_override,
    balance: user.balance,
    owed: user.owed,
    creditLimit: user.credit_limit
  };
}

module.exports = {
  getOrCreateUser,
  getUserById,
  getUserByTelegramId,
  listUsers,
  listPendingUsers,
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
  saveCounterAndReset,
  clearSave,
  getUserStats,
  globalPrice,
  setGlobalPrice,
  effectivePrice,
  setBillingMode,
  topUp,
  setPrice,
  setCreditLimit,
  settleOwed
};
