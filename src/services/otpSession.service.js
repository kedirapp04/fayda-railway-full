const env = require("../config/env");
const { generateSessionId } = require("../utils/crypto");

// In-memory OTP session store. A session is created at send-otp and consumed
// at verify-otp. Sessions expire after SESSION_TTL_MINUTES. This is a gateway
// concern only — nothing is persisted (the gateway is stateless across
// restarts by design; an expired/unknown session just asks the caller to
// restart with a fresh send-otp).

const sessions = new Map();

function ttlMs() {
  return Math.max(1, env.SESSION_TTL_MINUTES) * 60_000;
}

function createSession(data) {
  const id = generateSessionId();
  sessions.set(id, { id, createdAt: Date.now(), ...data });
  return id;
}

function getSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.createdAt > ttlMs()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function deleteSession(id) {
  sessions.delete(id);
}

// Periodic sweep so the map doesn't grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - ttlMs();
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
}, 60_000).unref();

module.exports = { createSession, getSession, deleteSession };
