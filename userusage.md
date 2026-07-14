# Developer Usage Guide

Integrate the Fayda API: go from a 12–16 digit FAN/FIN to a finished **PDF**,
**screenshot**, raw **JSON** user data, or **PDF + JSON together** in **two
calls** against **one service** with **one key**.

```
 1. POST  {BASE}/api/session            → sessionId                          (your key)
 2. POST  {BASE}/api/session/:id/verify → PDF / screenshot / json / pdf_json (your key)
```

The OTP is verified and the document is rendered **in the same request** — there
is no separate generate call and no encrypted payload to forward. Every
successful verify counts once against your quota.

---

## 0. Get your key

One key (`x-api-key`) authenticates **both** calls. Get it from the Telegram bot
(tap **/start**, buttons appear):

- **🎁 Free Tester Key** — instant, **once per account**, a key with **15 free
  generations** + this tester tool. Great for trying it out.
- **📨 Request Full Access + Docs** — an admin approves you, then you receive a
  key (no/larger limit) **and this guide** in a DM.

Your key is shown **once**. Use **🗑 Revoke & Replace** for a fresh key (deletes
the old one, keeps your usage), **📊 My Usage** to see your count, **⏸ / 🗑** to
pause/revoke. A Telegram username is required.

Base URL (your Railway deployment):
```
BASE = https://<your-app>.up.railway.app
```

> **Counting:** each *successful* verify counts once. One OTP verification → one
> render. To get a PDF **and** the JSON from a single OTP, use
> `format: "pdf_json"` (counts once). Other format combinations still need a
> **fresh OTP** per format.

---

## 1. Send OTP

```bash
curl -X POST "$BASE/api/session" \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{ "individualId": "6140798523697412" }'
```
```json
{ "ok": true, "sessionId": "sess_ab12…", "fan": "************7412",
  "maskedMobile": "#####1234", "maskedEmail": null, "channels": ["email","phone"] }
```
`individualId` = 12–16 digit FAN/FIN. Keep the `sessionId` for step 2
(valid ~10 min).

> **`maskedMobile`** masks an Ethiopian (`+251`) mobile and reveals only the last
> 4 digits — so `#####1234` is really `+251*****1234`. If you show it to your
> users, display it in the `+251*****1234` form.

## 2. Verify OTP & render

```bash
# PDF (default) — binary body
curl -X POST "$BASE/api/session/sess_ab12…/verify" \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{ "otp": "123456", "format": "pdf" }' \
  --output fayda.pdf

# data only, no document:
curl -X POST "$BASE/api/session/sess_ab12…/verify" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{ "otp": "123456", "format": "json" }'

# PDF + JSON together in one request (counts once):
curl -X POST "$BASE/api/session/sess_ab12…/verify" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{ "otp": "123456", "format": "pdf_json" }'
```
OTP is single-use. On a wrong OTP the session is dropped — restart at step 1.

- `format: "pdf"` (default) → `application/pdf` bytes. Response headers:
  - `Content-Disposition: attachment; filename="<Full Name>.pdf"` — **the file
    is named after the person** (e.g. `Abebe Kebede Tadesse.pdf`), falling back to the
    FAN then `fayda`.
  - `X-Person-Name` — the person's full name (URL-encoded), so you can name the
    file even when reading the body as a stream.
  - `X-Usage-Total` — your running success count.
  - (These custom headers are exposed via `Access-Control-Expose-Headers`.)
- `format: "screenshot"` → JSON, including the person's **name**:
  ```json
  { "ok": true, "format": "screenshot", "name": "Abebe Kebede Tadesse",
    "images": [ { "label":"front", "filename":"front-Kedir_Seid_Aman.png",
                  "contentType":"image/png", "base64":"…" }, … ] }
  ```
  Each image's `filename` already embeds the person's name — save them as-is.
- `format: "json"` → the decoded ID **user data**, **no document is rendered**.
  `data` is the **full** verify payload — every text field the upstream returns
  (name, DOB, gender, citizenship, phone, region/zone/woreda, `fcn`, `UIN`,
  `email`, `regId`, `residenceCountry*`, `card_generation_date_*`, `found`,
  `locked`, …) — with only the bulky base64 image blobs stripped out and
  surfaced separately as `photo` / `qr` / `front` / `back`:
  ```json
  { "ok": true, "format": "json", "name": "Abebe Kebede Tadesse",
    "data": { "fullName_eng":"…", "fullName_amh":"…", "dateOfBirth_eng":"…",
              "gender_eng":"…", "citizenship_Eng":"…", "phone":"…",
              "region_eng":"…", "zone_eng":"…", "woreda_eng":"…", "fcn":"…",
              "UIN":"…", "email":"…", "regId":"…", "residenceCountryEng":"…",
              "card_generation_date_greg":"…", "found":true, "locked":false },
    "photo":"<base64>", "qr":"<base64>", "front":"<base64>", "back":"<base64>" }
  ```
  Image fields are `null` when the source ID didn't include them.
- `format: "pdf_json"` → **everything in the `json` response above**, plus a
  rendered PDF as base64 — so one OTP verification returns both the id-data and
  the document (and still **counts once**). Aliases: `json_pdf`, `pdfjson`,
  `both`, `all`.
  ```json
  { "ok": true, "format": "pdf_json", "name": "Abebe Kebede Tadesse",
    "data": { … same fields as `json` … },
    "photo":"<base64>", "qr":"<base64>", "front":"<base64>", "back":"<base64>",
    "pdf": { "filename":"Abebe Kebede Tadesse.pdf", "contentType":"application/pdf",
             "base64":"<base64-pdf>" } }
  ```
  Decode `pdf.base64` to bytes and write it to a `.pdf` file.

---

## Forgot FAN — recover your number by SMS

`POST {BASE}/api/forgot-fan` — for users who forgot their FAN/FCN. It asks Fayda
to **SMS the FCN to the phone number registered** against that Fayda record. The
number is delivered by SMS and is **never returned** in the response. No OTP, no
quota charge.

```bash
curl -X POST "$BASE/api/forgot-fan" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{ "phone": "0911223344" }'
```

`phone` accepts `0911223344`, `+251911223344`, `251911223344`, or `911223344`.

- **Success** → `{ "ok": true, "phone": "0911****44", "message": "…" }` (phone masked).
- `400` invalid phone · `404` no Fayda record for that number · `429` too many
  attempts for that number (limit **3 / 10 min per phone**) · `502` upstream error.

---

## Full example — Node.js

```js
const axios = require("axios");

const BASE = "https://your-app.up.railway.app";
const KEY = process.env.FAYDA_KEY;
const H = { "x-api-key": KEY };

async function downloadPdf(fan, getOtp) {
  // 1) send-otp
  const start = await axios.post(`${BASE}/api/session`, { individualId: fan }, { headers: H });
  const sessionId = start.data.sessionId;
  console.log("OTP sent to", start.data.maskedMobile);

  // 2) verify-otp + render  (getOtp() = however you collect the code)
  const otp = await getOtp();
  const pdf = await axios.post(`${BASE}/api/session/${sessionId}/verify`,
    { otp, format: "pdf" },
    { headers: H, responseType: "arraybuffer" });

  const name = decodeURIComponent(pdf.headers["x-person-name"] || "fayda");
  require("fs").writeFileSync(`${name}.pdf`, pdf.data);
  console.log(`Saved ${name}.pdf · total used:`, pdf.headers["x-usage-total"]);
}

// data only (send a fresh OTP for a different format):
async function fetchJson(sessionId, otp) {
  const res = await axios.post(`${BASE}/api/session/${sessionId}/verify`,
    { otp, format: "json" }, { headers: H });
  console.log(res.data.data);          // every text field (UIN, email, …)
  // res.data.photo / .qr / .front / .back are base64 (or null)
}
```

## Full example — Python

```python
import requests, os
from urllib.parse import unquote

BASE = "https://your-app.up.railway.app"
H    = {"x-api-key": os.environ["FAYDA_KEY"]}

def download_pdf(fan, otp_input):
    s = requests.post(f"{BASE}/api/session", json={"individualId": fan}, headers=H).json()
    sid = s["sessionId"]
    print("OTP sent to", s["maskedMobile"])

    otp = otp_input()                    # collect the code from the user
    r = requests.post(f"{BASE}/api/session/{sid}/verify",
                      json={"otp": otp, "format": "pdf"}, headers=H)
    name = unquote(r.headers.get("X-Person-Name", "fayda"))   # file named after the person
    open(f"{name}.pdf", "wb").write(r.content)
    print(f"Saved {name}.pdf · total used:", r.headers.get("X-Usage-Total"))
```

---

## Status codes

| Code | Meaning |
|---|---|
| 200 | success |
| 400 | bad `individualId` / `otp` |
| 401 | missing `x-api-key` |
| 403 | your key or account is **paused / revoked / not approved** |
| 410 | session expired / unknown — restart at step 1 |
| 422 | nothing renderable in the verified payload |
| 429 | **quota/credit exhausted** — counter: daily/total limit; prepaid: balance too low; postpaid: credit limit reached |
| 502 | Server-3 upstream (Fayda) error |

Error body is always `{ "ok": false, "error": "…" }`.

> Billing is pre-checked at **send-OTP** time too, so a `429` can come back from
> step 1 before an OTP is ever sent — you won't waste an OTP you can't spend.

## Quotas & billing

Your account runs in one of three **billing modes** (set by an admin):

| Mode | What counts | `429` when |
|---|---|---|
| **Counter** | each success increments your count | daily / total limit reached (`0` = unlimited) |
| **Prepaid** | each success deducts the per-gen price from your balance | balance < price — ask admin to top up |
| **Postpaid** | each success adds the price to your running bill | bill would exceed your credit limit |

- Each **successful** verify counts/charges once. Failures don't.
- The per-generation **price** is a global default the admin can override per
  account.
- Check yours: bot → **📊 My Usage** (mode, balance/owed, price, count). Daily
  counters reset at 00:00 UTC; limit raises need an admin.

### Debt & paying

- Your **debt** = this period's generations × the current price + any unpaid
  saved payments. It's shown on the menu, **📊 My Usage**, and **💳 Pay Debt**.
- **💵 Add Balance** notifies an admin to credit your balance.
- **💳 Pay Debt** lists your unpaid payments — tap **Pay All** or a single one,
  then **send your receipt** (transaction text, photo, or PDF). An admin reviews
  it and **Approves** (marks it paid) or **Rejects** (resend a valid receipt).
  _(Direct CBE self-service payment is coming.)_

## Tips

- One OTP verification → one rendered output. To get a PDF **and** the JSON of
  the same person in a single verify, use `format: "pdf_json"` (counts once).
- Keep your key secret. Leaked? Bot → **🗑 Revoke & Replace** (deletes the old
  key, issues a fresh one, keeps your usage count).
