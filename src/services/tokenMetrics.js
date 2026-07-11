// In-memory App Check token telemetry for the 🎫 Tokens dashboard.
// Counters + a ring buffer of recent events. No persistence (resets on restart
// by design) and no secrets — full tokens never enter here, only previews the
// caller passes. See src/services/server4TokenUpdater.js (takes) and
// src/integrations/fayda/server3AuthFlow.js (authorize cache).

const MAX_EVENTS = 200;

const counters = {
  takesOk: 0,        // fresh tokens successfully drawn from the pool
  takesFailed: 0,    // pool empty / CSRF-401 / network — fell back to static
  nearExpiry: 0,     // takes that came back with < 60s of life
  cacheHits: 0,      // authorize template served from cache (0 tokens)
  refreshes: 0,      // authorize template refreshed (1 token)
  callbackTakes: 0,  // takes spent at the Phase-3 callback (the real PDF cost)
  staticRefreshes: 0 // background auto-updater refreshing the static fallback
};

const events = []; // { at, icon, msg } newest last

function push(icon, msg) {
  events.push({ at: Date.now(), icon, msg });
  if (events.length > MAX_EVENTS) events.shift();
}

// A fresh token was drawn. purpose ∈ authorize|callback|static-refresh|request.
function recordTake(purpose = "request", remainingSec = null) {
  counters.takesOk++;
  if (purpose === "callback") counters.callbackTakes++;
  else if (purpose === "static-refresh") counters.staticRefreshes++;
  const near = remainingSec != null && remainingSec < 60;
  if (near) counters.nearExpiry++;
  push(near ? "⚠️" : "🎟️", `take (${purpose})${remainingSec != null ? ` · ${remainingSec}s left` : ""}${near ? " · near expiry" : ""}`);
}

function recordFailedTake(purpose = "request", reason = "") {
  counters.takesFailed++;
  push("❌", `failed take (${purpose})${reason ? ` — ${reason}` : ""} → static fallback`);
}

function recordCacheHit(ageSec = null) {
  counters.cacheHits++;
  push("💾", `authorize cache hit (0 tokens)${ageSec != null ? ` · age ${ageSec}s` : ""}`);
}

function recordRefresh() {
  counters.refreshes++;
  push("🔄", "authorize template refresh (1 token)");
}

// Point-in-time view for the dashboard: counters + the last N events (newest first).
function snapshot(eventLimit = 40) {
  const saved = counters.cacheHits; // ≈ authorize tokens NOT spent thanks to the cache
  return {
    counters: { ...counters },
    saved, // tokens saved by the authorize cache
    events: events.slice(-eventLimit).reverse()
  };
}

module.exports = { recordTake, recordFailedTake, recordCacheHit, recordRefresh, snapshot };
