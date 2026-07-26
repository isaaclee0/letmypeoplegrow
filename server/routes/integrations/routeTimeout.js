'use strict';

// Shared aggregate-route-timeout helper for the provider-neutral
// integration routers (server/routes/integrations/elvanto.js and
// .../peopleSync.js). httpClient.js's own per-HTTP-request timeout (30s,
// see its DEFAULT_TIMEOUT_MS) bounds a SINGLE Elvanto call, but several
// handlers across both routers make MANY such calls synchronously inside
// one request:
//   - elvanto.js's GET /metadata cold path: a full-roster snapshot fetch
//     (fully paginated) PLUS the four-dimension membership index (four
//     more fully-paginated fetches) PLUS six more paginated
//     metadata-definition endpoint calls.
//   - peopleSync.js's POST /people-authority/preview and .../apply: both
//     force a full paginated roster snapshot via
//     previewAuthoritySwitch/applyReviewed — the exact same "many
//     sequential network calls in one request" shape.
// With no aggregate deadline, a slow/degraded provider account could tie up
// a request (and the admin's browser tab) indefinitely. withTimeout maps
// that to a clean 503 instead.
//
// It does NOT cancel the underlying in-flight network calls (that would
// need an AbortController threaded through httpClient.js — out of scope
// here) — it only stops the CALLING route from waiting on them past the
// deadline; the losing promise keeps running in the background, and its
// eventual result (or error) is simply discarded once the response has
// already been sent — UNLESS that background work has its own side effects
// that must still happen regardless (e.g. elvanto.js's run-now recording
// its own batch bookkeeping even after the client-facing response already
// timed out — see that route's own comment). Any such side effect MUST be
// included inside the SAME raced promise, never run only after a
// successfully-resolved race, or it silently never happens when the
// timeout wins.
const DEFAULT_ROUTE_TIMEOUT_MS = 110000; // just under the client's own 120s axios timeout for these calls

class RouteTimeoutError extends Error {
  constructor(ms) {
    super(`The request did not complete within ${ms}ms.`);
    this.name = 'RouteTimeoutError';
    this.code = 'SYNC_ROUTE_TIMEOUT';
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RouteTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { DEFAULT_ROUTE_TIMEOUT_MS, RouteTimeoutError, withTimeout };
