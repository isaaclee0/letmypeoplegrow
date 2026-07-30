'use strict';

// Generic (provider-neutral) people-sync routes — Task 16 of the
// provider-neutral people-sync project. Everything here works identically
// for `planning_center` and `elvanto`: church-wide settings, the
// authority-switch preview/apply/disable flow, and a merged recent-runs
// feed. Provider-SPECIFIC concerns (connect/disconnect, batch CRUD,
// metadata discovery, per-batch plan/apply/run-now) live in
// server/routes/integrations/elvanto.js instead.
//
// Every dependency this router touches is injected via `deps` (see
// `defaultDeps` below) so route tests never need a real database, a real
// provider adapter, or a real network call — see peopleSync.test.js.
//
// Mirrors the orchestrator's own safety posture: no route here ever hands
// a raw/unexpected error message back to the client (see `respondWithError`
// below) — every OrchestratorError already carries a curated, credential-
// free `.message`/`.status`/`.code` (see orchestrator.js), and anything
// else is logged server-side and reported as a generic 500.
const express = require('express');
const logger = require('../../config/logger');
const Database = require('../../config/database');
const { requireRole } = require('../../middleware/auth');
const { ensureChurchIsolation } = require('../../middleware/churchIsolation');
const authority = require('../../services/peopleSync/authority');
const orchestrator = require('../../services/peopleSync/orchestrator');
const runRepository = require('../../services/peopleSync/runRepository');
const { ElvantoError } = require('../../services/elvanto/httpClient');
const { DEFAULT_ROUTE_TIMEOUT_MS, RouteTimeoutError, withTimeout } = require('./routeTimeout');

const { OrchestratorError } = orchestrator;

// A provider-neutral router still calls buildReview/applyReviewed/
// previewAuthoritySwitch with provider='elvanto' whenever an admin is
// previewing/applying an authority switch TO Elvanto — and, per
// orchestrator.js's own header note, those functions rethrow a provider
// adapter's own typed error UNWRAPPED (not as an OrchestratorError) whenever
// the failure happens during fetch. So this generic router needs to
// recognize ElvantoError too, exactly like elvanto.js does, rather than
// flattening a well-understood, safely-curated failure (invalid/expired key,
// Elvanto unavailable, a malformed response) into an opaque generic 500.
// Planning Center's own adapter has no equivalent typed error class today
// (see services/peopleSync/pcoAdapter.js), so there is nothing analogous to
// add for that provider yet.
const ELVANTO_ERROR_STATUS = {
  ELVANTO_AUTH: 401,
  ELVANTO_UNAVAILABLE: 503,
  ELVANTO_RESPONSE: 502,
  ELVANTO_PAGINATION: 502,
};

const RUN_PROVIDERS = ['planning_center', 'elvanto'];
const SETTINGS_ALLOWED_KEYS = new Set([
  'elvantoIncludeContacts', 'elvantoAlignPeopleType', 'fullReconciliationFrequency', 'fullReconciliationDay',
]);
const FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const DEFAULT_RUNS_LIMIT = 20;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ─── Settings (people_sync_settings) ────────────────────────────────────────

async function defaultGetSettings(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT authority_provider, pending_authority_provider, elvanto_include_contacts,
            elvanto_align_people_type, full_reconciliation_frequency, full_reconciliation_day
       FROM people_sync_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  const row = rows[0] || {};
  return {
    authorityProvider: row.authority_provider || 'none',
    pendingAuthorityProvider: row.pending_authority_provider || null,
    elvantoIncludeContacts: row.elvanto_include_contacts === undefined ? true : !!row.elvanto_include_contacts,
    elvantoAlignPeopleType: row.elvanto_align_people_type === undefined ? true : !!row.elvanto_align_people_type,
    fullReconciliationFrequency: row.full_reconciliation_frequency || 'weekly',
    fullReconciliationDay: Number.isInteger(row.full_reconciliation_day) ? row.full_reconciliation_day : 1,
  };
}

// Day range depends on the RESULTING frequency (existing or newly-supplied
// in this same patch) — weekly uses JS Date's 0-6 day-of-week convention,
// monthly uses a 1-31 day-of-month. Daily ignores the day value at run time
// (see scheduler.js's isDueToday), but an out-of-range integer is still
// rejected here rather than silently stored, since a later frequency change
// back to weekly/monthly would otherwise inherit a nonsensical day.
//
// `day` here is always the RESULTING value the caller resolved (this
// patch's own fullReconciliationDay if supplied, else whatever is already
// stored) — never just "was fullReconciliationDay present in this specific
// request", which is what let a frequency-only patch silently leave a
// stale, now-invalid day in place (e.g. stored {frequency:'monthly',day:20},
// patched to {frequency:'weekly'} alone — accepted, but
// scheduler.isDueToday('weekly', 20) is permanently false with no error
// anywhere). See validateSettingsPatch's own resultingDay computation.
function validateDayForFrequency(frequency, day) {
  if (day === undefined || day === null) return null;
  if (frequency === 'weekly' && (day < 0 || day > 6)) {
    return 'fullReconciliationDay must be between 0 and 6 (Sunday-Saturday) for a weekly schedule.';
  }
  if (frequency === 'monthly' && (day < 1 || day > 31)) {
    return 'fullReconciliationDay must be between 1 and 31 for a monthly schedule.';
  }
  if (frequency === 'daily' && (day < 0 || day > 31)) {
    return 'fullReconciliationDay must be between 0 and 31.';
  }
  return null;
}

// Strict allow-list validator: rejects an empty body, any unknown key, and
// any wrongly-typed value, listing every problem found (not just the
// first). Returns { errors } or { patch } — never both.
//
// `current` is the FULL currently-stored settings object (not just the
// frequency) — the day/frequency cross-check below needs both the patch's
// own values AND whichever of the two fields this specific request did NOT
// supply, so a frequency-only (or day-only) patch is validated against the
// RESULTING pair, not just whatever happens to be present in this request.
function validateSettingsPatch(body, current) {
  if (!isPlainObject(body)) return { errors: ['Request body must be an object.'] };
  const keys = Object.keys(body);
  if (keys.length === 0) return { errors: ['At least one setting must be provided.'] };

  const errors = [];
  for (const key of keys) {
    if (!SETTINGS_ALLOWED_KEYS.has(key)) errors.push(`Unknown setting: ${key}`);
  }
  if (errors.length > 0) return { errors };

  const patch = {};
  if (Object.hasOwn(body, 'elvantoIncludeContacts')) {
    if (typeof body.elvantoIncludeContacts !== 'boolean') errors.push('elvantoIncludeContacts must be a boolean.');
    else patch.elvantoIncludeContacts = body.elvantoIncludeContacts;
  }
  if (Object.hasOwn(body, 'elvantoAlignPeopleType')) {
    if (typeof body.elvantoAlignPeopleType !== 'boolean') errors.push('elvantoAlignPeopleType must be a boolean.');
    else patch.elvantoAlignPeopleType = body.elvantoAlignPeopleType;
  }
  if (Object.hasOwn(body, 'fullReconciliationFrequency')) {
    if (!FREQUENCIES.has(body.fullReconciliationFrequency)) {
      errors.push('fullReconciliationFrequency must be "daily", "weekly", or "monthly".');
    } else {
      patch.fullReconciliationFrequency = body.fullReconciliationFrequency;
    }
  }
  if (Object.hasOwn(body, 'fullReconciliationDay')) {
    if (!Number.isInteger(body.fullReconciliationDay)) errors.push('fullReconciliationDay must be an integer.');
    else patch.fullReconciliationDay = body.fullReconciliationDay;
  }
  if (errors.length > 0) return { errors };

  const resultingFrequency = patch.fullReconciliationFrequency || current.fullReconciliationFrequency;
  const resultingDay = Object.hasOwn(patch, 'fullReconciliationDay')
    ? patch.fullReconciliationDay : current.fullReconciliationDay;
  const dayError = validateDayForFrequency(resultingFrequency, resultingDay);
  if (dayError) return { errors: [dayError] };

  return { patch };
}

async function defaultUpdateSettings(churchId, patch) {
  const current = await defaultGetSettings(churchId);
  const next = { ...current, ...patch };
  await Database.queryForChurch(
    churchId,
    `INSERT INTO people_sync_settings
       (church_id, elvanto_include_contacts, elvanto_align_people_type,
        full_reconciliation_frequency, full_reconciliation_day)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(church_id) DO UPDATE SET
       elvanto_include_contacts = excluded.elvanto_include_contacts,
       elvanto_align_people_type = excluded.elvanto_align_people_type,
       full_reconciliation_frequency = excluded.full_reconciliation_frequency,
       full_reconciliation_day = excluded.full_reconciliation_day,
       updated_at = datetime('now')`,
    [
      churchId,
      next.elvantoIncludeContacts ? 1 : 0,
      next.elvantoAlignPeopleType ? 1 : 0,
      next.fullReconciliationFrequency,
      next.fullReconciliationDay,
    ]
  );
  return defaultGetSettings(churchId);
}

// ─── Recent runs (merged across every provider) ─────────────────────────────

async function defaultListAllRecentRuns(churchId, limit) {
  const perProvider = await Promise.all(
    RUN_PROVIDERS.map((provider) => runRepository.listRecentRuns(churchId, provider, limit))
  );
  return perProvider.flat().sort((a, b) => b.id - a.id).slice(0, limit);
}

// runRepository's own stored errorMessage already passes through a fairly
// strict sanitizer at WRITE time (normaliseSafeAuditText — no
// credential-shaped content, no serialized payloads, no bearer/basic
// tokens; see runRepository.js), but that is a different, narrower bar
// than the rest of THIS API holds itself to: every other route here only
// ever returns a small, fixed, curated message per error CODE (see
// respondWithError above), never a raw stored/thrown message — which could
// still carry other internal detail a credential-focused sanitizer was
// never trying to catch (a raw SQLite error string, an internal hostname,
// etc.). Maps each run's errorCode to that same convention instead of ever
// echoing the raw stored errorMessage back over this API.
//
// SYNC_RUN_FAILED deserves its own explicit entry, not just the generic
// fallback below: it is orchestrator.js's safeErrorCode() catch-all for
// ANY thrown value without a recognized `.code` — i.e. the entire
// "genuinely unexpected bug" bucket, which is exactly the case an admin
// most needs SOME diagnostic signal for, not the LEAST. Its text is
// necessarily generic (there is no more specific fact to report), but it
// is deliberately distinguished from "an error code this table doesn't
// know about yet" so the two don't read identically.
const RUN_ERROR_MESSAGES = {
  PCO_LEGACY_BATCH_RETIRED: 'This legacy Planning Center batch is retired and can only be viewed or deleted.',
  SYNC_PROVIDER_INVALID: 'Unsupported people-sync provider.',
  SYNC_CHURCH_REQUIRED: 'A church context was required.',
  SYNC_NOT_CONNECTED: 'No connection was configured for this provider.',
  SYNC_CONNECTION_INVALID: 'The provider connection was marked invalid.',
  SYNC_BATCH_NOT_FOUND: 'The batch for this run was not found.',
  SYNC_BATCH_DISABLED: 'The batch for this run was disabled.',
  SYNC_NO_BATCHES: 'No enabled batches were available for this run.',
  SYNC_BATCH_FILTER_INVALID: 'The batch filter was invalid.',
  SYNC_FETCH_INCOMPLETE: 'The provider fetch did not return a complete result.',
  SYNC_SOURCE_SELECTION_REQUIRED: 'A sync source must be selected for every enabled batch.',
  SYNC_SOURCE_REVIEW_REQUIRED: 'A pending sync source selection must be reviewed before this run can continue.',
  SYNC_SOURCE_UNAVAILABLE: 'The selected provider source is no longer available.',
  SYNC_SOURCE_INCOMPLETE: 'The provider source did not return a complete result.',
  SYNC_SOURCE_AUTH: 'The provider rejected the stored connection credentials.',
  SYNC_SOURCE_RATE_LIMIT: 'The provider rate-limited this source read. Try again later.',
  SYNC_TRIGGER_INVALID: 'An invalid run trigger was used.',
  SYNC_REVIEW_INVALID: 'The review token was invalid.',
  SYNC_REVIEW_EXPIRED: 'The review had expired.',
  SYNC_PLAN_STALE: 'The reviewed plan was out of date.',
  SYNC_SELECTIONS_INVALID: 'The submitted selections were invalid.',
  SYNC_BATCH_REQUIRED: 'A batch was required for this run.',
  SYNC_AUTHORITY_MISMATCH: 'The provider was not the active people-sync authority for this church.',
  SYNC_ROUTE_TIMEOUT: 'The run timed out.',
  SYNC_RUN_FAILED: 'This sync run failed unexpectedly. See server logs for details.',
  SYNC_REVIEW_SECRET: 'The server is missing its review-signing configuration (SYNC_REVIEW_SECRET/JWT_SECRET). Contact support.',
  ELVANTO_AUTH: 'Elvanto rejected the stored API key.',
  ELVANTO_UNAVAILABLE: 'Elvanto was temporarily unavailable.',
  ELVANTO_RESPONSE: 'Elvanto returned an unexpected response.',
  ELVANTO_PAGINATION: 'Elvanto returned an unexpected response.',
  ELVANTO_RECONNECT_REQUIRED: 'Elvanto has multiple different stored credentials for this church and needs to be reconnected.',
};

function sanitizeRunErrorMessage(errorCode) {
  if (!errorCode) return null;
  return RUN_ERROR_MESSAGES[errorCode] || 'This sync run failed for an unrecognized reason. See server logs for details.';
}

// Never spreads the underlying run object's OWN errorMessage through —
// always rebuilds it from errorCode, so a run row this app didn't sanitize
// as strictly at write time (or a future error code not yet in
// RUN_ERROR_MESSAGES) still can't leak internal detail through this route.
function sanitizeRunForResponse(run) {
  return { ...run, errorMessage: sanitizeRunErrorMessage(run.errorCode) };
}

// ─── Default (production) collaborators ─────────────────────────────────────

const defaultDeps = {
  routeTimeoutMs: DEFAULT_ROUTE_TIMEOUT_MS,
  getSettings: defaultGetSettings,
  updateSettings: defaultUpdateSettings,
  getAuthority: authority.getAuthority,
  disableAuthority: authority.disableAuthority,
  previewAuthoritySwitch: orchestrator.previewAuthoritySwitch,
  applyReviewed: orchestrator.applyReviewed,
  listAllRecentRuns: defaultListAllRecentRuns,
};

// ─── Safe error mapping ──────────────────────────────────────────────────────
//
//   - RouteTimeoutError (see routeTimeout.js): the aggregate deadline on
//     /people-authority/preview or /apply was exceeded — always a safe
//     503, never leaks which specific network call was still in flight.
//   - OrchestratorError already carries a curated, credential-free
//     `.message`, a `.code`, and the correct HTTP `.status` (see
//     orchestrator.js) for every typed failure it can throw —
//     SYNC_PROVIDER_INVALID/SYNC_CHURCH_REQUIRED/SYNC_NOT_CONNECTED/
//     SYNC_CONNECTION_INVALID/SYNC_BATCH_NOT_FOUND/SYNC_BATCH_DISABLED/
//     SYNC_NO_BATCHES/SYNC_BATCH_FILTER_INVALID/SYNC_FETCH_INCOMPLETE/
//     SYNC_TRIGGER_INVALID/SYNC_REVIEW_INVALID/SYNC_REVIEW_EXPIRED/
//     SYNC_PLAN_STALE/SYNC_SELECTIONS_INVALID/SYNC_BATCH_REQUIRED/
//     SYNC_AUTHORITY_MISMATCH — so those are passed through as-is.
//   - ElvantoError (see below).
//   - anything else (a provider adapter's own typed error propagating
//     unwrapped through buildReview/applyReviewed/previewAuthoritySwitch/
//     runUnattended's rethrow, or a genuinely unexpected bug) is logged
//     server-side in full and reported to the client as a generic, safe
//     500 — never the raw `.message`, which could in principle carry
//     provider response detail never meant for the browser.
function respondWithError(res, err, logLabel) {
  if (err instanceof RouteTimeoutError) {
    return res.status(503).json({ error: 'The request took too long to complete. Please try again.', code: err.code });
  }
  if (err instanceof OrchestratorError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  if (err instanceof ElvantoError) {
    if (err.code === 'ELVANTO_AUTH') {
      return res.status(401).json({ error: 'Elvanto rejected the stored API key. Reconnect Elvanto to continue.', code: err.code });
    }
    const status = ELVANTO_ERROR_STATUS[err.code] || 502;
    const message = err.code === 'ELVANTO_UNAVAILABLE'
      ? 'Elvanto is currently unavailable. Please try again shortly.'
      : 'Elvanto returned an unexpected response. Please try again shortly.';
    return res.status(status).json({ error: message, code: err.code });
  }
  logger.error(`${logLabel}: ${err && err.message}`, { stack: err && err.stack });
  return res.status(500).json({ error: 'An unexpected error occurred.' });
}

function createPeopleSyncRouter(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  // Defense in depth: this subrouter is only ever mounted (in
  // routes/integrations.js) behind verifyToken/ensureChurchIsolation/
  // requireRole(['admin']) already, but re-asserting the church-isolation
  // and admin-only checks here means this file's own safety does not
  // silently depend on always being mounted exactly right one layer up.
  router.use(ensureChurchIsolation);
  router.use(requireRole(['admin']));

  router.get('/settings', async (req, res) => {
    try {
      const settings = await deps.getSettings(req.user.church_id);
      res.json({ success: true, settings });
    } catch (err) {
      respondWithError(res, err, 'people-sync GET /settings');
    }
  });

  router.put('/settings', async (req, res) => {
    try {
      const churchId = req.user.church_id;
      const current = await deps.getSettings(churchId);
      const { errors, patch } = validateSettingsPatch(req.body, current);
      if (errors) return res.status(400).json({ error: errors[0], errors });
      const settings = await deps.updateSettings(churchId, patch);
      res.json({ success: true, settings });
    } catch (err) {
      respondWithError(res, err, 'people-sync PUT /settings');
    }
  });

  // NOTE: these three routes are named `/people-authority/*`, not the more
  // obvious `/authority/*`, deliberately — see churchIsolation.js's
  // `ensureChurchIsolation`, which skips its own church_id validation for
  // any path matching `req.path.startsWith('/auth')` (meant for the actual
  // `/api/auth/*` login routes). Inside a mounted sub-router, `req.path` is
  // MOUNT-RELATIVE, so `POST /people-sync/authority/preview` would have
  // arrived here as `/authority/preview` — which itself starts with
  // `/auth` and would have silently skipped this router's own
  // ensureChurchIsolation call above (verified: an invalid church_id sailed
  // through `/authority/preview`/`/authority/disable` while still being
  // correctly blocked on `/settings`/`/runs`). Not currently exploitable —
  // the PARENT router's own ensureChurchIsolation (applied before this
  // sub-router is mounted, on the full `/people-sync/authority/preview`
  // path) still catches it — but this file's own header comment claims it
  // doesn't depend on being mounted exactly right, and for these three
  // routes that claim was false. Renaming the path (rather than touching
  // churchIsolation.js's shared matching logic, which many other routes
  // depend on) is the safe fix; see the regression test in
  // peopleSync.test.js that pins this directly against the sub-router.
  router.post('/people-authority/preview', async (req, res) => {
    try {
      const provider = req.body && req.body.provider;
      // previewAuthoritySwitch forces a full paginated roster snapshot —
      // exactly the "many sequential network calls in one request" shape
      // routeTimeout.js's withTimeout exists for (see its own header note).
      // No bookkeeping runs after this call other than formatting the
      // response, so racing the call alone (unlike elvanto.js's run-now,
      // which must race its OWN post-call bookkeeping too) is sufficient.
      const result = await withTimeout(
        deps.previewAuthoritySwitch({ churchId: req.user.church_id, provider }), deps.routeTimeoutMs
      );
      res.json({ success: true, ...result });
    } catch (err) {
      respondWithError(res, err, 'people-sync POST /people-authority/preview');
    }
  });

  router.post('/people-authority/apply', async (req, res) => {
    try {
      const body = req.body || {};
      const provider = body.provider;
      const reviewToken = typeof body.reviewToken === 'string' ? body.reviewToken : '';
      const selections = isPlainObject(body.selections) ? body.selections : {};
      // applyReviewed also forces a full paginated roster snapshot (to
      // verify the reviewed plan is still fresh before applying) — same
      // aggregate-timeout rationale as preview above. Everything this call
      // needs to durably record (the apply itself, the audit run, presence
      // accounting, an authority-switch commit) already happens INSIDE
      // applyReviewed before it resolves — there is no route-level
      // bookkeeping after it to lose if the timeout wins, unlike
      // elvanto.js's run-now.
      const result = await withTimeout(
        deps.applyReviewed({
          churchId: req.user.church_id, provider, batchId: null,
          reviewToken, selections, userId: req.user.id,
        }),
        deps.routeTimeoutMs
      );
      res.json({ success: true, ...result });
    } catch (err) {
      respondWithError(res, err, 'people-sync POST /people-authority/apply');
    }
  });

  router.post('/people-authority/disable', async (req, res) => {
    try {
      const result = await deps.disableAuthority(req.user.church_id);
      res.json({ success: true, authority: result });
    } catch (err) {
      respondWithError(res, err, 'people-sync POST /people-authority/disable');
    }
  });

  router.get('/runs', async (req, res) => {
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : DEFAULT_RUNS_LIMIT;
      const runs = await deps.listAllRecentRuns(req.user.church_id, limit);
      res.json({ success: true, runs: runs.map(sanitizeRunForResponse) });
    } catch (err) {
      respondWithError(res, err, 'people-sync GET /runs');
    }
  });

  return router;
}

module.exports = {
  createPeopleSyncRouter,
  defaultDeps,
  respondWithError,
  validateSettingsPatch,
};
