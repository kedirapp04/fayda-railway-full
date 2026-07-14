// Forgot FAN/FCN recovery. POSTs to id.et's resend-sms endpoint, which SMSes the
// user's FCN to the phone number registered against their Fayda record. The
// upstream needs ONLY the phone (a name is ignored). Ported from
// faydapdf-railway/forgotFan.js — the API relays the trigger; the FCN itself is
// delivered by SMS, never returned in the response.
const axios = require("axios");

const ENDPOINT =
  process.env.FORGOT_FAN_ENDPOINT || "https://id.et/api/proxy/api/v2/user-features/resend-sms";
const TIMEOUT_MS = Number(process.env.FORGOT_FAN_TIMEOUT_MS || 10000);

// Ethiopian phone → normalized '09XXXXXXXX'. Accepts 0/+251/251/bare-9 forms.
function normalizePhone(raw) {
  const s = String(raw || "").replace(/[\s\-()]/g, "");
  const m = s.match(/^(?:\+?251|0)?(9\d{8})$/);
  return m ? "0" + m[1] : null;
}

// Safe-for-logs form: '0911****44'.
function redactPhone(phone) {
  const s = String(phone || "");
  if (s.length < 6) return "****";
  return s.slice(0, 4) + "****" + s.slice(-2);
}

// Ask id.et to SMS the FCN to `phone`.
// Returns { ok:true, phone, message } or { ok:false, reason, ... }.
async function requestFcnBySms(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return { ok: false, reason: "invalid_phone" };

  try {
    const res = await axios.post(
      ENDPOINT,
      { individualIdType: "Phone", individualId: normalized },
      {
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          Origin: "https://id.et",
          Referer: "https://id.et/help",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
        },
        validateStatus: () => true,
      }
    );

    const status = res.status;
    const body = res.data || {};

    if (status === 200 && (!body.error || body.error === null)) {
      return { ok: true, phone: normalized, message: typeof body.message === "string" ? body.message : null };
    }
    // id.et returns {error:"...", message:null} on lookup misses.
    if (status === 400 || status === 404) return { ok: false, reason: "not_registered", upstream: body && body.error };
    if (status === 429) return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "server_error", upstream: body && body.error };
  } catch (err) {
    if (err && (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT")) return { ok: false, reason: "network_error", detail: "timeout" };
    if (err && err.code === "ENOTFOUND") return { ok: false, reason: "network_error", detail: "dns" };
    return { ok: false, reason: "network_error", detail: err && err.message };
  }
}

module.exports = { normalizePhone, redactPhone, requestFcnBySms };
