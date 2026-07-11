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

const DEFAULT_API_URL = "http://173.249.21.62:8010/token";

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
  const poolUrl = opts.apiUrl || process.env.SERVER4_TOKEN_API_URL || DEFAULT_API_URL;
  const csrf = opts.csrfToken || process.env.SERVER4_TOKEN_API_CSRF || process.env.XCSRF_TOKEN || "";
  // Pool not configured (no CSRF) → static token only.
  if (!String(csrf).trim()) return fallback;
  const secs = Number.isFinite(Number(minSeconds))
    ? Number(minSeconds)
    : Number(process.env.SERVER4_TOKEN_MIN_SECONDS || 90);
  try {
    const data = await fetchJson(withMinSeconds(poolUrl, secs), { csrfToken: csrf });
    const status = data && data.status ? String(data.status).toLowerCase() : "";
    const usable = !status || status === "active" || status === "warning";
    const fetched = usable ? String((data && (data.token || data.value)) || "").trim() : "";
    return fetched || fallback;
  } catch (_) {
    // pool empty / csrf rejected / network — degrade to the static token
    return fallback;
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
 * Start polling the token API. Returns { stop }.
 * @param {function(): (string|Promise<string>)} getCurrentToken
 * @param {function(string): any} setToken           persist the new token
 * @param {object} [opts] { apiUrl, intervalMs, log }
 */
function startServer4TokenAutoUpdate({ getCurrentToken, setToken, apiUrl, intervalMs, log } = {}) {
  const enabled = String(process.env.SERVER4_TOKEN_AUTO_UPDATE || "true").toLowerCase() !== "false";
  const url = apiUrl || process.env.SERVER4_TOKEN_API_URL || DEFAULT_API_URL;
  const every = Math.max(30_000, Number(intervalMs || process.env.SERVER4_TOKEN_POLL_MS || 180_000));
  const logFn = typeof log === "function" ? log : () => {};
  if (!enabled || typeof getCurrentToken !== "function" || typeof setToken !== "function") {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      const data = await fetchJson(url);
      // Honor the API's lifecycle status — never adopt an expired/none token.
      const status = data && data.status ? String(data.status).toLowerCase() : "";
      const usable = !status || status === "active" || status === "warning";
      const fetched = usable ? String((data && (data.token || data.value)) || "").trim() : "";
      if (fetched) {
        const current = String((await getCurrentToken()) || "").trim();
        const fetchedExp = tokenExp(fetched);
        const currentExp = tokenExp(current);
        // Update only when it actually changed AND is fresher: later exp, or we
        // currently hold no decodable/usable token. Never downgrade to an older one.
        const fresher =
          fetched !== current &&
          fetchedExp != null &&
          (currentExp == null || fetchedExp > currentExp);
        if (fresher) {
          await setToken(fetched);
          logFn(`Server 4 App Check token auto-updated from API (exp ${new Date(fetchedExp).toISOString()}).`);
        }
      }
    } catch (_) {
      // soft-fail: network/API hiccup — just try again next tick
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

module.exports = { startServer4TokenAutoUpdate, takeFreshAppCheckToken, tokenExp, fetchJson, DEFAULT_API_URL };
