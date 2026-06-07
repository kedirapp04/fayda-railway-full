const { Jimp, JimpMime } = require("jimp");
const { sanitizeVerifyResponse } = require("./pdfGenerator");

const BORDER_COLOR = 0xff000000;
const BACKGROUND_COLOR = 0xffffffff;
const MERGED_BORDER = 6;
const MERGED_SIDE_PADDING = 28;
const MERGED_TOP_PADDING = 28;
const MERGED_BOTTOM_PADDING = 28;
const MERGED_GAP = 28;
const MERGED_MAX_WIDTH = 900;
const MERGED_MAX_HEIGHT = 900;

function pickAssetValue(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = pickAssetValue(item);
      if (resolved) return resolved;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["data", "base64", "content", "value"]) {
      if (value[key] !== undefined && value[key] !== null) {
        const resolved = pickAssetValue(value[key]);
        if (resolved) return resolved;
      }
    }
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

function normalizeBase64ToBuffer(value) {
  const payload = pickAssetValue(value);
  if (!payload) return null;
  if (Buffer.isBuffer(payload)) return payload;
  const stripped = String(payload).trim().replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (!stripped) return null;
  return Buffer.from(stripped, "base64");
}

function detectImageMeta(buffer) {
  if (!buffer || !buffer.length) return null;

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: "png", mime: JimpMime.png };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: "jpg", mime: JimpMime.jpeg };
  }
  if (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return { ext: "gif", mime: JimpMime.gif };
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { ext: "bmp", mime: JimpMime.bmp };
  }
  if (buffer.length >= 4 && (buffer.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || buffer.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) {
    return { ext: "tiff", mime: JimpMime.tiff };
  }

  return null;
}

function sanitizeNameToken(value) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^0-9A-Za-z]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "";
}

function resolvePersonBaseName(pdfData, fallbackName) {
  const englishName = sanitizeNameToken(pdfData?.fullName_eng || pdfData?.fullNameEng || pdfData?.fullName || "");
  if (englishName) return englishName;
  const fallbackToken = sanitizeNameToken(fallbackName || pdfData?.fcn || "fayda");
  return fallbackToken || "fayda";
}

async function ensureSendableAsset(label, rawValue, baseName) {
  const buffer = normalizeBase64ToBuffer(rawValue);
  if (!buffer) return null;

  const detected = detectImageMeta(buffer);
  if (detected) {
    return { label, buffer, filename: `${label}-${baseName}.${detected.ext}`, contentType: detected.mime };
  }

  const image = await Jimp.read(buffer);
  const pngBuffer = await image.getBuffer(JimpMime.png);
  return { label, buffer: pngBuffer, filename: `${label}-${baseName}.png`, contentType: JimpMime.png };
}

async function readForComposite(rawValue) {
  const buffer = normalizeBase64ToBuffer(rawValue);
  if (!buffer) return null;
  const image = await Jimp.read(buffer);
  if (image.width > MERGED_MAX_WIDTH || image.height > MERGED_MAX_HEIGHT) {
    image.scaleToFit({ w: MERGED_MAX_WIDTH, h: MERGED_MAX_HEIGHT });
  }
  return image;
}

async function buildMergedPhotoQrAsset(photoValue, qrValue, baseName) {
  const [photoImage, qrImage] = await Promise.all([readForComposite(photoValue), readForComposite(qrValue)]);
  if (!photoImage || !qrImage) return null;

  const innerWidth = Math.max(photoImage.width, qrImage.width) + (MERGED_SIDE_PADDING * 2);
  const innerHeight = MERGED_TOP_PADDING + photoImage.height + MERGED_GAP + qrImage.height + MERGED_BOTTOM_PADDING;

  const outer = new Jimp({
    width: innerWidth + (MERGED_BORDER * 2),
    height: innerHeight + (MERGED_BORDER * 2),
    color: BORDER_COLOR
  });
  const inner = new Jimp({
    width: innerWidth,
    height: innerHeight,
    color: BACKGROUND_COLOR
  });

  outer.composite(inner, MERGED_BORDER, MERGED_BORDER);

  const photoX = MERGED_BORDER + Math.round((innerWidth - photoImage.width) / 2);
  const photoY = MERGED_BORDER + MERGED_TOP_PADDING;
  const qrX = MERGED_BORDER + Math.round((innerWidth - qrImage.width) / 2);
  const qrY = photoY + photoImage.height + MERGED_GAP;

  outer.composite(photoImage, photoX, photoY);
  outer.composite(qrImage, qrX, qrY);

  const mergedBuffer = await outer.getBuffer(JimpMime.png);
  return { label: "photo-qr", buffer: mergedBuffer, filename: `photo-qr-${baseName}.png`, contentType: JimpMime.png };
}

async function buildServerOneScreenshotAssets(verifyResponse, fallbackName) {
  const { pdfData } = sanitizeVerifyResponse(verifyResponse);
  const baseName = resolvePersonBaseName(pdfData, fallbackName);

  const [frontAsset, backAsset, mergedAsset] = await Promise.all([
    ensureSendableAsset("front", pdfData.fronts, baseName),
    ensureSendableAsset("back", pdfData.backs, baseName),
    buildMergedPhotoQrAsset(pdfData.photo, pdfData.QRCodes, baseName)
  ]);

  return {
    baseName,
    assets: [frontAsset, backAsset, mergedAsset].filter(Boolean)
  };
}

module.exports = {
  buildServerOneScreenshotAssets
};
