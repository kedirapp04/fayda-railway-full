# fayda-railway — merged OTP gateway + PDF/screenshot generator

One Railway service that does the **whole** Fayda flow in-process: send OTP →
verify OTP → render the document. The old two-service split (otp-gateway that
encrypts a payload, separate generator that decrypts + renders) is gone — there
is **no internal `/generate` call and no RSA/AES envelope**. Storage is
**Supabase Postgres**; nothing is written to disk and there are no request logs.

## Architecture

- **Single per-user API key** (rental key) authenticates both calls.
- **`POST /api/session`** `{ individualId }` → sends the Server-3 OTP, returns a
  `sessionId` (+ masked phone/email). Billing/limits are pre-checked so an OTP is
  never sent to a user who can't spend it.
- **`POST /api/session/:id/verify`** `{ otp, format }` → verifies the OTP and
  renders **in the same process**. `format` ∈ `pdf` | `screenshot` | `json` | `pdf_json`.
  One render per verify; the session is then consumed (charged once).
  - `pdf` → `application/pdf` bytes (rendered to a Buffer, never touches disk).
  - `screenshot` → JSON with base64 images (in memory).
  - `json` → decoded ID fields + photo/qr/front/back.
  - `pdf_json` → the `json` payload **plus** a `pdf` object
    `{ filename, contentType, base64 }` — both id-data and the rendered PDF in
    one response. Aliases: `json_pdf`, `pdfjson`, `both`, `all`.
- Billing modes per user: **counter** (daily/total limits), **prepaid**
  (balance), **postpaid** (owed vs credit limit). Charged once per successful
  verify. Each user has a **debt** = current period × price + unpaid saved
  payments; "Save & reset" freezes a period into a paid/unpaid payment record.
- **Telegram admin bot** (polling) manages users: approve, issue/revoke keys,
  limits, billing (price / postpaid limit / add balance — manual entry),
  save & reset, **mark payments paid**, free tester key. Destructive actions
  confirm first.
- **Payments:** users **Add Balance** (notifies admin) or **Pay Debt** (all or a
  single unpaid payment) by sending a **receipt** (text / photo / PDF); an admin
  **Approves** (marks paid) or **Rejects**. Direct CBE self-service is planned.

## 1. Supabase
Create a project → Settings → Database → Connection string → **Session pooler**
URI. That's `DATABASE_URL`. No manual SQL — tables auto-create on first boot.

## 2. Local run
```
cp .env.example .env     # fill DATABASE_URL, FAYDA_API_KEY, TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_IDS
npm install
npm start                # boots schema, starts API on :8090 + the admin bot
```
Health check: `GET http://localhost:8090/api/health`.

## 3. Deploy to Railway
1. Push this folder to a private GitHub repo.
2. Railway → New Project → Deploy from GitHub repo (Nixpacks auto-detects Node).
3. Variables: `DATABASE_URL`, `FAYDA_API_KEY`, `TELEGRAM_BOT_TOKEN`,
   `ADMIN_TELEGRAM_IDS`, `LOG_LEVEL=error`, plus the Fayda server vars. **Do not
   set `PORT`** — Railway injects it; the server binds to it.
4. Settings → Networking → Generate Domain to expose the API.

## Notes
- No files persisted (ephemeral FS-safe); no morgan/request logs (`LOG_LEVEL`).
- Telegram bot uses polling — keep a single running instance (one Railway replica).
- Updates: push to GitHub → Railway auto-deploys (git-based, no SSH).
