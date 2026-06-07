# Developer Usage Guide

How to integrate the Fayda API as a renter — go from a 16-digit FAN to a
finished **PDF**, **screenshot**, or raw **JSON** user data in three calls.

```
 1. POST  {GATEWAY}/api/session            → sessionId            (shared key)
 2. POST  {GATEWAY}/api/session/:id/verify → encrypted payload    (shared key)
 3. POST  {GENERATOR}/api/generate         → PDF / screenshot / json (YOUR key)
```

- **Gateway** runs send-otp / verify-otp and returns an **encrypted** blob it
  cannot read. Auth: the **shared** key everyone gets (`x-api-key`).
- **Generator** decrypts that blob and renders the document — or returns the
  raw user data as JSON. Auth: **your own rented key** (`x-api-key`). Every
  success counts against your quota.

---

## 0. Get your keys

| Key | Where from | Used on |
|---|---|---|
| **Shared gateway key** | given to all integrators | Gateway (`/api/session*`) |
| **Your rented key** | the Telegram bot | Generator (`/api/generate`) |

Two ways to get a key from the Telegram bot (tap **/start**, buttons appear):
- **🎁 Free Tester Key** — instant, **once per account**, gives a key with **15
  free generations** + the tester tool. Great for trying it out.
- **📨 Request Full Access + Docs** — an admin approves you, then you receive a
  key (no/larger limit) **and this guide** in a DM.

Your key is shown **once** — use **🗑 Revoke & Replace** to get a fresh key (deletes the old one, keeps your usage),
**📊 My Usage** to see your count, **⏸ / 🗑** to pause/revoke. A Telegram
username is required.

Base URLs (live deployment):
```
GATEWAY   = https://faydaapi-railways-production.up.railway.app
GENERATOR = https://vmi3085308.contaboserver.net/generator
```

> **Counting:** each *successful* generate counts once. Re-requesting the **same
> session payload in the same format** (e.g. re-downloading the same person's
> PDF) is a **repeat** — it returns the file but does **not** count again or use
> quota. A different format, or a new OTP session, counts.

---

## 1. Send OTP  (gateway)

```bash
curl -X POST "$GATEWAY/api/session" \
  -H "x-api-key: $SHARED_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "individualId": "6140798523697412" }'
```
```json
{ "ok": true, "sessionId": "sess_ab12…", "fan": "************7412",
  "maskedMobile": "******1234", "maskedEmail": null, "channels": ["email","phone"] }
```
`individualId` = 12–16 digit FAN/FIN. Keep the `sessionId` for step 2
(valid ~10 min).

## 2. Verify OTP  (gateway)

```bash
curl -X POST "$GATEWAY/api/session/sess_ab12…/verify" \
  -H "x-api-key: $SHARED_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "otp": "123456" }'
```
```json
{ "ok": true, "sessionId": "sess_ab12…", "fan": "************7412",
  "encrypted": { "v":1, "alg":"RSA-OAEP-256+AES-256-GCM", "k":"…","iv":"…","t":"…","d":"…" } }
```
OTP is single-use. On a wrong OTP the session is dropped — restart at step 1.
**Do not modify `encrypted`** — pass the object through verbatim.

## 3. Generate  (generator)

```bash
curl -X POST "$GENERATOR/api/generate" \
  -H "x-api-key: $YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "encrypted": { … from step 2 … }, "format": "pdf" }' \
  --output fayda.pdf

# data only, no document:
curl -X POST "$GENERATOR/api/generate" \
  -H "x-api-key: $YOUR_KEY" -H "Content-Type: application/json" \
  -d '{ "encrypted": { … from step 2 … }, "format": "json" }'
```
- `format: "pdf"` (default) → `application/pdf` bytes. Response headers:
  - `Content-Disposition: attachment; filename="<Full Name>.pdf"` — **the file
    is named after the person** (e.g. `Kedir Seid Aman.pdf`), falling back to the
    FAN then `fayda`.
  - `X-Person-Name` — the person's full name (URL-encoded), so you can name the
    file even when reading the body as a stream.
  - `X-Usage-Total` — your running success count. `X-Counted` — `true`, or
    `false` if this was a no-charge repeat.
  - (These custom headers are exposed via `Access-Control-Expose-Headers`.)
- `format: "screenshot"` → JSON, including the person's **name**:
  ```json
  { "ok": true, "format": "screenshot", "name": "Kedir Seid Aman", "counted": true,
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
  { "ok": true, "format": "json", "name": "Kedir Seid Aman", "counted": true,
    "data": { "fullName_eng":"…", "fullName_amh":"…", "dateOfBirth_eng":"…",
              "gender_eng":"…", "citizenship_Eng":"…", "phone":"…",
              "region_eng":"…", "zone_eng":"…", "woreda_eng":"…", "fcn":"…",
              "UIN":"…", "email":"…", "regId":"…", "residenceCountryEng":"…",
              "card_generation_date_greg":"…", "found":true, "locked":false },
    "photo":"<base64>", "qr":"<base64>", "front":"<base64>", "back":"<base64>" }
  ```
  Image fields are `null` when the source ID didn't include them.

---

## Full example — Node.js

```js
const axios = require("axios");

const GATEWAY = "https://your-gateway.up.railway.app";
const GENERATOR = "https://your-contabo-host:8090";
const SHARED_KEY = process.env.SHARED_KEY;
const YOUR_KEY = process.env.YOUR_KEY;

async function downloadPdf(fan, getOtp) {
  // 1) send-otp
  const start = await axios.post(`${GATEWAY}/api/session`,
    { individualId: fan }, { headers: { "x-api-key": SHARED_KEY } });
  const sessionId = start.data.sessionId;
  console.log("OTP sent to", start.data.maskedMobile);

  // 2) verify-otp  (getOtp() = however you collect the code from the user)
  const otp = await getOtp();
  const verify = await axios.post(`${GATEWAY}/api/session/${sessionId}/verify`,
    { otp }, { headers: { "x-api-key": SHARED_KEY } });

  // 3) generate
  const pdf = await axios.post(`${GENERATOR}/api/generate`,
    { encrypted: verify.data.encrypted, format: "pdf" },
    { headers: { "x-api-key": YOUR_KEY }, responseType: "arraybuffer" });

  // The file is named after the person (X-Person-Name header).
  const name = decodeURIComponent(pdf.headers["x-person-name"] || "fayda");
  require("fs").writeFileSync(`${name}.pdf`, pdf.data);
  console.log(`Saved ${name}.pdf · total used:`, pdf.headers["x-usage-total"]);

  // …or just the data (no document rendered):
  const res = await axios.post(`${GENERATOR}/api/generate`,
    { encrypted: verify.data.encrypted, format: "json" },
    { headers: { "x-api-key": YOUR_KEY } });
  console.log(res.data.data);                 // every text field (UIN, email, …)
  // res.data.photo / .qr / .front / .back are base64 (or null)
}
```

## Full example — Python

```python
import requests, os

GATEWAY   = "https://your-gateway.up.railway.app"
GENERATOR = "https://your-contabo-host:8090"
SHARED    = {"x-api-key": os.environ["SHARED_KEY"]}
MINE      = {"x-api-key": os.environ["YOUR_KEY"]}

def download_pdf(fan, otp_input):
    s = requests.post(f"{GATEWAY}/api/session", json={"individualId": fan}, headers=SHARED).json()
    sid = s["sessionId"]
    print("OTP sent to", s["maskedMobile"])

    otp = otp_input()                       # collect the code from the user
    v = requests.post(f"{GATEWAY}/api/session/{sid}/verify", json={"otp": otp}, headers=SHARED).json()

    r = requests.post(f"{GENERATOR}/api/generate",
                      json={"encrypted": v["encrypted"], "format": "pdf"}, headers=MINE)
    from urllib.parse import unquote
    name = unquote(r.headers.get("X-Person-Name", "fayda"))   # file named after the person
    open(f"{name}.pdf", "wb").write(r.content)
    print(f"Saved {name}.pdf · total used:", r.headers.get("X-Usage-Total"))

    # …or just the data (no document rendered):
    d = requests.post(f"{GENERATOR}/api/generate",
                      json={"encrypted": v["encrypted"], "format": "json"}, headers=MINE).json()
    print(d["data"])                          # every text field (UIN, email, …)
    # d["photo"] / d["qr"] / d["front"] / d["back"] are base64 (or None)
```

---

## Status codes

| Code | Where | Meaning |
|---|---|---|
| 200 | both | success |
| 400 | gateway | bad `individualId` / `otp` |
| 400 | generator | missing or undecryptable `encrypted` |
| 401 | both | missing / invalid `x-api-key` |
| 403 | generator | your key or account is **paused / revoked / not approved** |
| 410 | gateway | session expired / unknown — restart at step 1 |
| 422 | generator | nothing renderable in the payload |
| 429 | generator | **quota/credit exhausted** — counter: daily/total limit; prepaid: balance too low; postpaid: credit limit reached |
| 502 | gateway | Server-3 upstream (Fayda) error |

Error body is always `{ "ok": false, "error": "…" }`.

## Quotas & billing

Your account runs in one of three **billing modes** (set by an admin):

| Mode | What counts | `429` when |
|---|---|---|
| **Counter** | each success increments your count | daily / total limit reached (`0` = unlimited) |
| **Prepaid** | each success deducts the per-gen price from your balance | balance < price — ask admin to top up |
| **Postpaid** | each success adds the price to your running bill | bill would exceed your credit limit |

- Each **successful** `/api/generate` counts/charges once. Failures and
  no-charge **repeats** (same session + format) don't.
- The per-generation **price** is a global default the admin can override per
  account.
- Check yours: bot → **📊 My Usage** (mode, balance/owed, price, count). Daily
  counters reset at 00:00 UTC; balance top-ups and limit raises need an admin.

## Tips

- One verify payload → one output. To get more than one format (e.g. a PDF
  **and** the JSON data), call `/api/generate` again with the **same**
  `encrypted` but a different `format` — each distinct format counts once.
- The `encrypted` blob is single-purpose data, not a long-lived token — fetch a
  fresh one per person via steps 1–2.
- Keep your rented key secret. Leaked? Bot → **🗑 Revoke & Replace** (deletes
  the old key, issues a fresh one, keeps your usage count).
