'use strict';

// Gregorian → Ethiopian calendar date. The resident (server5) API returns only
// the Gregorian date of birth; the card/PDF also shows the Ethiopian-calendar
// ("Amharic") date. Faithful port of faydapdf-py's etdate.py — same algorithm,
// same DD/MM/YYYY output.

const DATE_RE = /^(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})$/;

function gregorianToEthiopian(gy, gm, gd) {
  const a = Math.floor((14 - gm) / 12);
  const y = gy + 4800 - a;
  const m = gm + 12 * a - 3;
  const jdn = gd + Math.floor((153 * m + 2) / 5) + 365 * y
    + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
  const EPOCH = 1723856;
  const diff = jdn - EPOCH;
  const r = ((diff % 1461) + 1461) % 1461;
  const n = (r % 365) + 365 * Math.floor(r / 1460);
  return {
    year: 4 * Math.floor(diff / 1461) + Math.floor(r / 365) - Math.floor(r / 1460),
    month: Math.floor(n / 30) + 1,
    day: (n % 30) + 1,
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

// "YYYY/MM/DD" (or -) Gregorian → "DD/MM/YYYY" Ethiopian, or "" if unparseable.
function toEthiopianDate(value) {
  const m = DATE_RE.exec(String(value == null ? '' : value).trim());
  if (!m) return '';
  const gy = Number(m[1]);
  const gm = Number(m[2]);
  const gd = Number(m[3]);
  if (!(gm >= 1 && gm <= 12 && gd >= 1 && gd <= 31)) return '';
  const e = gregorianToEthiopian(gy, gm, gd);
  return `${pad2(e.day)}/${pad2(e.month)}/${e.year}`;
}

module.exports = { toEthiopianDate, gregorianToEthiopian };
