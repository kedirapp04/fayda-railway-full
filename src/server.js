require("./log"); // install the LOG_LEVEL console gate first

const app = require("./app");
const env = require("./config/env");
const db = require("./db");
const telegramBot = require("./telegram/bot");

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", (reason && (reason.stack || reason.message)) || reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", (err && (err.stack || err.message)) || err);
});

(async () => {
  try {
    await db.init(); // idempotent Supabase schema bootstrap
    console.error("DB schema ready (Supabase).");
  } catch (err) {
    console.error("FATAL: could not initialise the database:", err?.message || err);
    process.exit(1);
  }

  app.listen(env.PORT, () => {
    console.error(`fayda-railway listening on :${env.PORT}`);
    try {
      telegramBot.start();
    } catch (err) {
      console.error("Failed to start Telegram bot:", err?.message || err);
    }
  });
})();
