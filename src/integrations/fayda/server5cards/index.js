'use strict';

// ─── Server-5 card + QR builder (in-process) ──────────────────────────────────
// The resident identity API returns data, NOT card pictures or a QR, so we draw
// them here before the PDF/screenshot layer sees the record. Ported from the
// faydapdf-py `cards_node/cards.js` doCards path — same generators, same four
// admin-selectable QR modes — but called directly (no stdin/stdout subprocess).
//
//   buildCards({ cardData, qrGen })  ->  { qrText, qrPng, front, back }
//
// A generated QR carries a SAMPLE signature (or none, per qrGen) and will not
// pass verification; that is the whole point of the admin-selectable modes. All
// buffers may be null on a per-piece failure — a missing card must never cost the
// caller its PDF.

const QRCode = require('qrcode');
const { createCanvas } = require('@napi-rs/canvas');
const { buildLegacyQr, makeQrThumbWebp } = require('./faydaQrBuilder');
const { generateCards } = require('./faydaCardGenerator');

const QR_MODES = ['data', 'nosig', 'blank', 'unscannable'];

function normalizeQrGen(value) {
  const v = String(value || '').trim().toLowerCase();
  return QR_MODES.includes(v) ? v : 'data';
}

// Build the QR PNG (and its text, when it has one) for the chosen mode.
async function buildQr(cardData, qrGen) {
  const opts = { errorCorrectionLevel: 'L', type: 'png', margin: 2, scale: 4 };

  if (qrGen === 'unscannable') {
    // A REAL, dense QR at the same version as an authentic new-format Fayda QR,
    // then ~40% of the DATA modules are flipped (far past error correction) while
    // the three finder patterns are kept — so it reads as a genuine QR but no
    // scanner can decode it.
    const dummy = Buffer.alloc(1185);
    for (let i = 0; i < dummy.length; i += 1) dummy[i] = (i * 31 + 7) & 0xff;
    const qr = QRCode.create([{ data: dummy, mode: 'byte' }], { errorCorrectionLevel: 'L' });
    const size = qr.modules.size;
    const md = qr.modules;
    const inFinder = (r, c) =>
      (r < 8 && c < 8) || (r < 8 && c >= size - 8) || (r >= size - 8 && c < 8);
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (inFinder(r, c)) continue;
        if ((((r * 928371 + c * 123457) >>> 0) % 100) < 40) {
          const i = r * size + c;
          md.data[i] = md.data[i] ? 0 : 1;
        }
      }
    }
    const margin = 4, box = 5, dim = (size + margin * 2) * box;
    const cv = createCanvas(dim, dim);
    const cx = cv.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, dim, dim);
    cx.fillStyle = '#000';
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (md.data[r * size + c]) cx.fillRect((c + margin) * box, (r + margin) * box, box, box);
      }
    }
    return { qrText: null, qrPng: await cv.encode('png') };
  }

  if (qrGen === 'blank') {
    // A legacy-format QR (has the :DLT: / :SIGN: markers the Fayda app recognises)
    // but with EMPTY data and no signature — the app reads it as a blank legacy QR
    // and shows nothing, rather than treating it as a new COSE credential and
    // erroring with "not a COSE security Message".
    const qrText = ':DLT::V:4:G::A::D::SIGN:';
    return { qrText, qrPng: await QRCode.toBuffer(qrText, opts) };
  }

  // data / nosig — a legacy QR carrying the person's data.
  const face = cardData.photo ? await makeQrThumbWebp(cardData.photo) : null;
  const built = await buildLegacyQr({
    face,
    fullName: cardData.fullName_eng || cardData.fullName || '',
    gender: cardData.sex_eng || cardData.gender || '',
    fan: cardData.fan || '',
    dob: cardData.dobGc || '',
  });
  let qrText = built.qrText;
  let qrPng = built.qrPngBuffer;
  if (qrGen === 'nosig') {
    // Keep the data but empty the signature: ":SIGN:" stays (so the app still
    // recognises a legacy DATA QR) with nothing after it. Removing the marker
    // entirely makes the app try a COSE parse and error ("too many bytes … CBOR").
    const i = qrText.lastIndexOf(':SIGN:');
    if (i >= 0) qrText = qrText.slice(0, i + ':SIGN:'.length);
    qrPng = await QRCode.toBuffer(qrText, opts);
  }
  return { qrText, qrPng };
}

async function buildCards({ cardData, qrGen }) {
  const mode = normalizeQrGen(qrGen);
  let qrText = null;
  let qrPng = null;
  try {
    ({ qrText, qrPng } = await buildQr(cardData || {}, mode));
  } catch (error) {
    console.warn('[server5 cardkit] QR build failed:', error && error.message);
  }

  let front = null;
  let back = null;
  try {
    const cards = await generateCards({ ...cardData, qr: qrPng });
    front = cards.front;
    back = cards.back;
  } catch (error) {
    console.warn('[server5 cardkit] card render failed:', error && error.message);
  }

  return { qrText, qrPng, front, back };
}

module.exports = { buildCards, QR_MODES, normalizeQrGen };
