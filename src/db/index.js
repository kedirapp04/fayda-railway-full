const { pool, query, one } = require("./pool");

// Idempotent schema bootstrap on Supabase Postgres. Timestamps are stored as
// TEXT ISO strings (the app slices them as strings), booleans as SMALLINT 0/1,
// money as DOUBLE PRECISION, counts/ids as INTEGER (so pg returns JS numbers,
// not BIGINT strings). No dedupe/counted_requests table — one render per verify.
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      telegram_id   TEXT UNIQUE,
      username      TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      daily_limit   INTEGER NOT NULL DEFAULT 0,
      total_limit   INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      approved_at   TEXT,
      notes         TEXT,
      trial_claimed SMALLINT NOT NULL DEFAULT 0,
      docs_granted  SMALLINT NOT NULL DEFAULT 0,
      billing_mode  TEXT NOT NULL DEFAULT 'counter',
      balance       DOUBLE PRECISION NOT NULL DEFAULT 0,
      price_override DOUBLE PRECISION,
      credit_limit  DOUBLE PRECISION NOT NULL DEFAULT 0,
      owed          DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_hash      TEXT UNIQUE NOT NULL,
      key_prefix    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TEXT NOT NULL,
      last_used_at  TEXT,
      success_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id     INTEGER,
      api_key_id  INTEGER,
      ts          TEXT NOT NULL,
      day         TEXT NOT NULL,
      format      TEXT,
      success     SMALLINT NOT NULL DEFAULT 0,
      ip          TEXT,
      detail      TEXT
    );

    CREATE TABLE IF NOT EXISTS counter_saves (
      id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      saved_count  INTEGER NOT NULL,
      saved_at     TEXT NOT NULL,
      note         TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user_day ON usage_log(user_id, day);
    CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_saves_user ON counter_saves(user_id);
  `);
}

module.exports = { init, pool, query, one };
