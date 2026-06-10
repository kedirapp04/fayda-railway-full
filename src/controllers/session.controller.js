const env = require("../config/env");
const {
  sendServerThreeOtp,
  authenticateServerThreeOtp,
  sendServerFourOtp,
  authenticateServerFourOtp
} = require("../integrations/fayda/server3AuthFlow");
const { createSession, getSession, deleteSession } = require("../services/otpSession.service");
const { maskFan } = require("../utils/crypto");
const store = require("../services/store.service");
const { generateDigitalIdPdf, sanitizeVerifyResponse } = require("../integrations/fayda/pdfGenerator");
const { buildServerOneScreenshotAssets } = require("../integrations/fayda/screenshotGenerator");

const FORMATS = ["pdf", "screenshot", "json"];

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
  if (error?.appCheckRejected || /app[\s_-]?check|firebase|APP_CHECK/i.test(raw)) {
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

    // Server selection. Fayda now enforces App Check on /api/v2/auth/authorize,
    // so the legacy Server-3 path (no token) returns "App Check token required".
    // When a super-admin has set an App Check token (via /server4token), DEFAULT
    // to the Server-4 flow so the token is sent. Server 3 is used only when no
    // token is set, or it is explicitly requested with server=server3.
    const appCheckToken = await store.getServer4Token();
    const serverChoice = String(req.body?.server || "").toLowerCase().replace(/[\s._-]/g, "");
    const explicitS3 = ["server3", "3", "esignet", "v117"].includes(serverChoice);
    const explicitS4 = ["server4", "4", "v119", "faydaapp", "appcheck"].includes(serverChoice);
    const useServer4 = explicitS4 || (!explicitS3 && Boolean(appCheckToken));

    let result;
    try {
      if (useServer4) {
        if (!appCheckToken) {
          throw httpError(503, "Server 4 needs an App Check token. A super-admin must set it with /server4token in the bot.");
        }
        result = await sendServerFourOtp(individualId, { appCheckToken });
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
  const reqFormat = String(req.body?.format || "pdf").toLowerCase();
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
    let verifyResponse;
    try {
      verifyResponse = isServer4
        ? await authenticateServerFourOtp({
            otp,
            individualId: session.individualId,
            authSession: session.authSession,
            appCheckToken: await store.getServer4Token()
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
      const raw = cleanResponse?.user?.data || cleanResponse?.data || {};
      const IMG_KEYS = ["photo", "QRCodes", "qrCodes", "qrCode", "fronts", "front", "backs", "back"];
      const data = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!IMG_KEYS.includes(k)) data[k] = v;
      }
      const personName = safeFilename(pdfData.fullName_eng, fallbackName);
      await finishCount(personName);
      return res.json({
        ok: true,
        format: "json",
        name: personName,
        data,
        photo: pdfData.photo || null,
        qr: pdfData.QRCodes || null,
        front: pdfData.fronts || null,
        back: pdfData.backs || null
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
