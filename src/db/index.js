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
    CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_saves_user ON counter_saves(user_id);
  `);

  // A saved period is also a payment record: freeze the price at save time and
  // the resulting amount (saved_count × price), with a paid/unpaid flag the
  // admin can toggle. Idempotent — safe to run on every boot.
  await pool.query(`
    ALTER TABLE counter_saves ADD COLUMN IF NOT EXISTS price   DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE counter_saves ADD COLUMN IF NOT EXISTS amount  DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE counter_saves ADD COLUMN IF NOT EXISTS paid    SMALLINT NOT NULL DEFAULT 0;
    ALTER TABLE counter_saves ADD COLUMN IF NOT EXISTS paid_at TEXT;
  `);

  // A user-submitted payment proof awaiting admin review. scope='all' settles
  // every unpaid save on approve; scope='one' settles the single save_id. The
  // receipt is a transaction text and/or a Telegram file_id (photo/PDF).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_requests (
      id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope           TEXT NOT NULL,
      save_id         INTEGER,
      amount          DOUBLE PRECISION NOT NULL DEFAULT 0,
      receipt_kind    TEXT,
      receipt_text    TEXT,
      receipt_file_id TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL,
      decided_at      TEXT,
      decided_by      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payreq_user ON payment_requests(user_id);
    ALTER TABLE payment_requests ENABLE ROW LEVEL SECURITY;
  `);

  // Lock the public schema against Supabase's auto-exposed PostgREST API. With
  // RLS enabled and NO policies, the anon/authenticated REST roles get zero
  // access. The app connects as the `postgres` role (BYPASSRLS), so it is
  // unaffected. ENABLE ROW LEVEL SECURITY is idempotent (no-op if already on).
  await pool.query(`
    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
    ALTER TABLE usage_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE counter_saves ENABLE ROW LEVEL SECURITY;
    ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
  `);
}

module.exports = { init, pool, query, one };
