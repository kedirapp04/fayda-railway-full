const path = require("path");
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const env = require("../config/env");
const store = require("../services/store.service");
const { startServer4TokenAutoUpdate } = require("../services/server4TokenUpdater");

let bot = null;

const isAdmin = (tgId) => env.ADMIN_TELEGRAM_IDS.includes(String(tgId));

// Money formatter: integers stay clean, decimals show 2 places.
const money = (n) => {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

// Inline Yes/No keyboard for confirming a destructive action.
const confirmKb = (yesData, noData) => ({
  reply_markup: { inline_keyboard: [[
    { text: "✅ Yes", callback_data: yesData },
    { text: "⬅ No", callback_data: noData }
  ]] }
});

// Admin chat → awaited manual numeric input ({ kind, userId?, chatId, msgId }).
// Set when an admin taps a "Set Price / Add Balance / …" button; consumed by the
// global message handler when they reply with a number.
const pendingInput = new Map();

// User chat → awaited payment receipt ({ userId, scope, saveId, amount }). Set
// when a user taps Pay All / Pay #id; consumed by the message handler when they
// send the receipt (text, photo, or PDF).
const pendingReceipt = new Map();

// Server 4 App Check token status, from the decoded JWT `exp` (real expiry).
function s4StatusLine(info) {
  if (!info.set) return "❌ Empty (Server 4 falls back to Server 3)";
  if (info.minLeft == null) return `✅ Set (${info.preview}) · no exp in token`;
  return info.minLeft > 0
    ? `✅ Set (${info.preview}) · expires in ${info.minLeft} min`
    : `⚠️ EXPIRED ${Math.abs(info.minLeft)} min ago (${info.preview}) — refresh it`;
}
const TESTER_PATH = path.join(__dirname, "..", "..", "tester.html");
const DOCS_PATH = path.join(__dirname, "..", "..", "userusage.md");

function notifyAdmins(text) {
  if (!bot) return;
  env.ADMIN_TELEGRAM_IDS.forEach((id) => bot.sendMessage(id, text).catch(() => {}));
}

// Forward a submitted payment receipt to every admin with Approve/Reject buttons.
async function notifyAdminsReceipt(req, u) {
  if (!bot) return;
  const who = u && u.username ? "@" + u.username : "#" + (u ? u.id : req.user_id);
  const scopeLabel = req.scope === "all" ? "ALL unpaid" : `payment #${req.save_id}`;
  const caption =
    `💳 Payment request #${req.id}\n` +
    `From: ${who} (#${req.user_id})\n` +
    `For: ${scopeLabel} · amount ${money(req.amount)}` +
    (req.receipt_text ? `\n🧾 Text: ${req.receipt_text}` : "");
  const reply_markup = { inline_keyboard: [[
    { text: "✅ Approve", callback_data: `a:payok:${req.id}` },
    { text: "🚫 Reject", callback_data: `a:payno:${req.id}` }
  ]] };
  for (const id of env.ADMIN_TELEGRAM_IDS) {
    try {
      if (req.receipt_kind === "photo" && req.receipt_file_id) await bot.sendPhoto(id, req.receipt_file_id, { caption, reply_markup });
      else if (req.receipt_kind === "document" && req.receipt_file_id) await bot.sendDocument(id, req.receipt_file_id, { caption, reply_markup });
      else await bot.sendMessage(id, caption, { reply_markup });
    } catch (_) {}
  }
}

function requireUsername(from, chatId) {
  if (!from.username) {
    bot.sendMessage(chatId, "⚠️ A Telegram username is required.\nSet one in Settings → Username, then tap /start again.");
    return false;
  }
  return true;
}

// Admins are always approved — they never request access.
async function ensureUser(from) {
  const u = await store.getOrCreateUser(from.id, from.username);
  if (isAdmin(from.id) && u.status !== "approved") return store.setUserStatus(u.id, "approved");
  return u;
}

// ─── Menus (pure formatting from a stats object — sync) ──────────────────────
function billingLine(s) {
  if (s.billingMode === "prepaid") return `💳 Prepaid · balance ${money(s.balance)} · ${money(s.price)}/gen`;
  if (s.billingMode === "postpaid") return `💳 Postpaid · owed ${money(s.owed)}/${s.creditLimit || "∞"} · ${money(s.price)}/gen`;
  return `🔢 Counter · used ${s.totalSuccess}${s.totalLimit ? "/" + s.totalLimit : ""} · ${money(s.price)}/gen`;
}

// Debt = this (unsaved) period valued at the current price + unpaid saved payments.
function debtLine(s) {
  return `💸 Debt: ${money(s.debt)} (this period ${money(s.debtLive)} + unpaid saved ${money(s.debtSaved)})`;
}

function userMenuText(u, s) {
  const who = u.username ? "@" + u.username : "your account";
  return `👤 ${who} — ${u.status}\n` +
    `Key: ${s.key ? s.key.key_prefix + "… (" + s.key.status + ")" : "none"}\n` +
    `${billingLine(s)}\n${debtLine(s)}\n` +
    `Generations: ${s.totalSuccess}${s.savedTotal ? " (+" + s.savedTotal + " saved)" : ""}`;
}

async function userMenu(u, viewerIsAdmin) {
  const s = await store.getUserStats(u.id);
  const rows = [];
  const active = u.status === "approved" || u.status === "trial";
  if (active) {
    rows.push([{ text: "📊 My Usage", callback_data: "u:usage" }, { text: "📁 My Saves", callback_data: "u:saves" }]);
    rows.push([{ text: "💳 Pay Debt", callback_data: "u:pay" }, { text: "💵 Add Balance", callback_data: "u:addbalance" }]);
    if (s.key && s.key.status === "active") rows.push([{ text: "⏸ Pause Key", callback_data: "u:pausekey" }, { text: "🗑 Revoke & Replace", callback_data: "u:revokekey" }]);
    else if (s.key && s.key.status === "paused") rows.push([{ text: "▶️ Resume Key", callback_data: "u:resumekey" }, { text: "🗑 Revoke & Replace", callback_data: "u:revokekey" }]);
    else rows.push([{ text: "🗑 Revoke & Replace", callback_data: "u:revokekey" }]);
    if (u.status === "trial") rows.push([{ text: "📨 Request Full Access + Docs", callback_data: "u:request" }]);
  } else {
    if (!u.trial_claimed) rows.push([{ text: `🎁 Free Tester Key (${env.TRIAL_REWARD_COUNT})`, callback_data: "u:tester" }]);
    rows.push([{ text: "📨 Request Full Access + Docs", callback_data: "u:request" }, { text: "📊 My Usage", callback_data: "u:usage" }]);
  }
  if (viewerIsAdmin) rows.push([{ text: "🛠 Admin Panel", callback_data: "a:panel" }]);
  return { text: userMenuText(u, s), markup: { reply_markup: { inline_keyboard: rows } } };
}

async function adminPanel() {
  const s4 = await store.getServer4TokenInfo();
  return { reply_markup: { inline_keyboard: [
    [{ text: "⏳ Pending", callback_data: "a:pending" }, { text: "👥 Users", callback_data: "a:users" }],
    [{ text: `🌐 Global price: ${await store.globalPrice()}`, callback_data: "a:gprice" }],
    [{ text: `🔑 S4 token: ${s4.set ? "set" : "empty"}`, callback_data: "a:s4token" }],
    [{ text: "🔄 Refresh", callback_data: "a:panel" }]
  ] } };
}

async function gpriceMenu() {
  return {
    text: `🌐 Global price per generation: ${await store.globalPrice()}\nTap to set a new default (per-user overrides still win). Or use /gprice <n>.`,
    markup: { reply_markup: { inline_keyboard: [
      [{ text: "✏️ Set Global Price", callback_data: "a:askgprice" }],
      [{ text: "⬅ Panel", callback_data: "a:panel" }]
    ] } }
  };
}

function moneyLine(u, s) {
  if (s.billingMode === "prepaid") return `balance ${s.balance}`;
  if (s.billingMode === "postpaid") return `owed ${s.owed}/${s.creditLimit || "∞"}`;
  return `limits d:${u.daily_limit || "∞"} t:${u.total_limit || "∞"}`;
}

async function userCard(u) {
  const s = await store.getUserStats(u.id);
  const text =
    `👤 ${u.username ? "@" + u.username : "(no username)"}  ·  id #${u.id}\n` +
    `status: ${u.status} · mode: ${s.billingMode}\n` +
    `price: ${money(s.price)}${s.priceOverride != null ? " (override)" : " (global)"} · ${moneyLine(u, s)}\n` +
    `${debtLine(s)}\n` +
    `key: ${s.key ? s.key.key_prefix + "… (" + s.key.status + ")" : "none"}\n` +
    `gens: today ${s.todaySuccess} · period ${s.totalSuccess} · saved ${s.savedTotal} · life ${s.lifetime}`;
  const rows = [];
  // Approve only for users who were never approved (pending/trial/revoked).
  // A paused user is already approved — show Resume (below), not Approve.
  if (!["approved", "paused"].includes(u.status)) rows.push([{ text: "✅ Approve + Docs", callback_data: `a:approve:${u.id}` }]);
  if (u.status === "paused") rows.push([{ text: "▶️ Resume", callback_data: `a:resume:${u.id}` }]);
  else if (u.status === "approved" || u.status === "trial") rows.push([{ text: "⏸ Pause", callback_data: `a:pause:${u.id}` }]);
  rows.push([{ text: "💳 Billing", callback_data: `a:billing:${u.id}` }, { text: "📏 Limits", callback_data: `a:limits:${u.id}` }]);
  rows.push([{ text: "💾 Save & reset", callback_data: `a:save:${u.id}` }, { text: "📁 Saves", callback_data: `a:saves:${u.id}` }]);
  rows.push([{ text: "📄 Send Docs", callback_data: `a:senddocs:${u.id}` }, { text: "🗑 Revoke", callback_data: `a:revoke:${u.id}` }]);
  rows.push([{ text: "🔄 Refresh", callback_data: `a:user:${u.id}` }, { text: "⬅ Users", callback_data: "a:users" }]);
  return { text, markup: { reply_markup: { inline_keyboard: rows } } };
}

async function billingMenu(u) {
  const s = await store.getUserStats(u.id);
  const text = `💳 Billing — ${u.username ? "@" + u.username : "#" + u.id}\n` +
    `Mode: ${s.billingMode} · price: ${money(s.price)}${s.priceOverride != null ? " (override)" : " (global)"}\n` +
    `Prepaid balance: ${money(s.balance)}\nPostpaid owed: ${money(s.owed)}/${s.creditLimit || "∞"}\n` +
    `${debtLine(s)}`;
  const id = u.id;
  return { text, markup: { reply_markup: { inline_keyboard: [
    [{ text: (s.billingMode === "counter" ? "● " : "") + "🔢 Counter", callback_data: `a:mode:${id}:counter` },
     { text: (s.billingMode === "prepaid" ? "● " : "") + "💰 Prepaid", callback_data: `a:mode:${id}:prepaid` },
     { text: (s.billingMode === "postpaid" ? "● " : "") + "🧾 Postpaid", callback_data: `a:mode:${id}:postpaid` }],
    [{ text: "💵 Add Balance", callback_data: `a:asktopup:${id}` }, { text: "💲 Set Price", callback_data: `a:askprice:${id}` }, { text: "🌐 Use Global", callback_data: `a:price:${id}:clear` }],
    [{ text: "🧾 Set Postpaid Limit", callback_data: `a:askcredit:${id}` }, { text: "🧾 Settle owed", callback_data: `a:settle:${id}` }],
    [{ text: "✅ Mark Current Paid", callback_data: `a:paidnow:${id}` }, { text: "📁 Saves", callback_data: `a:saves:${id}` }],
    [{ text: "⬅ Back", callback_data: `a:user:${id}` }]
  ] } } };
}

function limitsMenu(u) {
  return {
    text: `📏 Limits for ${u.username ? "@" + u.username : "#" + u.id}\nDaily: ${u.daily_limit || "∞"} · Total: ${u.total_limit || "∞"}`,
    markup: { reply_markup: { inline_keyboard: [
      [{ text: "Daily 10", callback_data: `a:daily:${u.id}:10` }, { text: "50", callback_data: `a:daily:${u.id}:50` }, { text: "100", callback_data: `a:daily:${u.id}:100` }, { text: "∞", callback_data: `a:daily:${u.id}:0` }],
      [{ text: "Total 15", callback_data: `a:total:${u.id}:15` }, { text: "100", callback_data: `a:total:${u.id}:100` }, { text: "500", callback_data: `a:total:${u.id}:500` }, { text: "∞", callback_data: `a:total:${u.id}:0` }],
      [{ text: "⬅ Back", callback_data: `a:user:${u.id}` }]
    ] } }
  };
}

async function adminSavesMenu(u) {
  const saves = await store.listSaves(u.id);
  const total = await store.savesTotal(u.id);
  const unpaid = await store.unpaidSavedAmount(u.id);
  const lines = saves.length
    ? saves.map((sv) => `#${sv.id}: ${sv.saved_count}×${money(sv.price)} = ${money(sv.amount)} ${sv.paid ? "✅ paid" : "🔴 unpaid"} — ${sv.saved_at.slice(0, 16).replace("T", " ")}`).join("\n")
    : "(no saves yet)";
  const rows = saves.slice(0, 8).map((sv) => ([
    sv.paid
      ? { text: `↩ Mark Unpaid #${sv.id}`, callback_data: `a:markunpaid:${sv.id}:${u.id}` }
      : { text: `✅ Mark Paid #${sv.id} (${money(sv.amount)})`, callback_data: `a:markpaid:${sv.id}:${u.id}` },
    { text: `🗑 Clear #${sv.id}`, callback_data: `a:clearsave:${sv.id}:${u.id}` }
  ]));
  rows.push([{ text: "⬅ Back", callback_data: `a:user:${u.id}` }]);
  return { text: `📁 Saves/payments for ${u.username ? "@" + u.username : "#" + u.id} — gens saved ${total} · 🔴 unpaid ${money(unpaid)}\n\n${lines}`, markup: { reply_markup: { inline_keyboard: rows } } };
}

async function userSavesText(u) {
  const s = await store.getUserStats(u.id);
  const saves = await store.listSaves(u.id);
  const lines = saves.length ? saves.map((sv) => `• ${sv.saved_count}×${money(sv.price)} = ${money(sv.amount)} ${sv.paid ? "✅ paid" : "🔴 unpaid"} — ${sv.saved_at.slice(0, 10)}`).join("\n") : "(no saved periods yet)";
  return `📁 Your usage\n${billingLine(s)}\n${debtLine(s)}\nGenerations: ${s.totalSuccess}${s.totalLimit ? "/" + s.totalLimit : ""} · saved ${s.savedTotal} · lifetime ${s.lifetime}\n\n${lines}`;
}

// User-facing "pay" menu: list unpaid saved payments with a per-item pay button
// plus a Pay-All button. In manual mode each "pay" sends a settlement request to
// admins (who confirm with Mark Paid); CBE self-service will replace the request.
async function userPayMenu(u) {
  const s = await store.getUserStats(u.id);
  const unpaid = await store.listUnpaidSaves(u.id);
  const lines = unpaid.length
    ? unpaid.map((sv) => `#${sv.id}: ${sv.saved_count}×${money(sv.price)} = ${money(sv.amount)} 🔴`).join("\n")
    : "(nothing unpaid 🎉)";
  const rows = [];
  if (unpaid.length) rows.push([{ text: `💵 Pay All (${money(s.debtSaved)})`, callback_data: "u:payall" }]);
  unpaid.slice(0, 8).forEach((sv) => rows.push([{ text: `💳 Pay #${sv.id} (${money(sv.amount)})`, callback_data: `u:payone:${sv.id}` }]));
  rows.push([{ text: "⬅ Back", callback_data: "u:menu" }]);
  const note = s.debtLive > 0 ? `\n(This period's ${money(s.debtLive)} becomes payable once an admin saves it.)` : "";
  return { text: `💳 Pay your debt\n${debtLine(s)}\n\nUnpaid payments:\n${lines}${note}`, markup: { reply_markup: { inline_keyboard: rows } } };
}

// ─── Senders ────────────────────────────────────────────────────────────
async function sendTester(chatId) {
  try { if (fs.existsSync(TESTER_PATH)) await bot.sendDocument(chatId, TESTER_PATH, { caption: "🧪 Open tester.html in a browser, paste your key, and test the flow." }, { filename: "tester.html", contentType: "text/html" }); } catch (_) {}
}
async function sendDocs(chatId) {
  try { if (fs.existsSync(DOCS_PATH)) await bot.sendDocument(chatId, DOCS_PATH, { caption: "📄 Developer usage guide." }, { filename: "userusage.md", contentType: "text/markdown" }); } catch (_) {}
  try { if (fs.existsSync(TESTER_PATH)) await bot.sendDocument(chatId, TESTER_PATH, {}, { filename: "tester.html", contentType: "text/html" }); } catch (_) {}
}
function sendKey(chatId, rawKey, prefix) {
  return bot.sendMessage(chatId,
    `${prefix}\n\n<code>${rawKey}</code>\n\nSend it as the <b>x-api-key</b> header to POST /api/session and /api/session/:id/verify.`,
    { parse_mode: "HTML" });
}

function start() {
  if (!env.ENABLE_TELEGRAM_BOT || !env.TELEGRAM_BOT_TOKEN) {
    console.error("Telegram bot disabled (no token or ENABLE_TELEGRAM_BOT=false).");
    return null;
  }
  bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.setMyCommands([
    { command: "menu", description: "Open the menu" },
    { command: "tester", description: "Free tester key + tool" },
    { command: "start", description: "Start / register" }
  ]).catch(() => {});
  bot.setChatMenuButton({ menu_button: { type: "commands" } }).catch(() => {});

  // Auto-refresh the Server 4 App Check token from the token API: when the API
  // serves a fresher token (later exp) than the stored one, update + persist it.
  startServer4TokenAutoUpdate({
    getCurrentToken: () => store.getServer4Token(),
    setToken: (token) => store.setServer4Token(token),
    log: (m) => console.log("[server4-token]", m)
  });

  const openMenu = async (msg) => {
    if (!requireUsername(msg.from, msg.chat.id)) return;
    const u = await ensureUser(msg.from);
    const m = await userMenu(u, isAdmin(msg.from.id));
    bot.sendMessage(msg.chat.id, m.text, m.markup);
  };
  bot.onText(/^\/start\b/, openMenu);
  bot.onText(/^\/menu\b/, openMenu);
  bot.onText(/^\/admin\b/, async (msg) => { if (isAdmin(msg.from.id)) bot.sendMessage(msg.chat.id, "🛠 Admin Panel", await adminPanel()); });
  bot.onText(/^\/tester\b/, async (msg) => {
    if (!requireUsername(msg.from, msg.chat.id)) return;
    await claimTesterFlow(msg.chat.id, await ensureUser(msg.from));
  });
  bot.onText(/^\/setlimit\s+(\d+)\s+(\d+)\s+(\d+)/, async (msg, m) => {
    if (!isAdmin(msg.from.id)) return;
    const u = await store.setLimits(m[1], m[2], m[3]);
    bot.sendMessage(msg.chat.id, u ? `📏 #${u.id}: daily ${u.daily_limit || "∞"}, total ${u.total_limit || "∞"}.` : "No such user.");
  });
  // ── Billing commands (admin, arbitrary amounts) ──
  bot.onText(/^\/gprice\s+([\d.]+)/, async (msg, m) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, `🌐 Global price → ${await store.setGlobalPrice(m[1])}`);
  });
  // ── Server 4 (Fayda app v1.1.9) App Check token (admin/super-admin) ──
  // `/server4token <jwt>` sets it; `/server4token` alone shows status. The
  // token is short-lived (~1h); refresh it here when Server 4 starts failing.
  bot.onText(/^\/server4token(?:\s+(\S+))?\s*$/, async (msg, m) => {
    if (!isAdmin(msg.from.id)) return;
    const token = (m[1] || "").trim();
    if (!token) {
      const info = await store.getServer4TokenInfo();
      return bot.sendMessage(msg.chat.id,
        `🔑 Server 4 App Check token: ${s4StatusLine(info)}\n\nTo update, send:\n\`/server4token <token>\`\n\nThe token is a device X-Firebase-AppCheck JWT, valid ~1 hour.`,
        { parse_mode: "Markdown" });
    }
    await store.setServer4Token(token);
    // Remove the pasted token from the chat history for hygiene.
    bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
    bot.sendMessage(msg.chat.id, `✅ Server 4 App Check token updated.\n${s4StatusLine(await store.getServer4TokenInfo())}`);
  });
  bot.onText(/^\/price\s+(\d+)\s+([\d.]+|global)/i, async (msg, m) => {
    if (!isAdmin(msg.from.id)) return;
    const u = await store.setPrice(m[1], /global/i.test(m[2]) ? "" : m[2]);
    bot.sendMessage(msg.chat.id, u ? `Price for #${u.id}: ${u.price_override != null ? u.price_override : "global (" + (await store.globalPrice()) + ")"}` : "No such user.");
  });
  bot.onText(/^\/topup\s+(\d+)\s+([\d.]+)/, async (msg, m) => {
    if (!isAdmin(msg.from.id)) return;
    const u = await store.topUp(m[1], m[2]);
    bot.sendMessage(msg.chat.id, u ? `💰 #${u.id} balance: ${u.balance}` : "No such user.");
  });
  bot.onText(/^\/credit\s+(\d+)\s+([\d.]+)/, async (msg, m) => {
    if (!isAdmin(msg.from.id)) return;
    const u = await store.setCreditLimit(m[1], m[2]);
    bot.sendMessage(msg.chat.id, u ? `🧾 #${u.id} credit limit: ${u.credit_limit}` : "No such user.");
  });
  bot.onText(/^\/mode\s+(\d+)\s+(counter|prepaid|postpaid)/i, async (msg, m) => {
    if (!isAdmin(msg.from.id)) return;
    const u = await store.setBillingMode(m[1], m[2].toLowerCase());
    bot.sendMessage(msg.chat.id, u ? `💳 #${u.id} mode: ${u.billing_mode}` : "No such user.");
  });
  bot.onText(/^\/settle\s+(\d+)/, async (msg, m) => {
    if (!isAdmin(msg.from.id)) return;
    const u = await store.settleOwed(m[1]);
    bot.sendMessage(msg.chat.id, u ? `🧾 #${u.id} owed reset to 0` : "No such user.");
  });

  async function claimTesterFlow(chatId, u) {
    if (u.trial_claimed) {
      await bot.sendMessage(chatId, "ℹ️ You already claimed your free tester key. Use the menu (Revoke & Replace to get a fresh key, My Usage to check your count).");
      await sendTester(chatId);
      return;
    }
    const res = await store.claimTrial(u.id, env.TRIAL_REWARD_COUNT);
    if (!res) { await bot.sendMessage(chatId, "ℹ️ Trial already claimed."); return; }
    await sendKey(chatId, res.rawKey, `🎁 Reward: ${env.TRIAL_REWARD_COUNT} free generations!\n🔑 Your tester API key (shown once):`);
    await sendTester(chatId);
    await bot.sendMessage(chatId, "📄 For the full developer guide, tap “Request Full Access + Docs”.");
  }

  // Manual numeric input for the admin "Set Price / Add Balance / Postpaid
  // Limit / Global Price" prompts. Only acts when that chat has a pending ask;
  // ignores everything else so normal commands/messages pass through untouched.
  bot.on("message", async (msg) => {
    try {
      const key = String(msg.chat.id);

      // (a) User payment receipt capture (text, photo, or PDF/document).
      const pr = pendingReceipt.get(key);
      if (pr) {
        const caption = String(msg.text || msg.caption || "").trim();
        if (caption && /^\/cancel\b/i.test(caption)) { pendingReceipt.delete(key); bot.sendMessage(msg.chat.id, "✖️ Payment cancelled."); return; }
        let receiptKind = null, receiptText = null, receiptFileId = null;
        if (Array.isArray(msg.photo) && msg.photo.length) {
          receiptKind = "photo"; receiptFileId = msg.photo[msg.photo.length - 1].file_id; receiptText = msg.caption ? String(msg.caption) : null;
        } else if (msg.document) {
          receiptKind = "document"; receiptFileId = msg.document.file_id; receiptText = msg.caption ? String(msg.caption) : null;
        } else if (caption) {
          receiptKind = "text"; receiptText = caption;
        } else {
          bot.sendMessage(msg.chat.id, "Send the receipt as text, a photo, or a PDF — or /cancel.");
          return;
        }
        pendingReceipt.delete(key);
        const owner = await store.getUserById(pr.userId);
        const req = await store.createPaymentRequest({
          userId: pr.userId, scope: pr.scope, saveId: pr.saveId, amount: pr.amount,
          receiptKind, receiptText, receiptFileId
        });
        await bot.sendMessage(msg.chat.id, `✅ Receipt submitted (request #${req.id}, ${money(pr.amount)}). An admin will review it shortly.`);
        await notifyAdminsReceipt(req, owner);
        return;
      }

      // (b) Admin manual numeric input.
      const pend = pendingInput.get(key);
      if (!pend) return;
      const text = String(msg.text || "").trim();
      if (!text) return;
      if (text.startsWith("/")) {
        if (/^\/cancel\b/i.test(text)) { pendingInput.delete(key); bot.sendMessage(msg.chat.id, "✖️ Cancelled."); }
        return; // let other commands run normally
      }
      if (!isAdmin(msg.from.id)) { pendingInput.delete(key); return; }
      const num = Number(text.replace(/[, ]+/g, ""));
      if (!Number.isFinite(num) || num < 0) { bot.sendMessage(msg.chat.id, "Send a non-negative number, or /cancel."); return; }
      pendingInput.delete(key);
      const editMenu = (t, markup) => bot.editMessageText(t, { chat_id: pend.chatId, message_id: pend.msgId, ...(markup || {}) }).catch(() => {});
      if (pend.kind === "gprice") {
        const v = await store.setGlobalPrice(num);
        await bot.sendMessage(msg.chat.id, `🌐 Global price → ${v}`);
        const gm = await gpriceMenu(); return editMenu(gm.text, gm.markup);
      }
      const target = await store.getUserById(pend.userId);
      if (!target) { await bot.sendMessage(msg.chat.id, "No such user."); return; }
      if (pend.kind === "price") { await store.setPrice(target.id, num); await bot.sendMessage(msg.chat.id, `💲 Price for #${target.id} → ${money(num)}`); }
      else if (pend.kind === "topup") { const uu = await store.topUp(target.id, num); await bot.sendMessage(msg.chat.id, `💵 #${target.id} balance → ${money(uu.balance)}`); }
      else if (pend.kind === "credit") { const uu = await store.setCreditLimit(target.id, num); await bot.sendMessage(msg.chat.id, `🧾 #${target.id} postpaid limit → ${money(uu.credit_limit)}`); }
      const bm = await billingMenu(await store.getUserById(target.id)); return editMenu(bm.text, bm.markup);
    } catch (e) { console.warn("[tg input]", e?.message || e); }
  });

  bot.on("callback_query", async (q) => {
    const fromId = q.from.id;
    const chatId = q.message.chat.id;
    const msgId = q.message.message_id;
    const data = String(q.data || "");
    const ack = (text) => bot.answerCallbackQuery(q.id, text ? { text } : undefined).catch(() => {});
    const edit = (text, markup) => bot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...(markup || {}) }).catch(() => {});
    const reRenderMenu = async (u) => { const m = await userMenu(u, isAdmin(fromId)); return edit(m.text, m.markup); };

    // Any button press abandons a half-finished manual-input / receipt prompt for
    // this chat. (The ask*/pay* handlers below re-set it immediately after.)
    pendingInput.delete(String(chatId));
    pendingReceipt.delete(String(chatId));

    try {
      if (data.startsWith("u:")) {
        if (!q.from.username) return ack("Set a Telegram username first");
        const u = await ensureUser(q.from);
        const uparts = data.split(":");
        const action = uparts[1];
        if (action === "request") {
          if (u.status === "approved") ack("Already approved");
          else { await store.setUserStatus(u.id, "pending"); ack("Request sent — admin will review"); notifyAdmins(`🆕 Access+docs request from @${u.username || "?"} (id #${u.id})`); }
        } else if (action === "usage" || action === "saves") { ack(); await bot.sendMessage(chatId, await userSavesText(u)); }
        else if (action === "tester") { ack("Issuing tester key…"); await claimTesterFlow(chatId, u); }
        else if (action === "addbalance") {
          // Pre-CBE: notify admins to top up manually. (CBE self-service drops in here.)
          ack("Admins notified");
          const s = await store.getUserStats(u.id);
          notifyAdmins(`💵 @${u.username || "?"} (#${u.id}) wants to ADD BALANCE.\nDebt: ${money(s.debt)} · balance: ${money(s.balance)}. Open their Billing to top up.`);
          await bot.sendMessage(chatId, "💵 An admin has been notified to add your balance. (Direct CBE payment is coming soon.)");
        }
        else if (action === "pay") { ack(); const pm = await userPayMenu(u); return edit(pm.text, pm.markup); }
        else if (action === "payall") {
          const unpaid = await store.listUnpaidSaves(u.id);
          if (!unpaid.length) { ack("Nothing to pay"); const pm = await userPayMenu(u); return edit(pm.text, pm.markup); }
          const s = await store.getUserStats(u.id);
          pendingReceipt.set(String(chatId), { userId: u.id, scope: "all", saveId: null, amount: s.debtSaved });
          ack();
          return edit(`💳 Pay All — ${money(s.debtSaved)}\n\nSend your payment receipt now: paste the transaction ID / SMS text, or send a photo/PDF of the receipt.\n(Send /cancel to abort.)`,
            { reply_markup: { inline_keyboard: [[{ text: "⬅ Cancel", callback_data: "u:pay" }]] } });
        }
        else if (action === "payone") {
          const sv = (await store.listUnpaidSaves(u.id)).find((x) => String(x.id) === String(uparts[2]));
          if (!sv) { ack("Already settled"); const pm = await userPayMenu(u); return edit(pm.text, pm.markup); }
          pendingReceipt.set(String(chatId), { userId: u.id, scope: "one", saveId: sv.id, amount: sv.amount });
          ack();
          return edit(`💳 Pay #${sv.id} — ${money(sv.amount)}\n\nSend your payment receipt now: paste the transaction ID / SMS text, or send a photo/PDF of the receipt.\n(Send /cancel to abort.)`,
            { reply_markup: { inline_keyboard: [[{ text: "⬅ Cancel", callback_data: "u:pay" }]] } });
        }
        else if (action === "pausekey") { await store.setKeyStatus(u.id, "paused"); ack("Key paused"); }
        else if (action === "resumekey") { await store.setKeyStatus(u.id, "active"); ack("Key active"); }
        else if (action === "revokekey") {
          if (uparts[2] !== "yes") {
            ack();
            return edit("🗑 Revoke & replace your key?\nThe old key stops working immediately (usage is kept).",
              confirmKb("u:revokekey:yes", "u:menu"));
          }
          const { rawKey } = await store.revokeAndReissue(u.id);
          ack("Old key deleted · new key issued");
          await sendKey(chatId, rawKey, "🗑→🔑 Old key deleted. Your usage is kept.\nNew API key (shown once):");
        }
        return reRenderMenu(await store.getUserById(u.id));
      }

      if (data.startsWith("a:")) {
        if (!isAdmin(fromId)) return ack("Admins only");
        const parts = data.split(":");
        const action = parts[1];

        if (action === "panel") { ack(); return edit("🛠 Admin Panel", await adminPanel()); }
        if (action === "pending" || action === "users") {
          ack();
          const list = action === "pending" ? await store.listPendingUsers() : await store.listUsers();
          if (!list.length) return edit(action === "pending" ? "⏳ No pending requests." : "👥 No users yet.", await adminPanel());
          const rows = list.slice(0, 12).map((u) => [{ text: `${u.username ? "@" + u.username : u.telegram_id} · #${u.id} (${u.status})`, callback_data: `a:user:${u.id}` }]);
          rows.push([{ text: "⬅ Panel", callback_data: "a:panel" }]);
          return edit(`${action === "pending" ? "⏳ Pending" : "👥 Users"} (${list.length})`, { reply_markup: { inline_keyboard: rows } });
        }
        if (action === "gprice") { ack(); const gm = await gpriceMenu(); return edit(gm.text, gm.markup); }
        if (action === "gset") { await store.setGlobalPrice(parts[2]); ack(`Global price → ${parts[2]}`); const gm = await gpriceMenu(); return edit(gm.text, gm.markup); }
        if (action === "askgprice") {
          pendingInput.set(String(fromId), { kind: "gprice", chatId, msgId });
          ack();
          return edit("✏️ Send the new GLOBAL price per generation as a number.\n(Send /cancel to abort.)",
            { reply_markup: { inline_keyboard: [[{ text: "⬅ Cancel", callback_data: "a:gprice" }]] } });
        }
        if (action === "noop") { return ack(); }
        // Payment-request review: parts[2] = request id.
        if (action === "payok" || action === "payno") {
          const req = await store.getPaymentRequest(parts[2]);
          if (!req) return ack("Request gone");
          if (req.status !== "pending") { return ack(`Already ${req.status}`); }
          const owner = await store.getUserById(req.user_id);
          if (action === "payok") {
            if (req.scope === "all") await store.markAllUnpaidPaid(req.user_id);
            else if (req.save_id != null) await store.markSavePaid(req.save_id, true);
            await store.decidePaymentRequest(req.id, "approved", fromId);
            ack("Approved · marked paid");
            if (owner && owner.telegram_id) bot.sendMessage(owner.telegram_id, `✅ Your payment (request #${req.id}, ${money(req.amount)}) was approved. Thank you!`).catch(() => {});
          } else {
            await store.decidePaymentRequest(req.id, "rejected", fromId);
            ack("Rejected");
            if (owner && owner.telegram_id) bot.sendMessage(owner.telegram_id, `🚫 Your payment (request #${req.id}) was rejected. Please check it and resend a valid receipt.`).catch(() => {});
          }
          // Strip the buttons from the admin's message so it can't be re-decided.
          try { await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: action === "payok" ? "✅ Approved" : "🚫 Rejected", callback_data: "a:noop" }]] }, { chat_id: chatId, message_id: msgId }); } catch (_) {}
          return;
        }
        // Save/payment-targeted actions: parts[2] = saveId, parts[3] = userId.
        if (action === "clearsave" || action === "markpaid" || action === "markunpaid") {
          const saveId = parts[2], ownerId = parts[3], confirmed = parts[4] === "yes";
          if ((action === "clearsave" || action === "markpaid") && !confirmed) {
            ack();
            const ask = action === "clearsave" ? "🗑 Delete this saved payment record?" : "✅ Mark this payment as PAID?";
            return edit(ask, confirmKb(`a:${action}:${saveId}:${ownerId}:yes`, `a:saves:${ownerId}`));
          }
          if (action === "clearsave") { await store.clearSave(saveId); ack("Save cleared"); }
          else if (action === "markpaid") { await store.markSavePaid(saveId, true); ack("Marked paid"); }
          else { await store.markSavePaid(saveId, false); ack("Marked unpaid"); }
          const owner = await store.getUserById(ownerId);
          if (owner) { const sm = await adminSavesMenu(owner); return edit(sm.text, sm.markup); }
          return edit("🛠 Admin Panel", await adminPanel());
        }
        if (action === "s4token") {
          ack();
          const info = await store.getServer4TokenInfo();
          return edit(
            `🔑 Server 4 App Check token\n${s4StatusLine(info)}\n\nTo update, send a message:\n/server4token <token>\n\nDevice X-Firebase-AppCheck JWT, valid ~1 hour.`,
            { reply_markup: { inline_keyboard: [[{ text: "⬅ Panel", callback_data: "a:panel" }]] } }
          );
        }

        const target = await store.getUserById(parts[2]);
        if (!target) return ack("No such user");

        if (action === "user") { ack(); const c = await userCard(target); return edit(c.text, c.markup); }
        if (action === "limits") { ack(); const lm = limitsMenu(target); return edit(lm.text, lm.markup); }
        if (action === "saves") { ack(); const sm = await adminSavesMenu(target); return edit(sm.text, sm.markup); }

        if (action === "approve") {
          await store.setUserStatus(target.id, "approved");
          // Approved = unlimited counter. Reset billing to counter and clear any
          // leftover trial cap so approval never stops at the trial limit.
          await store.setBillingMode(target.id, "counter");
          await store.setLimits(target.id, 0, 0);
          const { rawKey } = await store.issueKey(target.id);
          ack("Approved (unlimited) + key + docs sent");
          if (target.telegram_id) {
            await sendKey(target.telegram_id, rawKey, "🎉 Approved! Your API key (shown once):").catch(() => {});
            await bot.sendMessage(target.telegram_id, "✅ Your account is approved — unlimited generations.").catch(() => {});
            await sendDocs(target.telegram_id);
          }
        } else if (action === "billing") {
          ack(); const bm = await billingMenu(target); return edit(bm.text, bm.markup);
        } else if (action === "mode") {
          await store.setBillingMode(target.id, parts[3]); ack(`Mode → ${parts[3]}`);
          const bm = await billingMenu(await store.getUserById(target.id)); return edit(bm.text, bm.markup);
        } else if (action === "askprice" || action === "asktopup" || action === "askcredit") {
          const kind = action === "askprice" ? "price" : action === "asktopup" ? "topup" : "credit";
          pendingInput.set(String(fromId), { kind, userId: target.id, chatId, msgId });
          const label = kind === "price" ? "new price per generation"
            : kind === "topup" ? "amount to ADD to the balance"
            : "postpaid credit limit";
          ack();
          return edit(`✏️ Send the ${label} for ${target.username ? "@" + target.username : "#" + target.id} as a number.\n(Send /cancel to abort.)`,
            { reply_markup: { inline_keyboard: [[{ text: "⬅ Cancel", callback_data: `a:billing:${target.id}` }]] } });
        } else if (action === "topup") {
          await store.topUp(target.id, parts[3]); ack(`+${parts[3]} added`);
          const bm = await billingMenu(await store.getUserById(target.id)); return edit(bm.text, bm.markup);
        } else if (action === "price") {
          await store.setPrice(target.id, parts[3] === "clear" ? "" : parts[3]); ack("Price set");
          const bm = await billingMenu(await store.getUserById(target.id)); return edit(bm.text, bm.markup);
        } else if (action === "credit") {
          await store.setCreditLimit(target.id, parts[3]); ack(`Credit limit ${parts[3]}`);
          const bm = await billingMenu(await store.getUserById(target.id)); return edit(bm.text, bm.markup);
        } else if (action === "settle") {
          if (parts[3] !== "yes") { ack(); return edit(`🧾 Settle owed for ${target.username ? "@" + target.username : "#" + target.id} to 0?`, confirmKb(`a:settle:${target.id}:yes`, `a:billing:${target.id}`)); }
          await store.settleOwed(target.id); ack("Owed reset to 0");
          const bm = await billingMenu(await store.getUserById(target.id)); return edit(bm.text, bm.markup);
        } else if (action === "paidnow") {
          if (parts[3] !== "yes") {
            const s = await store.getUserStats(target.id);
            ack();
            return edit(`✅ Mark current debt for ${target.username ? "@" + target.username : "#" + target.id} as PAID?\nSnapshots this period (${money(s.debtLive)}) as a paid payment and resets the counter.`,
              confirmKb(`a:paidnow:${target.id}:yes`, `a:billing:${target.id}`));
          }
          const r = await store.settleCurrentPaid(target.id); ack(`Settled ${money(r.amount)} as paid`);
          const bm = await billingMenu(await store.getUserById(target.id)); return edit(bm.text, bm.markup);
        } else if (action === "senddocs") {
          ack("Docs sent");
          if (target.telegram_id) await sendDocs(target.telegram_id).catch(() => {});
        } else if (action === "pause") {
          await store.setUserStatus(target.id, "paused"); ack("Paused");
          if (target.telegram_id) bot.sendMessage(target.telegram_id, "⏸️ Your API access was paused by an admin.").catch(() => {});
        } else if (action === "resume") {
          await store.setUserStatus(target.id, "approved"); ack("Resumed");
          if (target.telegram_id) bot.sendMessage(target.telegram_id, "▶️ Your API access was resumed.").catch(() => {});
        } else if (action === "revoke") {
          if (parts[3] !== "yes") {
            ack();
            return edit(`🗑 Revoke ${target.username ? "@" + target.username : "#" + target.id}?\nThis blocks their access and revokes their key.`,
              confirmKb(`a:revoke:${target.id}:yes`, `a:user:${target.id}`));
          }
          await store.setUserStatus(target.id, "revoked"); await store.setKeyStatus(target.id, "revoked"); ack("Revoked");
          if (target.telegram_id) bot.sendMessage(target.telegram_id, "🗑️ Your API access was revoked.").catch(() => {});
        } else if (action === "daily") {
          await store.setLimits(target.id, parts[3], target.total_limit); ack("Daily set");
          const lm = limitsMenu(await store.getUserById(target.id)); return edit(lm.text, lm.markup);
        } else if (action === "total") {
          await store.setLimits(target.id, target.daily_limit, parts[3]); ack("Total set");
          const lm = limitsMenu(await store.getUserById(target.id)); return edit(lm.text, lm.markup);
        } else if (action === "save") {
          const r = await store.saveCounterAndReset(target.id);
          ack(`Saved ${r.saved} gens = ${money(r.amount)} (unpaid), counter reset`);
        }

        const c = await userCard(await store.getUserById(target.id));
        return edit(c.text, c.markup);
      }

      ack();
    } catch (err) {
      console.warn("[tg callback error]", err?.message || err);
      ack("Error");
    }
  });

  bot.on("polling_error", (err) => console.warn("[tg polling_error]", err?.message || err));
  console.error(`Telegram management bot started (button UI, ${env.ADMIN_TELEGRAM_IDS.length} admin(s)).`);
  return bot;
}

module.exports = { start };
