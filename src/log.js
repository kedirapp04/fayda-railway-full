// Quiet-by-default logging gate. Railway bills on resources and a log flood can
// crash/cost; LOG_LEVEL controls how much reaches the console.
//   silent → nothing
//   error  → warn + error only (default)
//   all    → everything
const LEVEL = String(process.env.LOG_LEVEL || "error").toLowerCase();

const noop = () => {};

if (LEVEL === "silent") {
  console.log = noop;
  console.info = noop;
  console.debug = noop;
  console.warn = noop;
  console.error = noop;
} else if (LEVEL !== "all") {
  // default "error": drop chatty levels, keep warn/error
  console.log = noop;
  console.info = noop;
  console.debug = noop;
}

module.exports = { LEVEL };
