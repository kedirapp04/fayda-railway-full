const { Pool } = require("pg");
const env = require("../config/env");

// Single pg Pool over the Supabase connection string. Supabase requires SSL;
// rejectUnauthorized:false matches their pooled endpoints.
if (!env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — Supabase Postgres connection string is required.");
}

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number.parseInt(process.env.PG_POOL_MAX || "5", 10) || 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000
});

pool.on("error", (err) => {
  console.error("[pg pool error]", err?.message || err);
});

// rows helper
async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

// first row or null
async function one(text, params) {
  const res = await pool.query(text, params);
  return res.rows[0] || null;
}

module.exports = { pool, query, one };
