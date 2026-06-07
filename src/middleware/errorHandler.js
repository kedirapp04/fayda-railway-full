// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;
  const payload = { ok: false, error: err.publicMessage || err.message || "Internal server error." };
  if (process.env.NODE_ENV !== "production" && err.stack) {
    payload.stack = err.stack.split("\n").slice(0, 4);
  }
  if (status >= 500) console.error("[generator error]", err?.message || err);
  res.status(status).json(payload);
}

module.exports = errorHandler;
