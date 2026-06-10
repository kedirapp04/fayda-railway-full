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

const DEFAULT_API_URL = "http://57.131.35.207:8000/api/token";

function fetchJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("HTTP " + res.statusCode));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("token API timeout")));
  });
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
      const fetched = String((data && (data.value || data.token)) || "").trim();
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

module.exports = { startServer4TokenAutoUpdate, tokenExp, fetchJson, DEFAULT_API_URL };
