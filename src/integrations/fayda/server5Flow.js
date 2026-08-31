// ─── Server 5 — resident-portal identity flow ─────────────────────────────────
// Same eSignet OTP exchange as Server 3/4 (reused verbatim from server3AuthFlow),
// but with the RESIDENT OAuth client and two resident-only steps at the end:
//
//   1  build the resident authorize URL   (local — no backend authorize call,
//      no App Check token; the resident portal is a plain OAuth client)
//   2  init eSignet (authorize page → csrf → oauth-details)   [reused]
//   3  send-otp                                                [reused pattern]
//   4  authenticate(OTP) → auth-code                          [reused]
//   5  exchangeAutheCode  → bare id_token JWT   (api-resident)
//   6  exchangeResident   → identity JSON       (api-resident, ~3 MB)
//
// The resident API returns DATA, not card pictures, so the QR + front/back cards
// are drawn locally (server5cards) — with an admin-selectable QR mode — and folded
// into a verifyResponse shaped exactly like Server 3/4's, so the controller's
// existing PDF / screenshot / JSON paths render it unchanged.
//
// ⚠️ NEEDS A LIVE TEST PASS against the real Fayda backend + a valid
// RESIDENT_BASIC_AUTH. Ported from the working faydapdf-py resident provider.

const axios = require("axios");
const crypto = require("crypto");
const { _esignet } = require("./server3AuthFlow");
const { toEthiopianDate } = require("./server5cards/etDate");
const { buildCards } = require("./server5cards");

const {
  getConfig, CookieJar, requestWithCookies, buildEsignetHeaders,
  initializeServerThreeSession, runEsignetAuthenticate, generatePkce,
  throwIfEsignetErrors
} = _esignet;

const JWT_RE = /^[\w-]+\.[\w-]*\.[\w-]+$/;

function residentConfig() {
  return {
    apiBase: (process.env.RESIDENT_API_BASE || "https://api-resident.fayda.et").replace(/\/+$/, ""),
    clientId: process.env.RESIDENT_CLIENT_ID || "ajcCvwQcVm1dAr6HaW4Y5ObnDmwPPTpH9oDaZSPPrpo",
    redirectUri: process.env.RESIDENT_REDIRECT_URI || "https://resident.fayda.et/callback",
    otpChannels: String(process.env.RESIDENT_OTP_CHANNELS || "PHONE")
      .split(",").map((s) => s.trim()).filter(Boolean),
    timeoutMs: Math.max(35000, Number(process.env.RESIDENT_TIMEOUT_S || 45) * 1000)
  };
}

const hex = (n) => crypto.randomBytes(n).toString("hex");

// Accepts a bare base64, a whole "Basic <base64>", or plain "resident:<secret>".
function normalizeBasic(value) {
  let v = String(value || "").trim();
  if (v.slice(0, 6).toLowerCase() === "basic ") v = v.slice(6).trim();
  if (v.includes(":") && !v.endsWith("=")) v = Buffer.from(v).toString("base64");
  return v;
}

function residentHeaders(basic, idToken) {
  const h = { "Content-Type": "application/json", Authorization: `Basic ${basic}` };
  if (idToken) h["X-Authorization"] = `Bearer ${idToken}`;
  return h;
}

// ── Phase 1: resident authorize URL (built locally) ───────────────────────────
function buildResidentAuthorizeUrl(codeChallenge, nonce, state) {
  const rc = residentConfig();
  const q = new URLSearchParams({
    client_id: rc.clientId,
    redirect_uri: rc.redirectUri,
    response_type: "code",
    scope: "openid profile email",
    acr_values: "mosip:idp:acr:generated-code",
    claims: '{"userinfo":{"individual_id":{"essential":true}}}',
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    display: "page",
    nonce,
    state,
    claims_locales: "en am",
    ui_locales: "en"
  });
  return `${getConfig().esignetBase}/authorize?${q.toString()}`;
}

// ── Phase 5: exchangeAutheCode → id_token ─────────────────────────────────────
async function exchangeAutheCode(code, authSession, basic) {
  const rc = residentConfig();
  const body = {
    code,
    code_verifier: authSession.pkceVerifier,
    redirect_uri: rc.redirectUri,
    client_id: rc.clientId,
    nonce: authSession.nonce,
    state: authSession.state
  };
  const res = await axios.post(`${rc.apiBase}/esignet/exchangeAutheCode`, body, {
    headers: residentHeaders(basic),
    timeout: getConfig().timeoutMs,
    validateStatus: () => true,
    responseType: "text",
    transformResponse: [(d) => d]
  });
  const text = String(res.data == null ? "" : res.data).trim().replace(/^"|"$/g, "");
  if (!JWT_RE.test(text)) {
    const snippet = text.replace(/\s+/g, " ").slice(0, 140);
    throw new Error(`exchangeAutheCode returned no JWT (HTTP ${res.status}): ${snippet}`);
  }
  return text;
}

// ── Phase 6: exchangeResident → identity JSON (~3 MB) ─────────────────────────
async function exchangeResident(idToken, basic) {
  const rc = residentConfig();
  const body = { headers: { "Content-Type": "application/json" } };
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await axios.post(`${rc.apiBase}/esignet/exchangeResident`, body, {
        headers: residentHeaders(basic, idToken),
        timeout: rc.timeoutMs,
        validateStatus: () => true,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });
      if (res.status >= 500) { last = new Error(`exchangeResident HTTP ${res.status}`); throw last; }
      if (res.status !== 200) throw new Error(`exchangeResident HTTP ${res.status}`);
      return res.data;
    } catch (e) {
      last = e;
      const retryable = ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT"].includes(e.code)
        || /HTTP 5/.test(String(e.message || ""));
      if (attempt >= 3 || !retryable) break;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  throw last || new Error("exchangeResident failed");
}

// ── transform: resident response → flat pdfData ───────────────────────────────
function lang(value, want) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object"
        && String(item.language || "").toLowerCase().startsWith(want.slice(0, 3))) {
        return String(item.value || "").trim();
      }
    }
    return "";
  }
  return String(value == null ? "" : value).trim();
}

function identityOf(resp) {
  const paths = [["data", "identity"], ["identity"], ["data", "data", "identity"], ["response", "identity"]];
  for (const path of paths) {
    let cur = resp;
    for (const k of path) { cur = (cur && typeof cur === "object") ? cur[k] : undefined; if (cur == null) break; }
    if (cur && typeof cur === "object" && Object.keys(cur).length) return cur;
  }
  return (resp && typeof resp.data === "object") ? resp.data : {};
}

function photoOf(resp, ident) {
  const sources = [ident, resp, (resp && typeof resp.data === "object") ? resp.data : {}];
  for (const src of sources) {
    if (src && typeof src === "object") {
      for (const k of ["photo", "face", "image", "profileImage"]) {
        const v = src[k];
        if (typeof v === "string" && v.length > 256) return v.replace(/^data:image\/\w+;base64,/, "");
      }
    }
  }
  return "";
}

function toRecord(resp, fan) {
  const d = identityOf(resp);
  const g = (...keys) => { for (const k of keys) { const v = d[k]; if (v != null && v !== "") return v; } return ""; };
  const eng = (...keys) => lang(g(...keys), "eng");
  const amh = (...keys) => lang(g(...keys), "amh");
  const dob = String(g("dateOfBirth", "birthdate", "dob") || "").trim();
  const uin = String(g("UIN", "uin", "vid", "VID") || "").trim();
  return {
    fullName_eng: eng("fullName", "name"),
    fullName_amh: amh("fullName", "name"),
    gender_eng: eng("gender", "sex"),
    gender_amh: amh("gender", "sex"),
    dateOfBirth_eng: dob,
    dateOfBirth_et: toEthiopianDate(dob),
    citizenship_Eng: eng("nationality", "residenceStatus"),
    citizenship_amh: amh("nationality", "residenceStatus"),
    phone: String(g("phone", "phoneNumber") || "").trim(),
    region_eng: eng("region"), region_amh: amh("region"),
    zone_eng: eng("zone"), zone_amh: amh("zone"),
    woreda_eng: eng("woreda"), woreda_amh: amh("woreda"),
    fcn: fan || uin,
    fin: uin,
    photo: photoOf(resp, d)
  };
}

// The card generator uses its own field names (sex_*, dobGc, fan, nationality_*).
function cardDataOf(rec) {
  return {
    fullName_eng: rec.fullName_eng, fullName_amh: rec.fullName_amh,
    sex_eng: rec.gender_eng, sex_amh: rec.gender_amh,
    dobGc: rec.dateOfBirth_eng,
    fan: rec.fcn, fin: rec.fin,
    nationality_eng: rec.citizenship_Eng, nationality_amh: rec.citizenship_amh,
    region_eng: rec.region_eng, region_amh: rec.region_amh,
    zone_eng: rec.zone_eng, zone_amh: rec.zone_amh,
    woreda_eng: rec.woreda_eng, woreda_amh: rec.woreda_amh,
    phone: rec.phone, photo: rec.photo
  };
}

const b64 = (buf) => (buf ? Buffer.from(buf).toString("base64") : "");

// Fold the record + generated QR/cards into a Server-3/4-shaped verifyResponse.
function toVerifyResponse(rec, drawn) {
  return {
    user: {
      data: {
        fullName_eng: rec.fullName_eng,
        fullName_amh: rec.fullName_amh,
        dateOfBirth_eng: rec.dateOfBirth_eng,
        dateOfBirth_et: rec.dateOfBirth_et,
        gender_eng: rec.gender_eng,
        gender_amh: rec.gender_amh,
        citizenship_Eng: rec.citizenship_Eng,
        citizenship_amh: rec.citizenship_amh,
        phone: rec.phone,
        region_eng: rec.region_eng, region_amh: rec.region_amh,
        zone_eng: rec.zone_eng, zone_amh: rec.zone_amh,
        woreda_eng: rec.woreda_eng, woreda_amh: rec.woreda_amh,
        fcn: rec.fcn,
        fin: rec.fin,
        photo: rec.photo,
        QRCodes: drawn.qrPng ? b64(drawn.qrPng) : "",
        fronts: drawn.front ? b64(drawn.front) : "",
        backs: drawn.back ? b64(drawn.back) : ""
      }
    }
  };
}

// ── public API (mirrors sendServerThreeOtp / authenticateServerThreeOtp) ──────
async function sendServerFiveOtp(individualId, options = {}) {
  const debug = options.debug || null;
  const config = getConfig();
  const rc = residentConfig();
  const pkce = generatePkce();
  const state = hex(16);
  const nonce = hex(16);

  const authorizeUrl = buildResidentAuthorizeUrl(pkce.codeChallenge, nonce, state);
  const session = await initializeServerThreeSession(authorizeUrl, debug);

  const jar = new CookieJar(session.cookies);
  const client = axios.create({
    baseURL: config.esignetBase,
    timeout: config.timeoutMs,
    validateStatus: (status) => status >= 200 && status < 500
  });
  const response = await requestWithCookies(client, jar, {
    method: "POST",
    url: "/v1/esignet/authorization/send-otp",
    headers: buildEsignetHeaders(session),
    data: {
      requestTime: new Date().toISOString(),
      request: {
        transactionId: session.transactionId,
        individualId,
        otpChannels: rc.otpChannels,
        captchaToken: null
      }
    }
  }, debug, "esignet-send-otp");
  throwIfEsignetErrors(response.data, "Failed to send eSignet OTP.");

  session.cookies = jar.toJSON();
  session.pkceVerifier = pkce.codeVerifier;
  session.nonce = nonce;
  session.state = state;
  session.individualId = individualId;

  return {
    transactionId: session.transactionId,
    serverFiveAuthSession: session,
    maskedMobile: response.data?.response?.maskedMobile || null,
    maskedEmail: response.data?.response?.maskedEmail || null
  };
}

async function authenticateServerFiveOtp({ otp, individualId, authSession, basicAuth, qrGen = "data", debug = null }) {
  const basic = normalizeBasic(basicAuth);
  if (!basic) {
    const e = new Error("Server 5 is not configured (RESIDENT_BASIC_AUTH).");
    e.statusCode = 503;
    e.publicMessage = "This download option is temporarily unavailable.";
    throw e;
  }
  const { codePayload } = await runEsignetAuthenticate({ otp, individualId, authSession, debug });
  const idToken = await exchangeAutheCode(codePayload.code, authSession, basic);
  const resp = await exchangeResident(idToken, basic);
  const rec = toRecord(resp, individualId);
  if (!(rec.fullName_eng || rec.fullName_amh || rec.fcn)) {
    throw new Error("Could not retrieve Fayda data. Please try again.");
  }
  const drawn = await buildCards({ cardData: cardDataOf(rec), qrGen });
  return toVerifyResponse(rec, drawn);
}

module.exports = {
  sendServerFiveOtp,
  authenticateServerFiveOtp,
  // exported for tests
  toRecord,
  cardDataOf,
  toVerifyResponse,
  normalizeBasic
};
