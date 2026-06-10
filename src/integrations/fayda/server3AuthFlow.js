const axios = require("axios");
const https = require("https");
const crypto = require("crypto");

const DEFAULT_FAYDA_API_BASE = "https://fayda-app-backend.fayda.et";
const DEFAULT_ESIGNET_BASE = "https://auth.fayda.et";
const DEFAULT_API_KEY = "ndC5mYXlkYS5ldCAoT0lEQ19QQVJUTkVSKTCCASIwDQ";
const DEBUG_REDACT_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-xsrf-token",
  "oauth-details-hash",
  "oauth-details-key",
  "otp",
  "challenge",
  "code",
  "accessToken",
  "refreshToken",
  "token",
  "captchaToken",
  "individualId",
  "phone",
  "phoneNumber",
  "maskedMobile",
  "maskedEmail",
  "picture",
  "face"
]);

function getConfig() {
  return {
    faydaApiBase: process.env.FAYDA_API_BASE || process.env.NEW_FAYDA_API_BASE || DEFAULT_FAYDA_API_BASE,
    esignetBase: process.env.ESIGNET_BASE || process.env.FAYDA_ESIGNET_BASE || DEFAULT_ESIGNET_BASE,
    apiKey: process.env.FAYDA_API_KEY || DEFAULT_API_KEY,
    timeoutMs: Math.max(
      10_000,
      Number.parseInt(process.env.FAYDA_REQUEST_TIMEOUT_MS || process.env.REQUEST_TIMEOUT_MS || "60000", 10) || 60_000
    ),
    otpChannels: String(process.env.SERVER_THREE_OTP_CHANNELS || "email,phone")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    backendUseApiKey: String(process.env.SERVER_THREE_BACKEND_USE_API_KEY || "auto").trim().toLowerCase(),
    minimalBackendHeaders: String(process.env.SERVER_THREE_BACKEND_MINIMAL_HEADERS || "true").trim().toLowerCase() !== "false"
};
}

function backendNativeRequest(method, url, { headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method,
      headers
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let data = raw;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          // keep raw
        }
                const result = { status: res.statusCode || 0, statusText: res.statusMessage || "", headers: res.headers || {}, data };
        if (result.status >= 400) {
          const err = new Error(`Request failed with status code ${result.status}`);
          err.response = result;
          reject(err);
          return;
        }
        resolve(result);
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Backend request timeout after " + timeoutMs + "ms"));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}
class CookieJar {
  constructor(cookies = {}) {
    this.cookies = { ...cookies };
  }

  updateFromHeaders(headers = {}) {
    const setCookie = headers["set-cookie"] || headers["Set-Cookie"];
    const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const cookie of values) {
      const firstPart = String(cookie || "").split(";")[0];
      const separatorIndex = firstPart.indexOf("=");
      if (separatorIndex <= 0) continue;
      const name = firstPart.slice(0, separatorIndex).trim();
      const value = firstPart.slice(separatorIndex + 1).trim();
      if (name) this.cookies[name] = value;
    }
  }

  header() {
    return Object.entries(this.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  get(name) {
    return this.cookies[name] || "";
  }

  set(name, value) {
    const key = String(name || "").trim();
    if (!key) return;
    this.cookies[key] = String(value || "");
  }
  toJSON() {
    return { ...this.cookies };
  }
}

function buildBackendHeaders(apiKey, minimal = false) {
  const headers = minimal
    ? { "Content-Type": "application/json" }
    : { accept: "application/json, text/plain, */*", "Content-Type": "application/json" };

  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  return headers;
}
function buildBrowserHeaders(extra = {}) {
  const base = process.env.ESIGNET_BASE || process.env.FAYDA_ESIGNET_BASE || DEFAULT_ESIGNET_BASE;
  return {
    accept: "application/json, text/plain, */*",
    origin: base,
    referer: `${base}/login?state=fayda-app`,
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    ...extra
  };
}

function isDebugRedactionEnabled(debug) {
  if (!debug) return true;
  if (Array.isArray(debug)) return true;
  return debug.redact !== false;
}

function getDebugEvents(debug) {
  if (!debug) return null;
  if (Array.isArray(debug)) return debug;
  return Array.isArray(debug.events) ? debug.events : null;
}

function shouldRedactKey(key) {
  const normalized = String(key || "").trim();
  return DEBUG_REDACT_KEYS.has(normalized) || DEBUG_REDACT_KEYS.has(normalized.toLowerCase());
}

function redactValue(value) {
  if (value === null || value === undefined || value === "") return value;
  const text = String(value);
  if (text.length <= 8) return "<redacted>";
  return `${text.slice(0, 4)}...${text.slice(-4)}<redacted>`;
}

function sanitizeForDebug(value, debug) {
  if (!isDebugRedactionEnabled(debug)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDebug(item, debug));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = shouldRedactKey(key) ? redactValue(item) : sanitizeForDebug(item, debug);
    }
    return output;
  }
  return value;
}

function pushDebug(debug, event) {
  const events = getDebugEvents(debug);
  if (!events) return;
  events.push({
    at: new Date().toISOString(),
    ...sanitizeForDebug(event, debug)
  });
}

function buildRequestUrl(client, url) {
  if (/^https?:\/\//i.test(String(url || ""))) return url;
  const baseURL = String(client?.defaults?.baseURL || "").replace(/\/+$/, "");
  const path = String(url || "").startsWith("/") ? url : `/${url || ""}`;
  return `${baseURL}${path}`;
}

async function axiosRequestWithDebug(config, debug, label) {
  pushDebug(debug, {
    type: "request",
    label,
    request: {
      method: String(config.method || "GET").toUpperCase(),
      url: config.url,
      headers: config.headers || {},
      data: config.data || null
    }
  });

  try {
    const response = await axios.request(config);
    pushDebug(debug, {
      type: "response",
      label,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers || {},
        data: response.data
      }
    });
    return response;
  } catch (error) {
    pushDebug(debug, {
      type: "error",
      label,
      error: {
        message: error?.message || String(error),
        code: error?.code || null,
        response: error?.response
          ? {
              status: error.response.status,
              statusText: error.response.statusText,
              headers: error.response.headers || {},
              data: error.response.data
            }
          : null
      }
    });
    throw error;
  }
}

async function requestWithCookies(client, jar, config, debug, label = "request") {
  const headers = { ...(config.headers || {}) };
  const cookieHeader = jar.header();
  if (cookieHeader) headers.Cookie = cookieHeader;

  pushDebug(debug, {
    type: "request",
    label,
    request: {
      method: String(config.method || "GET").toUpperCase(),
      url: buildRequestUrl(client, config.url),
      headers,
      data: config.data || null
    },
    cookiesBefore: jar.toJSON()
  });

  try {
    const response = await client.request({
      ...config,
      headers
    });
    jar.updateFromHeaders(response.headers);
    pushDebug(debug, {
      type: "response",
      label,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers || {},
        data: response.data
      },
      cookiesAfter: jar.toJSON()
    });
    return response;
  } catch (error) {
    pushDebug(debug, {
      type: "error",
      label,
      error: {
        message: error?.message || String(error),
        code: error?.code || null,
        response: error?.response
          ? {
              status: error.response.status,
              statusText: error.response.statusText,
              headers: error.response.headers || {},
              data: error.response.data
            }
          : null
      },
      cookiesAfter: jar.toJSON()
    });
    throw error;
  }
}

function getResponsePayload(data) {
  return data?.response || data?.data?.response || data?.data || data;
}

function throwIfEsignetErrors(data, fallbackMessage) {
  const errors = data?.errors || data?.data?.errors || [];
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] || {};
    const message = first.errorMessage || first.message || first.errorCode || fallbackMessage;
    const error = new Error(message || fallbackMessage);
    error.esignetErrors = errors;
    throw error;
  }
}

function extractAuthorizeUrl(responseData) {
  const value = responseData?.data || responseData?.url || responseData?.authUrl || responseData;
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
    throw new Error("Fayda authorize endpoint did not return an auth URL.");
  }
  return value;
}

function rewriteAuthorizeUrl(authorizeUrl, debug = null) {
  const overrideClientId = String(process.env.SERVER_THREE_FORCE_CLIENT_ID || "").trim();
  if (!overrideClientId) {
    return authorizeUrl;
  }

  const url = new URL(authorizeUrl);
  const before = url.searchParams.get("client_id") || "";
  url.searchParams.set("client_id", overrideClientId);

  pushDebug(debug, {
    type: "info",
    label: "authorize-url-rewrite",
    before: { clientId: before || null },
    after: { clientId: overrideClientId }
  });

  return url.toString();
}
function parseOptionalJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Could not parse authorize claims JSON: ${error.message}`);
  }
}

function buildOauthDetailsRequest(authorizeUrl) {
  const url = new URL(authorizeUrl);
  const params = url.searchParams;
  return {
    nonce: params.get("nonce"),
    state: params.get("state"),
    clientId: params.get("client_id"),
    redirectUri: params.get("redirect_uri"),
    responseType: params.get("response_type"),
    scope: params.get("scope"),
    acrValues: params.get("acr_values"),
    claims: parseOptionalJson(params.get("claims")),
    claimsLocales: params.get("claims_locales"),
    display: params.get("display"),
    maxAge: params.get("max_age"),
    prompt: params.get("prompt"),
    uiLocales: params.get("ui_locales"),
    codeChallenge: params.get("code_challenge"),
    codeChallengeMethod: params.get("code_challenge_method")
  };
}

function base64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function hashOauthDetails(oauthDetails) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(oauthDetails)).digest();
  return base64Url(digest);
}

// --- Server 4 (Fayda app v1.1.9) helpers -------------------------------------
// v1.1.9 differs from Server 3 in two ways only: (1) Phase 1 (authorize) and
// Phase 3 (callback) carry an X-Firebase-AppCheck token, and (2) Phase 1 sends
// a client-generated PKCE codeChallenge so Phase 3 can POST { code, codeVerifier,
// state } to the callback. The eSignet middle (csrf -> oauth-details -> send-otp
// -> authenticate -> auth-code) is identical and reused verbatim.
function generatePkce() {
  const codeVerifier = base64Url(crypto.randomBytes(96));
  const codeChallenge = base64Url(crypto.createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge, codeChallengeMethod: "S256" };
}

function randomState() {
  return `${base64Url(crypto.randomBytes(18))}.${base64Url(crypto.randomBytes(6))}`;
}

function resolveServer4AppCheck(appCheckToken) {
  return String(appCheckToken || process.env.SERVER4_APPCHECK_TOKEN || "").trim();
}

function getXsrfToken(jar, csrfResponseData) {
  return (
    jar.get("XSRF-TOKEN") ||
    csrfResponseData?.token ||
    csrfResponseData?.csrfToken ||
    csrfResponseData?.response?.token ||
    ""
  );
}

function buildEsignetHeaders(session, extra = {}) {
  return buildBrowserHeaders({
    "Content-Type": "application/json",
    "X-XSRF-TOKEN": session.xsrfToken,
    "oauth-details-hash": session.oauthDetailsHash,
    "oauth-details-key": session.transactionId,
    ...extra
  });
}

async function getServerThreeAuthorizeUrl(debug = null) {
  const config = getConfig();

  const headersNoKey = buildBackendHeaders(null, config.minimalBackendHeaders);
  const headersWithKey = buildBackendHeaders(config.apiKey, config.minimalBackendHeaders);

  const mode = config.backendUseApiKey;
  const attempts = [];

  if (mode === "never") {
    attempts.push({ label: "fayda-authorize", headers: headersNoKey });
  } else if (mode === "always") {
    attempts.push({ label: "fayda-authorize", headers: headersWithKey });
  } else {
    // auto: mimic the mobile app first (no x-api-key), then fallback to key.
    attempts.push({ label: "fayda-authorize", headers: headersNoKey });
    attempts.push({ label: "fayda-authorize", headers: headersWithKey });
  }

  let lastError = null;
  for (const attempt of attempts) {
    const url = config.faydaApiBase + "/api/v2/auth/authorize";
    try {
      pushDebug(debug, {
        type: "request",
        label: attempt.label,
        request: {
          method: "GET",
          url,
          headers: attempt.headers,
          data: null
        }
      });

      const response = await backendNativeRequest("GET", url, {
        headers: attempt.headers,
        timeoutMs: config.timeoutMs
      });

      pushDebug(debug, {
        type: "response",
        label: attempt.label,
        response: {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers || {},
          data: response.data
        }
      });

      return rewriteAuthorizeUrl(extractAuthorizeUrl(response.data), debug);
    } catch (error) {
      lastError = error;
      // native helper doesn't shape axios errors; only retry on generic errors.
    }
  }

  throw lastError || new Error("Fayda authorize request failed.");
}
async function initializeServerThreeSession(authorizeUrl, debug = null) {
  const config = getConfig();
  const jar = new CookieJar();
  const authUrl = new URL(authorizeUrl);
  const client = axios.create({
    baseURL: config.esignetBase,
    timeout: config.timeoutMs,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400
  });

  await requestWithCookies(client, jar, {
    method: "GET",
    url: `${authUrl.pathname}${authUrl.search}`,
    headers: buildBrowserHeaders({
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    })
  }, debug, "esignet-authorize-page");

  const csrfResponse = await requestWithCookies(client, jar, {
    method: "GET",
    url: "/v1/esignet/csrf/token",
    headers: buildBrowserHeaders({ "Content-Type": "application/json", referer: authorizeUrl })
  }, debug, "esignet-csrf-token");

  const xsrfToken = getXsrfToken(jar, csrfResponse.data);
  if (xsrfToken && !jar.get("XSRF-TOKEN")) {
    jar.set("XSRF-TOKEN", xsrfToken);
  }
  if (!xsrfToken) {
    throw new Error("eSignet CSRF token was not returned.");
  }

  const oauthDetailsRequest = {
    requestTime: new Date().toISOString(),
    request: buildOauthDetailsRequest(authorizeUrl)
  };
  const oauthResponse = await requestWithCookies(client, jar, {
    method: "POST",
    url: "/v1/esignet/authorization/v2/oauth-details",
    headers: buildBrowserHeaders({
      "Content-Type": "application/json",
      "X-XSRF-TOKEN": xsrfToken,
      referer: authorizeUrl
    }),
    data: oauthDetailsRequest
  }, debug, "esignet-oauth-details");
  throwIfEsignetErrors(oauthResponse.data, "Failed to initialize eSignet OAuth details.");

  const oauthDetails = getResponsePayload(oauthResponse.data);
  if (!oauthDetails?.transactionId) {
    throw new Error("eSignet OAuth details did not return a transactionId.");
  }

  return {
    authorizeUrl,
    cookies: jar.toJSON(),
    xsrfToken,
    oauthDetails,
    oauthDetailsHash: hashOauthDetails(oauthDetails),
    transactionId: oauthDetails.transactionId
  };
}

async function sendServerThreeOtp(individualId, options = {}) {
  const debug = options.debug || options.debugEvents || null;
  const config = getConfig();
  const authorizeUrl = await getServerThreeAuthorizeUrl(debug);
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
        otpChannels: config.otpChannels,
        captchaToken: null
      }
    }
  }, debug, "esignet-send-otp");
  throwIfEsignetErrors(response.data, "Failed to send eSignet OTP.");

  session.cookies = jar.toJSON();
  // Extract maskedMobile so the bot can show "OTP sent to ******1234".
  const maskedMobile = response.data?.response?.maskedMobile || null;
  const maskedEmail = response.data?.response?.maskedEmail || null;
  return {
    transactionId: session.transactionId,
    serverThreeAuthSession: session,
    sendOtpResponse: response.data,
    maskedMobile,
    maskedEmail
  };
}

// Shared eSignet authenticate + auth-code step (identical for Server 3 and 4).
// Returns the auth-code payload (with the authorization `code`) plus the
// authenticate payload (for consentAction). Phase 3 (callback) is server-specific.
async function runEsignetAuthenticate({ otp, individualId, authSession, debug = null }) {
  if (!authSession?.transactionId) {
    throw new Error("Missing eSignet auth session. Resend OTP and try again.");
  }

  const config = getConfig();
  const jar = new CookieJar(authSession.cookies);
  const client = axios.create({
    baseURL: config.esignetBase,
    timeout: config.timeoutMs,
    validateStatus: (status) => status >= 200 && status < 500
  });

  const authResponse = await requestWithCookies(client, jar, {
    method: "POST",
    url: "/v1/esignet/authorization/v2/authenticate",
    headers: buildEsignetHeaders(authSession),
    data: {
      requestTime: new Date().toISOString(),
      request: {
        transactionId: authSession.transactionId,
        individualId,
        challengeList: [
          {
            authFactorType: "OTP",
            challenge: otp,
            format: "alpha-numeric"
          }
        ]
      }
    }
  }, debug, "esignet-authenticate-otp");
  throwIfEsignetErrors(authResponse.data, "eSignet OTP authentication failed.");

  const authPayload = getResponsePayload(authResponse.data);

  const consentAction = String(authPayload?.consentAction || "").toUpperCase();
  const oauthDetails = authSession.oauthDetails || {};

  const acceptedClaims = [];
  const permittedAuthorizeScopes = [];

  // Some sessions return consentAction=NOCAPTURE but still require acceptedClaims.
  // We use oauth-details to decide which claims/scopes are valid.
  const essentialClaims = Array.isArray(oauthDetails.essentialClaims) ? oauthDetails.essentialClaims : [];
  const voluntaryClaims = Array.isArray(oauthDetails.voluntaryClaims) ? oauthDetails.voluntaryClaims : [];
  const authorizeScopes = Array.isArray(oauthDetails.authorizeScopes) ? oauthDetails.authorizeScopes : [];

  const includeVoluntaryClaims = String(process.env.SERVER_THREE_ACCEPT_VOLUNTARY_CLAIMS || "true")
    .trim()
    .toLowerCase() !== "false";

  const includeAuthorizeScopes = String(process.env.SERVER_THREE_ACCEPT_AUTHORIZE_SCOPES || "false")
    .trim()
    .toLowerCase() === "true";

  const shouldIncludeClaims = consentAction === "CAPTURE" || consentAction === "NOCAPTURE" || !consentAction;
  if (shouldIncludeClaims) {
    acceptedClaims.push(...essentialClaims);
    if (includeVoluntaryClaims) acceptedClaims.push(...voluntaryClaims);
    if (includeAuthorizeScopes) permittedAuthorizeScopes.push(...authorizeScopes);
  }

  pushDebug(debug, {
    type: "info",
    label: "auth-code-claims",
    consentAction: consentAction || null,
    acceptedClaimsCount: acceptedClaims.filter(Boolean).length,
    permittedAuthorizeScopesCount: permittedAuthorizeScopes.filter(Boolean).length
  });

  const uniqueAcceptedClaims = [...new Set(acceptedClaims.filter(Boolean).map((v) => String(v)))];
  const uniquePermittedScopes = [...new Set(permittedAuthorizeScopes.filter(Boolean).map((v) => String(v)))];

  const codeResponse = await requestWithCookies(client, jar, {
    method: "POST",
    url: "/v1/esignet/authorization/auth-code",
    headers: buildEsignetHeaders(authSession),
    data: {
      requestTime: new Date().toISOString(),
      request: {
        transactionId: authSession.transactionId,
        acceptedClaims: uniqueAcceptedClaims,
        permittedAuthorizeScopes: uniquePermittedScopes
      }
    }
  }, debug, "esignet-auth-code");
  throwIfEsignetErrors(codeResponse.data, "eSignet auth-code request failed.");

  const codePayload = getResponsePayload(codeResponse.data);
  if (!codePayload?.code) {
    throw new Error("eSignet did not return an authorization code.");
  }

  return { codePayload, authPayload };
}

async function authenticateServerThreeOtp({ otp, individualId, authSession, debug = null }) {
  const { codePayload, authPayload } = await runEsignetAuthenticate({ otp, individualId, authSession, debug });
  const callbackResponse = await exchangeServerThreeAuthorizationCode(codePayload.code, debug);
  return {
    ...callbackResponse,
    serverThree: {
      transactionId: authSession.transactionId,
      consentAction: authPayload?.consentAction || null,
      state: codePayload?.state || null,
      redirectUri: codePayload?.redirectUri || null
    }
  };
}

async function exchangeServerThreeAuthorizationCode(code, debug = null) {
  const config = getConfig();
  const encodedCode = encodeURIComponent(code);

  const endpoints = [
    config.faydaApiBase + "/auth/callback?code=" + encodedCode,
    config.faydaApiBase + "/api/v2/auth/callback?code=" + encodedCode
  ];

  const headersNoKey = buildBackendHeaders(null, config.minimalBackendHeaders);
  const headersWithKey = buildBackendHeaders(config.apiKey, config.minimalBackendHeaders);

  const mode = config.backendUseApiKey;
  const headerAttempts = [];

  if (mode === "never") {
    headerAttempts.push({ name: "no-key", headers: headersNoKey });
  } else if (mode === "always") {
    headerAttempts.push({ name: "with-key", headers: headersWithKey });
  } else {
    // auto: mimic the mobile app first (no x-api-key), then try with key.
    headerAttempts.push({ name: "no-key", headers: headersNoKey });
    headerAttempts.push({ name: "with-key", headers: headersWithKey });
  }

  let lastError = null;

  for (const url of endpoints) {
    for (const attempt of headerAttempts) {
      const headers = attempt.headers;
      try {
        pushDebug(debug, {
          type: "request",
          label: "fayda-callback-exchange",
          request: {
            method: "POST",
            url,
            headers,
            data: {}
          },
          attempt: attempt.name
        });

        const response = await backendNativeRequest('POST', url, { headers, body: '{}', timeoutMs: config.timeoutMs });

        pushDebug(debug, {
          type: "response",
          label: "fayda-callback-exchange",
          response: {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers || {},
            data: response.data
          },
          attempt: attempt.name
        });

        return response.data;
      } catch (error) {
        lastError = error;

        pushDebug(debug, {
          type: "error",
          label: "fayda-callback-exchange",
          request: {
            method: "POST",
            url,
            headers,
            data: {}
          },
          attempt: attempt.name,
          error: {
            message: error?.message || String(error),
            code: error?.code || null,
            response: error?.response
              ? {
                  status: error.response.status,
                  statusText: error.response.statusText,
                  headers: error.response.headers || {},
                  data: error.response.data
                }
              : null
          }
        });

        const status = error?.response?.status;
        if (status && status !== 404 && status !== 405) {
          if (mode === "auto") {
            // try the next header attempt (no-key/with-key)
            continue;
          }
          throw error;
        }
      }
    }
  }

  throw lastError || new Error("Fayda callback exchange failed.");
}
// --- Server 4 (Fayda app v1.1.9): Phase 1 authorize + Phase 3 callback --------

// Phase 1 (v1.1.9): client generates PKCE + state, then
//   GET /api/v2/auth/authorize?codeChallenge=<S256>&state=<random>
//   headers: x-firebase-appcheck: <device token>
// -> returns the eSignet /authorize?client_id=... link. We then rewrite that
// link's code_challenge / code_challenge_method / state to OUR generated values
// so oauth-details (which reads them off the URL) matches OUR verifier at the
// Phase 3 callback. If App Check is missing/invalid the GET 401s, so we fall
// back to the Server-3 legacy authorize (backend PKCE, legacy ?code= callback).
async function getServerFourAuthorizeUrl({ appCheckToken = null, debug = null } = {}) {
  const config = getConfig();
  const pkce = generatePkce();
  const state = randomState();
  const url =
    config.faydaApiBase +
    "/api/v2/auth/authorize" +
    `?codeChallenge=${encodeURIComponent(pkce.codeChallenge)}` +
    `&state=${encodeURIComponent(state)}`;

  const headers = buildBackendHeaders(
    config.backendUseApiKey === "never" ? null : config.apiKey,
    config.minimalBackendHeaders
  );
  const tok = resolveServer4AppCheck(appCheckToken);
  if (tok) headers["X-Firebase-AppCheck"] = tok;

  try {
    pushDebug(debug, {
      type: "request",
      label: "server4-authorize-v119",
      request: { method: "GET", url, headers, data: null }
    });
    const response = await backendNativeRequest("GET", url, { headers, timeoutMs: config.timeoutMs });
    pushDebug(debug, {
      type: "response",
      label: "server4-authorize-v119",
      response: { status: response.status, statusText: response.statusText, headers: response.headers || {}, data: response.data }
    });

    let authorizeUrl = rewriteAuthorizeUrl(extractAuthorizeUrl(response.data), debug);
    // Force OUR PKCE challenge + state onto the returned link (mirrors bothfile.js).
    try {
      const parsed = new URL(authorizeUrl);
      parsed.searchParams.set("code_challenge", pkce.codeChallenge);
      parsed.searchParams.set("code_challenge_method", "S256");
      parsed.searchParams.set("state", state);
      authorizeUrl = parsed.toString();
    } catch (_) {
      // keep the raw URL if it is not parseable
    }
    return { authorizeUrl, pkce, state, mode: "v119" };
  } catch (error) {
    pushDebug(debug, {
      type: "info",
      label: "server4-authorize-fallback",
      note: "v1.1.9 GET authorize failed (likely App Check enforced/expired); falling back to Server-3 authorize",
      error: error?.message || String(error)
    });
    const authorizeUrl = await getServerThreeAuthorizeUrl(debug);
    return { authorizeUrl, pkce: null, state: null, mode: "legacy" };
  }
}

// Phase 3 (v1.1.9): POST /api/v2/auth/callback  body { code, codeVerifier, state }
// headers: x-firebase-appcheck: <device token>. Returns the raw callback JSON
// (same { accessToken, userData, ... } shape the PDF pipeline consumes).
async function exchangeServerFourCallback({ code, codeVerifier = null, state = null, appCheckToken = null, debug = null }) {
  if (!code) throw new Error("Missing authorization code for Server 4 callback.");
  const config = getConfig();
  const url = config.faydaApiBase + "/api/v2/auth/callback";
  const headers = buildBackendHeaders(
    config.backendUseApiKey === "never" ? null : config.apiKey,
    config.minimalBackendHeaders
  );
  const tok = resolveServer4AppCheck(appCheckToken);
  if (tok) headers["X-Firebase-AppCheck"] = tok;

  const body = JSON.stringify({ code, codeVerifier, state });
  pushDebug(debug, {
    type: "request",
    label: "server4-callback-body",
    request: { method: "POST", url, headers, data: { code, codeVerifier, state } }
  });
  try {
    const response = await backendNativeRequest("POST", url, { headers, body, timeoutMs: config.timeoutMs });
    pushDebug(debug, {
      type: "response",
      label: "server4-callback-body",
      response: { status: response.status, statusText: response.statusText, headers: response.headers || {}, data: response.data }
    });
    return response.data;
  } catch (error) {
    pushDebug(debug, {
      type: "error",
      label: "server4-callback-body",
      error: {
        message: error?.message || String(error),
        code: error?.code || null,
        response: error?.response
          ? { status: error.response.status, statusText: error.response.statusText, headers: error.response.headers || {}, data: error.response.data }
          : null
      }
    });
    throw error;
  }
}

async function sendServerFourOtp(individualId, options = {}) {
  const debug = options.debug || options.debugEvents || null;
  const appCheckToken = options.appCheckToken || null;
  const config = getConfig();

  const authorize = await getServerFourAuthorizeUrl({ appCheckToken, debug });
  const session = await initializeServerThreeSession(authorize.authorizeUrl, debug);
  // Carry the v1.1.9 PKCE + state + token through to the Phase 3 callback.
  session.pkce = authorize.pkce || null;
  session.callbackState = authorize.state || null;
  session.callbackMode = authorize.mode === "v119" ? "body" : "legacy";
  session.appCheckToken = appCheckToken || null;

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
        otpChannels: config.otpChannels,
        captchaToken: null
      }
    }
  }, debug, "esignet-send-otp");
  throwIfEsignetErrors(response.data, "Failed to send eSignet OTP.");

  session.cookies = jar.toJSON();
  const maskedMobile = response.data?.response?.maskedMobile || null;
  const maskedEmail = response.data?.response?.maskedEmail || null;
  return {
    transactionId: session.transactionId,
    serverFourAuthSession: session,
    sendOtpResponse: response.data,
    maskedMobile,
    maskedEmail
  };
}

async function authenticateServerFourOtp({ otp, individualId, authSession, appCheckToken = null, debug = null }) {
  const { codePayload, authPayload } = await runEsignetAuthenticate({ otp, individualId, authSession, debug });

  const useBodyCallback = authSession.callbackMode !== "legacy" && authSession.pkce;
  const token = appCheckToken || authSession.appCheckToken || null;

  let callbackResponse;
  if (useBodyCallback) {
    callbackResponse = await exchangeServerFourCallback({
      code: codePayload.code,
      codeVerifier: authSession.pkce.codeVerifier,
      state: codePayload.state || authSession.callbackState || null,
      appCheckToken: token,
      debug
    });
  } else {
    // legacy fallback: Server-3 ?code= callback (backend-held PKCE)
    callbackResponse = await exchangeServerThreeAuthorizationCode(codePayload.code, debug);
  }

  return {
    ...callbackResponse,
    serverFour: {
      transactionId: authSession.transactionId,
      consentAction: authPayload?.consentAction || null,
      state: codePayload?.state || null,
      redirectUri: codePayload?.redirectUri || null,
      callbackMode: useBodyCallback ? "body" : "legacy"
    }
  };
}

module.exports = {
  sendServerThreeOtp,
  authenticateServerThreeOtp,
  exchangeServerThreeAuthorizationCode,
  sendServerFourOtp,
  authenticateServerFourOtp,
  exchangeServerFourCallback
};



















