# fayda-railway-full

Merged **Fayda OTP gateway + PDF/screenshot generator** as a single Railway
service, backed by **Supabase Postgres**. The old two-service split (a gateway
that encrypted a payload and a separate generator that decrypted + rendered) is
collapsed into one in-process flow — **no internal `/generate` call, no RSA/AES
envelope**. Nothing is written to disk and there are no request logs (Railway
cost/stability).

## Flow (single per-user API key authenticates both)

1. `POST /api/session` `{ individualId }` → sends the Server-3 OTP, returns a
   `sessionId` (+ masked phone/email). Billing/limits are pre-checked.
2. `POST /api/session/:id/verify` `{ otp, format }` → verifies the OTP and
   renders **in the same process**. `format` ∈ `pdf` | `screenshot` | `json` | `pdf_json`.
   One render per verify; the session is consumed.
   - `pdf` → `application/pdf` bytes (rendered to a Buffer — never touches disk)
   - `screenshot` → JSON with base64 images (in memory)
   - `json` → decoded ID fields + photo/qr/front/back
   - `pdf_json` → the `json` payload **plus** a `pdf` object `{ filename, contentType, base64 }`

`GET /api/health` reports service/db/bot status.

## Billing (per user)

- **counter** — daily/total success limits
- **prepaid** — balance must cover the price
- **postpaid** — owed vs credit limit

Charged once per successful verify. Each user has a **debt** = current period ×
price + unpaid saved payments. "Save & reset" freezes a period into a payment
record (price + amount, paid/unpaid).

A **Telegram admin bot** (polling) manages users: approve, issue/revoke keys,
limits, billing (price / postpaid limit / add balance via manual entry), counter
save & reset, **mark payments paid**, free tester key. Destructive actions
(revoke, clear save, settle, mark-paid) ask for confirmation.

Users can **Add Balance** (notifies admin) and **Pay Debt** — pay all or a single
unpaid payment by submitting a **receipt** (text / photo / PDF) that an admin
**Approves** or **Rejects**.

## Run

```bash
cp .env.example .env     # fill DATABASE_URL, FAYDA_API_KEY, TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_IDS
npm install
npm start                # boots schema, API on :8090 + the admin bot
```

See [SETUP.md](./SETUP.md) for Supabase + Railway deployment details.

## Stack

Node ≥18 · Express · `pg` (Supabase Postgres) · pdf-lib + @pdf-lib/fontkit ·
jimp · node-telegram-bot-api.

## Notes

- No secrets in git — `.env`, `keys/`, `data/` are gitignored. Configure via
  Railway Variables.
- Telegram bot uses polling — run a single instance (one Railway replica).
- Updates: push to GitHub → Railway auto-deploys (git-based, no SSH).
