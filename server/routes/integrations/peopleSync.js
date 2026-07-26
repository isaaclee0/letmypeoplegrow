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
function validateDayForFrequency(frequency, day) {
  if (day === undefined) return null;
  if (frequency === 'weekly' && (day < 0 || day > 6)) {
    return 'fullReconciliationDay must be between 0 and 6 (Sunday-Saturday) for a weekly schedule.';
  }
  if (frequency === 'monthly' && (day < 1 || day > 31)) {
    return 'fullReconciliationDay must be between 1 and 31 for a monthly schedule.';
  }
  return null;
}

// Strict allow-list validator: rejects an empty body, any unknown key, and
// any wrongly-typed value, listing every problem found (not just the
// first). Returns { errors } or { patch } — never both.
function validateSettingsPatch(body, currentFrequency) {
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

  const resultingFrequency = patch.fullReconciliationFrequency || currentFrequency;
  const dayError = validateDayForFrequency(resultingFrequency, patch.fullReconciliationDay);
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

// ─── Default (production) collaborators ─────────────────────────────────────

const defaultDeps = {
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
// OrchestratorError already carries a curated, credential-free `.message`,
// a `.code`, and the correct HTTP `.status` (see orchestrator.js) for every
// typed failure it can throw — SYNC_PROVIDER_INVALID/SYNC_CHURCH_REQUIRED/
// SYNC_NOT_CONNECTED/SYNC_CONNECTION_INVALID/SYNC_BATCH_NOT_FOUND/
// SYNC_BATCH_DISABLED/SYNC_NO_BATCHES/SYNC_BATCH_FILTER_INVALID/
// SYNC_FETCH_INCOMPLETE/SYNC_TRIGGER_INVALID/SYNC_REVIEW_INVALID/
// SYNC_REVIEW_EXPIRED/SYNC_PLAN_STALE/SYNC_SELECTIONS_INVALID/
// SYNC_BATCH_REQUIRED/SYNC_AUTHORITY_MISMATCH — so those are passed through
// as-is. Anything else (a provider adapter's own typed error propagating
// unwrapped through buildReview/applyReviewed/previewAuthoritySwitch/
// runUnattended's rethrow, or a genuinely unexpected bug) is logged
// server-side in full and reported to the client as a generic, safe 500 —
// never the raw `.message`, which could in principle carry provider
// response detail never meant for the browser.
function respondWithError(res, err, logLabel) {
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
      const { errors, patch } = validateSettingsPatch(req.body, current.fullReconciliationFrequency);
      if (errors) return res.status(400).json({ error: errors[0], errors });
      const settings = await deps.updateSettings(churchId, patch);
      res.json({ success: true, settings });
    } catch (err) {
      respondWithError(res, err, 'people-sync PUT /settings');
    }
  });

  router.post('/authority/preview', async (req, res) => {
    try {
      const provider = req.body && req.body.provider;
      const result = await deps.previewAuthoritySwitch({ churchId: req.user.church_id, provider });
      res.json({ success: true, ...result });
    } catch (err) {
      respondWithError(res, err, 'people-sync POST /authority/preview');
    }
  });

  router.post('/authority/apply', async (req, res) => {
    try {
      const body = req.body || {};
      const provider = body.provider;
      const reviewToken = typeof body.reviewToken === 'string' ? body.reviewToken : '';
      const selections = isPlainObject(body.selections) ? body.selections : {};
      const result = await deps.applyReviewed({
        churchId: req.user.church_id, provider, batchId: null,
        reviewToken, selections, userId: req.user.id,
      });
      // result may include `authorityCommitError` (set when the apply itself
      // succeeded but committing the authority switch afterward failed) —
      // spread through as-is so it is never silently dropped; still a 200
      // since the reviewed apply did succeed.
      res.json({ success: true, ...result });
    } catch (err) {
      respondWithError(res, err, 'people-sync POST /authority/apply');
    }
  });

  router.post('/authority/disable', async (req, res) => {
    try {
      const result = await deps.disableAuthority(req.user.church_id);
      res.json({ success: true, authority: result });
    } catch (err) {
      respondWithError(res, err, 'people-sync POST /authority/disable');
    }
  });

  router.get('/runs', async (req, res) => {
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : DEFAULT_RUNS_LIMIT;
      const runs = await deps.listAllRecentRuns(req.user.church_id, limit);
      res.json({ success: true, runs });
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
