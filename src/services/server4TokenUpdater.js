// Server 4 App Check token auto-updater.
// Polls a small HTTP API that serves the latest device-captured X-Firebase-
// AppCheck token, and replaces the stored token whenever the API's token is
// FRESHER (later JWT `exp`) than the current one. This keeps Server 4 working
// without anyone pasting tokens by hand every hour.
//
// Wire it per bot by passing getCurrentToken()/setToken() that read/write
// wherever that bot keeps the token (settings DB, Postgres settings table, …).
const http = require("http");
const https = require("https");
const metrics = require("./tokenMetrics");

// Default ntknpro pool host (Contabo VPS). Override with SERVER4_TOKEN_API_URL.
// Must match the pool your X-CSRF-Token belongs to — a URL/CSRF host mismatch
// makes every take fail and silently fall back to the static token (which then
// replays → "Verification service temporarily unavailable").
const DEFAULT_API_URL = "http://173.212.212.105:8010/token";

// The token API requires an X-CSRF-Token header on /token (HTTP 401 without it).
// Each approved Telegram user gets theirs from the bot's /csrf command; put it in
// the .env so this service can read /token. See API_USAGE.md.
function csrfHeader(explicit) {
  const token = String(
    explicit || process.env.SERVER4_TOKEN_API_CSRF || process.env.XCSRF_TOKEN || ""
  ).trim();
  return token ? { "X-CSRF-Token": token } : {};
}

// fetchJson(url) — auto-attaches the X-CSRF-Token from env. Back-compatible 2nd
// arg: a number = timeoutMs (legacy), or { timeoutMs, csrfToken, headers }.
function fetchJson(url, opts = {}) {
  const timeoutMs = typeof opts === "number" ? opts : (opts.timeoutMs || 15000);
  const headers = {
    Accept: "application/json",
    ...csrfHeader(typeof opts === "object" ? opts.csrfToken : undefined),
    ...(typeof opts === "object" && opts.headers ? opts.headers : {})
  };
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          const hint = res.statusCode === 401
            ? " (missing/invalid X-CSRF-Token — set SERVER4_TOKEN_API_CSRF in .env)"
            : "";
          return reject(new Error("HTTP " + res.statusCode + hint));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("token API timeout")));
  });
}

// Append/replace ?min_seconds=N on the pool /token URL so the pool hands out a
// token with at least N seconds of life (survives the send-OTP→verify→callback
// window). Malformed URL → returned unchanged.
function withMinSeconds(url, minSeconds) {
  const n = Number(minSeconds);
  if (!Number.isFinite(n) || n <= 0) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("min_seconds", String(Math.floor(n)));
    return u.toString();
  } catch (_) {
    return url;
  }
}

/**
 * Take ONE fresh single-use App Check token from the pool's consuming
 * `GET /token` endpoint, right before a gated upstream request. App Check tokens
 * are single-use — never cache or reuse the result. On pool empty / CSRF-401 /
 * network error, returns `staticFallback` (the admin-pasted token) so the flow
 * degrades instead of dying. Returns "" if neither is available.
 *
 * @param {number} [minSeconds]      minimum life required (default env or 90)
 * @param {string} [staticFallback]  admin-set token to use if the pool fails
 * @param {object} [opts]            { apiUrl, csrfToken }
 * @returns {Promise<string>}
 */
async function takeFreshAppCheckToken(minSeconds, staticFallback = "", opts = {}) {
  const fallback = String(staticFallback || "").trim();
  const purpose = opts.purpose || "request";
  const poolUrl = opts.apiUrl || process.env.SERVER4_TOKEN_API_URL || DEFAULT_API_URL;
  const csrf = opts.csrfToken || process.env.SERVER4_TOKEN_API_CSRF || process.env.XCSRF_TOKEN || "";
  // Pool not configured (no CSRF) → static token only, no take attempted.
  if (!String(csrf).trim()) return fallback;
  const secs = Number.isFinite(Number(minSeconds))
    ? Number(minSeconds)
    : Number(process.env.SERVER4_TOKEN_MIN_SECONDS || 90);
  try {
    const data = await fetchJson(withMinSeconds(poolUrl, secs), { csrfToken: csrf });
    const status = data && data.status ? String(data.status).toLowerCase() : "";
    const usable = !status || status === "active" || status === "warning";
    const fetched = usable ? String((data && (data.token || data.value)) || "").trim() : "";
    if (fetched) {
      const rem = data && Number.isFinite(Number(data.remaining_seconds)) ? Number(data.remaining_seconds) : null;
      metrics.recordTake(purpose, rem);
      return fetched;
    }
    metrics.recordFailedTake(purpose, status || "empty");
    return fallback;
  } catch (e) {
    // pool empty / csrf rejected / network — degrade to the static token
    metrics.recordFailedTake(purpose, (e && e.message) ? e.message : "error");
    return fallback;
  }
}

// Non-consuming pool health check — GET /available (never touches /token).
// Returns { ok, count, soonestSec, status?, error? }.
async function getPoolAvailable(opts = {}) {
  const base = opts.apiUrl || process.env.SERVER4_TOKEN_API_URL || DEFAULT_API_URL;
  const csrf = opts.csrfToken || process.env.SERVER4_TOKEN_API_CSRF || process.env.XCSRF_TOKEN || "";
  if (!String(csrf).trim()) return { ok: false, error: "no CSRF configured" };
  // /available lives next to /token on the same host.
  const url = String(base).replace(/\/token(\?.*)?$/i, "/available");
  try {
    const data = await fetchJson(url, { csrfToken: csrf });
    const count = Number(data && data.available);
    return {
      ok: true,
      count: Number.isFinite(count) ? count : null,
      soonestSec: data && Number.isFinite(Number(data.soonest_remaining_seconds)) ? Number(data.soonest_remaining_seconds) : null,
      status: data && data.status ? String(data.status) : null
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : "error" };
  }
}

// Decode the JWT `exp` claim (ms epoch). null if absent/invalid.
function tokenExp(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch (_) {
    return null;
  }
}

/**
 * Keep the STATIC fallback token warm — but stop draining the pool.
 * Since every real request now takes its own fresh token from the pool
 * (takeFreshAppCheckToken), this background refresh exists only so a usable
 * break-glass token is on hand if the pool ever empties. It therefore consumes
 * a token ONLY when the stored one is missing or within SERVER4_TOKEN_REFRESH_
 * LEAD_MS of expiry — roughly once per token lifetime instead of every poll.
 * Returns { stop }.
 * @param {object} p
 * @param {function(): (string|Promise<string>)} p.getCurrentToken
 * @param {function(string): any} p.setToken   persist the new token
 * @param {function(): (string|Promise<string>)} [p.getCsrf]  stored pool CSRF
 * @param {object} [p] also accepts { apiUrl, intervalMs, log }
 */
function startServer4TokenAutoUpdate({ getCurrentToken, setToken, getCsrf, apiUrl, intervalMs, log } = {}) {
  const enabled = String(process.env.SERVER4_TOKEN_AUTO_UPDATE || "true").toLowerCase() !== "false";
  const url = apiUrl || process.env.SERVER4_TOKEN_API_URL || DEFAULT_API_URL;
  const every = Math.max(30_000, Number(intervalMs || process.env.SERVER4_TOKEN_POLL_MS || 180_000));
  const leadMs = Math.max(60_000, Number(process.env.SERVER4_TOKEN_REFRESH_LEAD_MS || 10 * 60 * 1000));
  const logFn = typeof log === "function" ? log : () => {};
  if (!enabled || typeof getCurrentToken !== "function" || typeof setToken !== "function") {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function resolveCsrf() {
    try {
      if (typeof getCsrf === "function") {
        const v = String((await getCsrf()) || "").trim();
        if (v) return v;
      }
    } catch (_) {}
    return String(process.env.SERVER4_TOKEN_API_CSRF || process.env.XCSRF_TOKEN || "").trim();
  }

  async function tick() {
    if (stopped) return;
    try {
      // Gate: don't consume a pool token while the static fallback is still
      // healthy. Only refresh when missing or near expiry.
      const current = String((await getCurrentToken()) || "").trim();
      const currentExp = tokenExp(current);
      if (current && currentExp != null && (currentExp - Date.now()) > leadMs) {
        return; // still fresh — leave the pool alone (finally reschedules)
      }

      const csrf = await resolveCsrf();
      if (!csrf) return; // pool not configured — nothing to refresh from

      const data = await fetchJson(withMinSeconds(url, Number(process.env.SERVER4_TOKEN_MIN_SECONDS || 90)), { csrfToken: csrf });
      // Honor the API's lifecycle status — never adopt an expired/none token.
      const status = data && data.status ? String(data.status).toLowerCase() : "";
      const usable = !status || status === "active" || status === "warning";
      const fetched = usable ? String((data && (data.token || data.value)) || "").trim() : "";
      if (fetched) {
        const fetchedExp = tokenExp(fetched);
        // Update only when it actually changed AND is fresher: later exp, or we
        // currently hold no decodable/usable token. Never downgrade to an older one.
        const fresher =
          fetched !== current &&
          fetchedExp != null &&
          (currentExp == null || fetchedExp > currentExp);
        if (fresher) {
          await setToken(fetched);
          const rem = data && Number.isFinite(Number(data.remaining_seconds)) ? Number(data.remaining_seconds) : null;
          metrics.recordTake("static-refresh", rem);
          logFn(`Server 4 App Check static fallback refreshed from pool (exp ${new Date(fetchedExp).toISOString()}).`);
        }
      } else if (status) {
        metrics.recordFailedTake("static-refresh", status);
      }
    } catch (e) {
      // soft-fail: network/API hiccup — just try again next tick
      metrics.recordFailedTake("static-refresh", (e && e.message) ? e.message : "error");
    } finally {
      if (!stopped) timer = setTimeout(tick, every);
    }
  }

  // First poll shortly after boot, then every `every` ms.
  timer = setTimeout(tick, 3000);
  if (timer && typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}

module.exports = { startServer4TokenAutoUpdate, takeFreshAppCheckToken, getPoolAvailable, tokenExp, fetchJson, DEFAULT_API_URL };
