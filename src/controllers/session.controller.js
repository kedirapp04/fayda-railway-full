const env = require("../config/env");
const {
  sendServerThreeOtp,
  authenticateServerThreeOtp,
  sendServerFourOtp,
  authenticateServerFourOtp
} = require("../integrations/fayda/server3AuthFlow");
const { takeFreshAppCheckToken } = require("../services/server4TokenUpdater");
const { createSession, getSession, deleteSession } = require("../services/otpSession.service");
const { maskFan } = require("../utils/crypto");
const store = require("../services/store.service");
const { generateDigitalIdPdf, sanitizeVerifyResponse } = require("../integrations/fayda/pdfGenerator");
const { buildServerOneScreenshotAssets } = require("../integrations/fayda/screenshotGenerator");

const FORMATS = ["pdf", "screenshot", "json", "pdf_json"];
// Friendly aliases for the combined PDF+JSON format → canonical "pdf_json".
const FORMAT_ALIASES = {
  json_pdf: "pdf_json",
  jsonpdf: "pdf_json",
  pdfjson: "pdf_json",
  "pdf+json": "pdf_json",
  "json+pdf": "pdf_json",
  both: "pdf_json",
  all: "pdf_json"
};

// Image keys live in their own response fields; everything else goes under `data`.
const JSON_IMG_KEYS = ["photo", "QRCodes", "qrCodes", "qrCode", "fronts", "front", "backs", "back"];

// The Server-4 token pool is "configured" once a CSRF is set (stored by an admin,
// or SERVER4_TOKEN_API_CSRF in .env). When it is, every gated request takes a
// FRESH single-use token from the pool (App Check tokens are single-use — reuse →
// APP_CHECK_REPLAY). The CSRF is read from the store per request (rotatable).
function server4MinSeconds() {
  return Number(process.env.SERVER4_TOKEN_MIN_SECONDS || 90);
}
// Build a takeToken() the auth flow calls right before each gated request.
// Returns null when the pool CSRF is unset. Pool-only, NO fallback: if the pool
// is empty/unreachable it THROWS (poolUnavailable) so the request fails cleanly —
// it never silently drops to Server 3 or reuses a dead token.
// `purpose` (authorize|callback) tags the take for the Tokens dashboard.
function makeServer4TokenTaker(csrf, purpose) {
  if (!String(csrf || "").trim()) return null;
  return async () => {
    const t = await takeFreshAppCheckToken(server4MinSeconds(), "", { csrfToken: csrf, purpose });
    if (!t) {
      const e = new Error("Server 4 token pool is empty or unreachable.");
      e.poolUnavailable = true; // → friendly 503, no Server-3 fallback
      throw e;
    }
    return t;
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.statusCode = status;
  err.publicMessage = message;
  return err;
}

// Normalise upstream/axios errors into a public-facing statusCode + message.
function wrapUpstream(error, fallback) {
  const status = error?.response?.status;
  const raw = String(
    error?.response?.data?.error ||
    error?.response?.data?.message ||
    error?.message ||
    fallback
  );
  // Never leak upstream/dev internals (App Check / Firebase / token) to API
  // users — show a friendly, retryable message. The real detail stays in logs.
  if (error?.appCheckRejected || error?.poolUnavailable || /app[\s_-]?check|firebase|APP_CHECK/i.test(raw)) {
    const e = new Error("Verification service is temporarily unavailable. Please try again in a few minutes.");
    e.statusCode = 503;
    e.publicMessage = e.message;
    return e;
  }
  const e = new Error(raw);
  e.statusCode = status && status >= 400 && status < 600 ? status : 502;
  e.publicMessage = raw;
  return e;
}

// Make a value safe to embed in a Content-Disposition filename.
function safeFilename(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback || "fayda";
}

// Build the decoded-fields JSON payload. Shared by the `json` and `pdf_json`
// formats so both return the exact same id-data shape ("current style").
function buildJsonPayload(cleanResponse, pdfData, fallbackName) {
  const raw = cleanResponse?.user?.data || cleanResponse?.data || {};
  const data = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!JSON_IMG_KEYS.includes(k)) data[k] = v;
  }
  return {
    name: safeFilename(pdfData.fullName_eng, fallbackName),
    data,
    photo: pdfData.photo || null,
    qr: pdfData.QRCodes || null,
    front: pdfData.fronts || null,
    back: pdfData.backs || null
  };
}

// POST /api/session  { individualId }
async function startSession(req, res, next) {
  try {
    const user = req.rentalUser;
    const key = req.rentalKey;

    const individualId = String(req.body?.individualId || req.body?.fan || "").trim();
    if (!/^\d{12,16}$/.test(individualId)) {
      throw httpError(400, "individualId must be a 12–16 digit FAN/FIN.");
    }

    // Don't send an OTP the user can't spend — pre-check billing/limits.
    const billing = await store.checkBilling(user, key);
    if (!billing.ok) throw httpError(429, billing.reason);

    // Server selection. Fayda enforces App Check on /api/v2/auth/authorize, and
    // tokens come only from the pool. So Server 4 is used when the pool CSRF is
    // configured (or explicitly requested); otherwise fall back to Server 3.
    const s4Csrf = await store.getServer4Csrf();
    const poolConfigured = Boolean(s4Csrf);
    const serverChoice = String(req.body?.server || "").toLowerCase().replace(/[\s._-]/g, "");
    const explicitS3 = ["server3", "3", "esignet", "v117"].includes(serverChoice);
    const explicitS4 = ["server4", "4", "v119", "faydaapp", "appcheck"].includes(serverChoice);
    const useServer4 = explicitS4 || (!explicitS3 && poolConfigured);

    let result;
    try {
      if (useServer4) {
        if (await store.getServer4Paused()) {
          throw httpError(503, "Service is paused for maintenance. Please try again shortly.");
        }
        if (!poolConfigured) {
          throw httpError(503, "Server 4 needs the token pool. A super-admin must set the pool CSRF with /server4csrf in the bot.");
        }
        // Fresh single-use token per request from the pool (pool-only, no static).
        result = await sendServerFourOtp(individualId, {
          takeToken: makeServer4TokenTaker(s4Csrf, "authorize")
        });
      } else {
        result = await sendServerThreeOtp(individualId);
      }
    } catch (error) {
      if (error.statusCode) throw error;
      throw wrapUpstream(error, `Failed to send OTP on ${useServer4 ? "Server 4" : "Server 3"}.`);
    }

    const sessionId = createSession({
      individualId,
      server: useServer4 ? "server4" : "server3",
      authSession: useServer4 ? result.serverFourAuthSession : result.serverThreeAuthSession
    });

    res.json({
      ok: true,
      sessionId,
      server: useServer4 ? "server4" : "server3",
      fan: maskFan(individualId),
      maskedMobile: result.maskedMobile || null,
      maskedEmail: result.maskedEmail || null,
      channels: env.SERVER_THREE_OTP_CHANNELS.split(",").map((c) => c.trim()).filter(Boolean)
    });
  } catch (error) {
    next(error);
  }
}

// POST /api/session/:id/verify  { otp, format }
// Verifies the OTP and renders the document IN-PROCESS (no encryption hop, no
// separate /generate call). One render per verify; the session is consumed.
async function verifyAndGenerate(req, res, next) {
  const user = req.rentalUser;
  const key = req.rentalKey;
  const ip = req.ip;
  const reqFormatRaw = String(req.body?.format || "pdf").toLowerCase().trim();
  const reqFormat = FORMAT_ALIASES[reqFormatRaw] || reqFormatRaw;
  const format = FORMATS.includes(reqFormat) ? reqFormat : "pdf";

  try {
    const sessionId = String(req.params.id || "");
    const otp = String(req.body?.otp || "").trim();
    if (!/^\d{4,10}$/.test(otp)) {
      throw httpError(400, "otp must be 4–10 digits.");
    }

    const session = getSession(sessionId);
    if (!session) {
      throw httpError(410, "Session expired or unknown. Restart with a fresh send-otp request.");
    }

    // Re-check billing before consuming the OTP (state may have changed).
    const billing = await store.checkBilling(user, key);
    if (!billing.ok) throw httpError(429, billing.reason);

    const isServer4 = session.server === "server4";
    // Maintenance pause — thrown here (outside the wrapUpstream inner catch) so
    // the 503 status/message reach the caller intact.
    if (isServer4 && (await store.getServer4Paused())) {
      throw httpError(503, "Service is paused for maintenance. Please try again shortly.");
    }
    let verifyResponse;
    try {
      const s4Csrf = isServer4 ? await store.getServer4Csrf() : "";
      verifyResponse = isServer4
        ? await authenticateServerFourOtp({
            otp,
            individualId: session.individualId,
            authSession: session.authSession,
            // The callback is where the token is actually spent — take a FRESH one.
            takeToken: makeServer4TokenTaker(s4Csrf, "callback")
          })
        : await authenticateServerThreeOtp({
            otp,
            individualId: session.individualId,
            authSession: session.authSession
          });
    } catch (error) {
      // OTP is single-use on the eSignet flow — drop the session so the caller restarts.
      deleteSession(sessionId);
      throw wrapUpstream(error, `Failed to verify OTP on ${isServer4 ? "Server 4" : "Server 3"}.`);
    }

    deleteSession(sessionId);

    const fallbackName = session.individualId || "fayda";

    // Charge + count exactly once, after a successful render.
    const finishCount = async (detail) => {
      await store.recordUsage({ userId: user.id, apiKeyId: key.id, format, success: true, ip, detail, counts: true });
      await store.chargeUsage(user, billing.price);
    };

    // ── JSON: decoded fields, no render ──
    if (format === "json") {
      const { pdfData, cleanResponse } = sanitizeVerifyResponse(verifyResponse);
      const payload = buildJsonPayload(cleanResponse, pdfData, fallbackName);
      await finishCount(payload.name);
      return res.json({ ok: true, format: "json", ...payload });
    }

    // ── PDF + JSON: decoded fields AND the rendered PDF (base64), one request ──
    // Same id-data shape as `json`, plus a `pdf` object carrying the rendered
    // document as base64. Counts/charges exactly once (one verify, one render).
    if (format === "pdf_json") {
      const { pdfBytes, pdfData, cleanResponse } = await generateDigitalIdPdf(verifyResponse);
      const payload = buildJsonPayload(cleanResponse, pdfData, fallbackName);
      const pdfBuffer = Buffer.from(pdfBytes);
      await finishCount(payload.name);
      return res.json({
        ok: true,
        format: "pdf_json",
        ...payload,
        pdf: {
          filename: `${payload.name}.pdf`,
          contentType: "application/pdf",
          base64: pdfBuffer.toString("base64")
        }
      });
    }

    // ── Screenshot: base64 images, all in memory ──
    if (format === "screenshot") {
      const result = await buildServerOneScreenshotAssets(verifyResponse, fallbackName);
      if (!result.assets.length) throw httpError(422, "No screenshot assets could be generated.");
      await finishCount(result.baseName);
      return res.json({
        ok: true,
        format,
        name: result.baseName,
        images: result.assets.map((a) => ({
          label: a.label,
          filename: a.filename,
          contentType: a.contentType,
          base64: a.buffer.toString("base64")
        }))
      });
    }

    // ── PDF: rendered straight to a Buffer (no temp file ever touches disk) ──
    const { pdfBytes, pdfData } = await generateDigitalIdPdf(verifyResponse);
    const personName = safeFilename(pdfData?.fullName_eng, fallbackName);
    await finishCount(personName);
    const pdfBuffer = Buffer.from(pdfBytes);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${personName}.pdf"`);
    res.setHeader("X-Person-Name", encodeURIComponent(personName));
    res.setHeader("X-Usage-Total", String(key.success_count + 1));
    res.setHeader("Access-Control-Expose-Headers", "X-Person-Name, X-Usage-Total, Content-Disposition");
    return res.send(pdfBuffer);
  } catch (error) {
    // Record the failed attempt (does not count toward limits).
    try {
      await store.recordUsage({
        userId: user.id, apiKeyId: key.id, format,
        success: false, ip, detail: (error && error.message) ? error.message.slice(0, 180) : "error"
      });
    } catch (_) {}
    next(error);
  }
}

module.exports = { startSession, verifyAndGenerate };
