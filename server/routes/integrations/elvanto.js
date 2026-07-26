'use strict';

// Elvanto-specific people-sync routes — Task 16 of the provider-neutral
// people-sync project. Provider-NEUTRAL concerns (church-wide settings,
// authority preview/apply/disable, the merged runs feed) live in
// server/routes/integrations/peopleSync.js instead; this file owns
// everything that only makes sense for Elvanto: the API-key connection
// itself, metadata discovery for the batch filter picker, and batch
// CRUD/plan/apply/run-now.
//
// Every dependency this router touches is injected via `deps` (see
// `defaultDeps` below) so route tests never need a real database, a real
// Elvanto adapter, or a real network call — see elvanto.test.js. In
// particular `deps.buildReview`/`applyReviewed`/`runUnattended` are treated
// as opaque, already-safe collaborators: this file never second-guesses or
// re-implements the review/selection safety orchestrator.js already
// provides (ambiguous/conflicting/rename/unmatched buckets are ALWAYS held
// for review — see runUnattended's own header note — this router just
// forwards whatever it returns).
//
// `deps.adapter` is a real, directly-constructed createElvantoAdapter()
// instance (never providerRegistry.getProvider('elvanto')) precisely so
// this file's own require-time behaviour never depends on
// providerRegistry.registerBuiltInProviders() having already run — that
// registration is only needed by the orchestrator's OWN lazy,
// request-time `getProvider('elvanto')` lookup (see orchestrator.js's
// loadPreconditions), which happens well after server startup. See
// server/index.js for where registerBuiltInProviders() is actually called.
const express = require('express');
const logger = require('../../config/logger');
const Database = require('../../config/database');
const { requireRole } = require('../../middleware/auth');
const { ensureChurchIsolation } = require('../../middleware/churchIsolation');
const connectionStore = require('../../services/peopleSync/connectionStore');
const batchRepository = require('../../services/peopleSync/batchRepository');
const authority = require('../../services/peopleSync/authority');
const orchestrator = require('../../services/peopleSync/orchestrator');
const { createElvantoAdapter } = require('../../services/elvanto/adapter');
const { ElvantoError } = require('../../services/elvanto/httpClient');
const legacyCredential = require('../../services/elvanto/legacyCredential');

const { OrchestratorError } = orchestrator;

const PROVIDER = 'elvanto';

const BATCH_BODY_ALLOWED = new Set([
  'name', 'enabled', 'filterSchemaVersion', 'filterConfig', 'defaultPeopleType',
  'gatheringTypeId', 'gatheringAutoRemoveEnabled', 'scheduleEnabled', 'scheduleFrequency', 'scheduleDay',
]);
const VALID_PEOPLE_TYPES = new Set(['regular', 'local_visitor', 'traveller_visitor']);
const VALID_SCHEDULE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseBatchId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Strict allow-list + type validator for a sync-batch request body, shared
// by create (full body, name required) and update (partial patch, name only
// validated if supplied — batchRepository.updateBatch itself merges a
// partial patch over the existing row, see its own header note). Mirrors
// the existing PCO `validateBatchBody` in routes/integrations.js in spirit
// (a pure function returning `null` or a single error string) but adapted
// for the new generic schema's field set.
function validateBatchBody(body, { requireName } = {}) {
  if (!isPlainObject(body)) return 'Request body must be an object.';
  for (const key of Object.keys(body)) {
    if (!BATCH_BODY_ALLOWED.has(key)) return `Unknown batch field: ${key}`;
  }
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return 'A batch name is required.';
  } else if (requireName) {
    return 'A batch name is required.';
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return 'enabled must be a boolean.';
  if (body.defaultPeopleType !== undefined && !VALID_PEOPLE_TYPES.has(body.defaultPeopleType)) return 'Invalid defaultPeopleType.';
  if (body.gatheringTypeId !== undefined && body.gatheringTypeId !== null && !Number.isInteger(body.gatheringTypeId)) {
    return 'gatheringTypeId must be an integer or null.';
  }
  if (body.gatheringAutoRemoveEnabled !== undefined && typeof body.gatheringAutoRemoveEnabled !== 'boolean') {
    return 'gatheringAutoRemoveEnabled must be a boolean.';
  }
  if (body.scheduleEnabled !== undefined && typeof body.scheduleEnabled !== 'boolean') return 'scheduleEnabled must be a boolean.';
  if (body.scheduleFrequency !== undefined && !VALID_SCHEDULE_FREQUENCIES.has(body.scheduleFrequency)) {
    return 'Invalid scheduleFrequency.';
  }
  if (body.scheduleDay !== undefined && !Number.isInteger(body.scheduleDay)) return 'scheduleDay must be an integer.';
  if (body.filterSchemaVersion !== undefined && !Number.isInteger(body.filterSchemaVersion)) {
    return 'filterSchemaVersion must be an integer.';
  }
  if (body.filterConfig !== undefined && !isPlainObject(body.filterConfig)) return 'filterConfig must be an object.';
  return null;
}

function extractBatchFields(body) {
  const fields = {};
  for (const key of BATCH_BODY_ALLOWED) {
    if (Object.hasOwn(body || {}, key)) fields[key] = body[key];
  }
  return fields;
}

// ─── Default (production) collaborators ─────────────────────────────────────

async function defaultDeleteLegacyPreferences(churchId) {
  await Database.queryForChurch(
    churchId,
    `DELETE FROM user_preferences WHERE church_id = ? AND preference_key = ?`,
    [churchId, legacyCredential.LEGACY_PREFERENCE_KEY]
  );
}

const defaultAdapter = createElvantoAdapter();

const defaultDeps = {
  adapter: defaultAdapter,
  getConnection: connectionStore.getConnection,
  getCredentials: connectionStore.getCredentials,
  upsertConnection: connectionStore.upsertConnection,
  disconnectConnection: connectionStore.disconnectConnection,
  markValidated: connectionStore.markValidated,
  getOrMigrateCredentials: legacyCredential.getOrMigrateCredentials,
  deleteLegacyPreferences: defaultDeleteLegacyPreferences,
  getAuthority: authority.getAuthority,
  disableAuthority: authority.disableAuthority,
  listBatches: batchRepository.listBatches,
  getBatch: batchRepository.getBatch,
  createBatch: batchRepository.createBatch,
  updateBatch: batchRepository.updateBatch,
  deleteBatch: batchRepository.deleteBatch,
  recordBatchResult: batchRepository.recordBatchResult,
  buildReview: orchestrator.buildReview,
  applyReviewed: orchestrator.applyReviewed,
  runUnattended: orchestrator.runUnattended,
};

// ─── Safe error mapping ──────────────────────────────────────────────────────
//
// Exhaustive over every typed error this router can actually observe:
//   - OrchestratorError (from buildReview/applyReviewed/runUnattended) —
//     status/code/message already curated by orchestrator.js itself.
//   - ElvantoError (from a direct adapter call, OR unwrapped straight
//     through an orchestrator function's own rethrow — see orchestrator.js's
//     header note: only the FIRST few steps of each pipeline function are
//     wrapped in a try/catch that calls failRun and rethrows the ORIGINAL
//     error, never an OrchestratorError wrapper).
//   - ElvantoReconnectRequiredError (from legacyCredential.js).
//   - anything else: logged in full server-side, reported as a generic,
//     credential-free 500 — never the raw message.
const ELVANTO_ERROR_STATUS = {
  ELVANTO_AUTH: 401,
  ELVANTO_UNAVAILABLE: 503,
  ELVANTO_RESPONSE: 502,
  ELVANTO_PAGINATION: 502,
};

function respondWithError(res, err, { context, logLabel } = {}) {
  if (err instanceof OrchestratorError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  if (err instanceof ElvantoError) {
    if (err.code === 'ELVANTO_AUTH') {
      // A submitted replacement key (connect) failing validation is the
      // CALLER's bad input -> 400; a stored key later failing (any other
      // context: status/metadata/batch plan/apply/run-now) means the
      // existing connection has gone bad -> 401 (reconnect required).
      return context === 'connect'
        ? res.status(400).json({ error: 'Invalid API key. Please check your Elvanto API key and try again.', code: err.code })
        : res.status(401).json({ error: 'Elvanto rejected the stored API key. Reconnect Elvanto to continue.', code: err.code });
    }
    const status = ELVANTO_ERROR_STATUS[err.code] || 502;
    const message = err.code === 'ELVANTO_UNAVAILABLE'
      ? 'Elvanto is currently unavailable. Please try again shortly.'
      : 'Elvanto returned an unexpected response. Please try again shortly.';
    return res.status(status).json({ error: message, code: err.code });
  }
  if (err instanceof legacyCredential.ElvantoReconnectRequiredError ||
      (err && err.code === legacyCredential.ELVANTO_RECONNECT_REQUIRED)) {
    return res.status(409).json({ error: err.message, code: err.code });
  }
  logger.error(`${logLabel}: ${err && err.message}`, { stack: err && err.stack });
  return res.status(500).json({ error: 'An unexpected error occurred.' });
}

async function fetchLiveMetadata(deps, churchId, credentials, force) {
  const snapshot = await deps.adapter.fetchSnapshot({ churchId, credentials, mode: 'full' });
  return deps.adapter.fetchMetadata({ churchId, credentials, force, snapshot });
}

function createElvantoRouter(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  // Defense in depth — see peopleSync.js's identical comment: this
  // subrouter is only ever mounted behind verifyToken/ensureChurchIsolation/
  // requireRole(['admin']) already, but re-asserting them here means this
  // file's own safety does not silently depend on always being mounted
  // exactly right one layer up.
  router.use(ensureChurchIsolation);
  router.use(requireRole(['admin']));

  // ─── Connection ────────────────────────────────────────────────────────

  router.get('/status', async (req, res) => {
    const churchId = req.user.church_id;
    try {
      let credentials;
      try {
        credentials = await deps.getOrMigrateCredentials(churchId);
      } catch (err) {
        if (err && err.code === legacyCredential.ELVANTO_RECONNECT_REQUIRED) {
          return res.json({
            configured: true, connected: false, elvantoAccount: null,
            error: err.code, reconnectRequired: true,
          });
        }
        throw err;
      }
      if (!credentials) {
        return res.json({ configured: false, connected: false, elvantoAccount: null });
      }

      try {
        const validation = await deps.adapter.validateConnection({ churchId, credentials });
        await deps.markValidated(churchId, PROVIDER, { connectionStatus: 'connected' });
        const connection = await deps.getConnection(churchId, PROVIDER);
        const label = (connection && connection.metadata && connection.metadata.connectionLabel) ||
          (validation && validation.metadata && validation.metadata.connectionLabel) || 'Connected via API key';
        return res.json({ configured: true, connected: true, elvantoAccount: label });
      } catch (err) {
        if (err instanceof ElvantoError && err.code === 'ELVANTO_AUTH') {
          await deps.markValidated(churchId, PROVIDER, { connectionStatus: 'invalid', lastErrorCode: err.code });
          return res.json({ configured: true, connected: false, elvantoAccount: null, error: 'API key is invalid or expired' });
        }
        // Any other failure (Elvanto unavailable, a malformed response, or a
        // genuinely unexpected bug) is reported the same safe, non-500 way
        // the pre-Task-16 status route always did — a transient hiccup
        // reaching Elvanto should not turn the whole settings page into an
        // error state — but it is still logged server-side so a recurring
        // failure is not silently invisible to an operator.
        logger.warn(`elvanto GET /status: connection check failed for church ${churchId}: ${err && err.message}`);
        await deps.markValidated(churchId, PROVIDER, {
          connectionStatus: 'validation_unavailable', lastErrorCode: (err instanceof ElvantoError && err.code) || null,
        });
        return res.json({ configured: true, connected: false, elvantoAccount: null, error: 'Failed to verify Elvanto connection' });
      }
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto GET /status' });
    }
  });

  router.post('/connect', async (req, res) => {
    const churchId = req.user.church_id;
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    if (!apiKey) return res.status(400).json({ error: 'API key is required.' });
    try {
      // Validate-before-replace: if validateConnection throws, we never
      // reach upsertConnection below — any previously-connected credential
      // for this church is left completely untouched.
      const validation = await deps.adapter.validateConnection({ churchId, credentials: { apiKey } });
      await deps.upsertConnection({
        churchId, provider: PROVIDER, authType: 'api_key',
        credentials: { apiKey }, connectedBy: req.user.id, metadata: (validation && validation.metadata) || {},
      });
      const status = await deps.getConnection(churchId, PROVIDER);
      res.json({ success: true, status });
    } catch (err) {
      respondWithError(res, err, { context: 'connect', logLabel: 'elvanto POST /connect' });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const churchId = req.user.church_id;
    try {
      // If Elvanto is currently the active people-sync authority, release
      // that FIRST — links/batches are left in place (disableAuthority only
      // touches people_sync_settings.authority_provider) — before deleting
      // the credential itself.
      const authorityState = await deps.getAuthority(churchId);
      if (authorityState.active === PROVIDER) {
        await deps.disableAuthority(churchId);
      }
      const disconnected = await deps.disconnectConnection(churchId, PROVIDER);
      // Belt-and-suspenders: also clear any legacy (pre-Task-16) per-admin
      // API key rows, mirroring Planning Center's own disconnect route —
      // without this, a church whose legacy row was never read (so never
      // migrated/deleted) could have its connection "resurrected" by that
      // stale row the next time getOrMigrateCredentials runs.
      await deps.deleteLegacyPreferences(churchId);
      res.json({ success: true, disconnected });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto POST /disconnect' });
    }
  });

  // ─── Metadata (filter-picker discovery) ───────────────────────────────

  router.get('/metadata', async (req, res) => {
    const churchId = req.user.church_id;
    try {
      const credentials = await deps.getCredentials(churchId, PROVIDER);
      if (!credentials) return res.status(400).json({ error: 'Elvanto is not connected.' });

      // Cheap path: serve the persisted cache (connectionStore's own
      // metadata.syncMetadata, written by a prior live fetch) without a
      // live Elvanto call. Only falls through to a live fetch when nothing
      // has ever been cached yet — POST /metadata/refresh is the explicit
      // "go fetch fresh" action.
      const connection = await deps.getConnection(churchId, PROVIDER);
      const cached = connection && connection.metadata && connection.metadata.syncMetadata;
      if (cached) {
        return res.json({ success: true, metadata: cached, stale: false, cached: true, metadataCachedAt: connection.metadataCachedAt || null });
      }

      const result = await fetchLiveMetadata(deps, churchId, credentials, false);
      if (result && Object.hasOwn(result, 'stale')) {
        return res.json({ success: true, ...result, cached: false });
      }
      return res.json({ success: true, metadata: result, stale: false, cached: false });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto GET /metadata' });
    }
  });

  router.post('/metadata/refresh', async (req, res) => {
    const churchId = req.user.church_id;
    try {
      const credentials = await deps.getCredentials(churchId, PROVIDER);
      if (!credentials) return res.status(400).json({ error: 'Elvanto is not connected.' });

      const result = await fetchLiveMetadata(deps, churchId, credentials, true);
      if (result && Object.hasOwn(result, 'stale')) {
        return res.json({ success: true, ...result });
      }
      return res.json({ success: true, metadata: result, stale: false });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto POST /metadata/refresh' });
    }
  });

  // ─── Sync batches ──────────────────────────────────────────────────────

  router.get('/sync-batches', async (req, res) => {
    try {
      const batches = await deps.listBatches(req.user.church_id, PROVIDER);
      res.json({ success: true, batches });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto GET /sync-batches' });
    }
  });

  router.post('/sync-batches', async (req, res) => {
    const churchId = req.user.church_id;
    try {
      const body = req.body || {};
      const bodyError = validateBatchBody(body, { requireName: true });
      if (bodyError) return res.status(400).json({ error: bodyError });

      const filterSchemaVersion = body.filterSchemaVersion === undefined ? 1 : body.filterSchemaVersion;
      const filterConfig = body.filterConfig === undefined ? {} : body.filterConfig;
      const filterValidation = deps.adapter.validateFilter(filterConfig, filterSchemaVersion);
      if (!filterValidation.ok) {
        return res.status(400).json({ error: 'Invalid Elvanto filter.', errors: filterValidation.errors });
      }

      const fields = extractBatchFields(body);
      const batch = await deps.createBatch({
        churchId, provider: PROVIDER, ...fields, filterConfig: filterValidation.value, filterSchemaVersion,
      });
      res.json({ success: true, batch });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto POST /sync-batches' });
    }
  });

  router.put('/sync-batches/:id', async (req, res) => {
    const churchId = req.user.church_id;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    try {
      const existing = await deps.getBatch(churchId, PROVIDER, batchId);
      if (!existing) return res.status(404).json({ error: 'Sync batch not found.' });

      const body = req.body || {};
      const bodyError = validateBatchBody(body, { requireName: false });
      if (bodyError) return res.status(400).json({ error: bodyError });

      const fields = extractBatchFields(body);
      if (Object.hasOwn(fields, 'filterConfig')) {
        const filterSchemaVersion = Object.hasOwn(fields, 'filterSchemaVersion')
          ? fields.filterSchemaVersion : existing.filterSchemaVersion;
        const filterValidation = deps.adapter.validateFilter(fields.filterConfig, filterSchemaVersion);
        if (!filterValidation.ok) {
          return res.status(400).json({ error: 'Invalid Elvanto filter.', errors: filterValidation.errors });
        }
        fields.filterConfig = filterValidation.value;
        fields.filterSchemaVersion = filterSchemaVersion;
      }

      const batch = await deps.updateBatch({ churchId, provider: PROVIDER, batchId, ...fields });
      res.json({ success: true, batch });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto PUT /sync-batches/:id' });
    }
  });

  router.delete('/sync-batches/:id', async (req, res) => {
    const churchId = req.user.church_id;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    try {
      const existing = await deps.getBatch(churchId, PROVIDER, batchId);
      if (!existing) return res.status(404).json({ error: 'Sync batch not found.' });
      await deps.deleteBatch(churchId, PROVIDER, batchId);
      res.json({ success: true });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto DELETE /sync-batches/:id' });
    }
  });

  router.get('/sync-batches/:id/plan', async (req, res) => {
    const churchId = req.user.church_id;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    try {
      const result = await deps.buildReview({ churchId, provider: PROVIDER, batchId, trigger: 'manual' });
      res.json({ success: true, ...result });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto GET /sync-batches/:id/plan' });
    }
  });

  router.post('/sync-batches/:id/apply', async (req, res) => {
    const churchId = req.user.church_id;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    try {
      const body = req.body || {};
      const reviewToken = typeof body.reviewToken === 'string' ? body.reviewToken : '';
      const selections = isPlainObject(body.selections) ? body.selections : {};
      const result = await deps.applyReviewed({
        churchId, provider: PROVIDER, batchId, reviewToken, selections, userId: req.user.id,
      });
      // As with /people-sync/authority/apply: `result.authorityCommitError`
      // (if present) is surfaced as-is rather than dropped — a batch apply
      // can coincide with a pending authority switch left over from a
      // separate preview.
      res.json({ success: true, ...result });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto POST /sync-batches/:id/apply' });
    }
  });

  router.post('/sync-batches/:id/run-now', async (req, res) => {
    const churchId = req.user.church_id;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    try {
      // runUnattended (the "safe unattended policy") already strips
      // ambiguous/conflicting/rename/unmatched items into review_required
      // pending counts on its own — this route does not, and must not, add
      // any bypass logic of its own; it only forwards the result faithfully.
      const result = await deps.runUnattended({ churchId, provider: PROVIDER, batchId, trigger: 'run_now' });
      try {
        await deps.recordBatchResult({
          churchId, provider: PROVIDER, batchId, trigger: 'run_now',
          fetchMode: result.fetchMode, complete: result.complete,
          status: result.status, externalWatermark: result.externalWatermark,
        });
      } catch (recordErr) {
        logger.error(
          `elvanto POST /sync-batches/:id/run-now: failed to record batch result for batch ${batchId} (church ${churchId}): ${recordErr.message}`
        );
      }
      res.json({ success: true, ...result });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto POST /sync-batches/:id/run-now' });
    }
  });

  return router;
}

module.exports = {
  createElvantoRouter,
  defaultDeps,
  respondWithError,
  validateBatchBody,
};
