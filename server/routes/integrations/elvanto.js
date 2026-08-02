'use strict';

// Elvanto-specific people-sync routes — Task 16 of the provider-neutral
// people-sync project. Provider-NEUTRAL concerns (church-wide settings,
// authority preview/apply/disable, the merged runs feed) live in
// server/routes/integrations/peopleSync.js instead; this file owns
// everything that only makes sense for Elvanto: the API-key connection
// itself and batch CRUD/plan/apply/run-now. Interactive run-now is a review alias: only the
// scheduler may invoke the unattended orchestrator path.
//
// Every dependency this router touches is injected via `deps` (see
// `defaultDeps` below) so route tests never need a real database, a real
// Elvanto adapter, or a real network call — see elvanto.test.js. In
// particular `deps.buildReview`/`applyReviewed` are treated as opaque,
// already-safe collaborators: both interactive buttons produce a review,
// and only an explicit apply carrying that review token may mutate data.
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
const { requireRole } = require('../../middleware/auth');
const { ensureChurchIsolation } = require('../../middleware/churchIsolation');
const connectionStore = require('../../services/peopleSync/connectionStore');
const batchRepository = require('../../services/peopleSync/batchRepository');
const orchestrator = require('../../services/peopleSync/orchestrator');
const { createElvantoAdapter } = require('../../services/elvanto/adapter');
const { ElvantoError, ELVANTO_AUTH } = require('../../services/elvanto/httpClient');
const legacyCredential = require('../../services/elvanto/legacyCredential');
const { DEFAULT_ROUTE_TIMEOUT_MS, RouteTimeoutError, withTimeout } = require('./routeTimeout');
const { resolveVisibleSource } = require('../../services/peopleSync/sourceSelection');
const { SOURCE_KINDS_BY_PROVIDER } = require('../../services/peopleSync/sourceModel');

const { OrchestratorError } = orchestrator;

const PROVIDER = 'elvanto';

const BATCH_BODY_ALLOWED = new Set([
  'enabled', 'sourceKind', 'sourceExternalId', 'defaultPeopleType',
  'gatheringTypeId', 'gatheringAutoRemoveEnabled', 'scheduleEnabled', 'scheduleFrequency', 'scheduleDay',
]);
const VALID_PEOPLE_TYPES = new Set(['regular', 'local_visitor', 'traveller_visitor']);
const VALID_SCHEDULE_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseBatchId(raw) {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// batchRepository.createBatch's own defaults (services/peopleSync/
// batchRepository.js's normaliseBatchInput) for a brand-new batch that
// doesn't specify a schedule at all — used as the "current" fallback for
// POST /sync-batches's day/frequency cross-check below, so a create body
// that supplies ONLY scheduleDay (no scheduleFrequency) is validated
// against the frequency it would actually be created with.
const CREATE_SCHEDULE_DEFAULTS = { scheduleFrequency: 'weekly', scheduleDay: 1 };

// Same reasoning and shape as peopleSync.js's validateDayForFrequency: day
// range depends on the RESULTING frequency (existing/default, or
// newly-supplied in this same patch) — weekly is 0-6 (JS Date
// day-of-week), monthly is 1-31. scheduler.isDueToday ignores the day
// value for daily, but a wildly out-of-range value is still rejected here
// rather than silently stored.
function validateScheduleDayForFrequency(frequency, day) {
  if (day === undefined || day === null) return null;
  if (frequency === 'weekly' && (day < 0 || day > 6)) return 'scheduleDay must be an integer between 0 and 6 for weekly schedules.';
  if (frequency === 'monthly' && (day < 1 || day > 31)) return 'scheduleDay must be an integer between 1 and 31 for monthly schedules.';
  if (frequency === 'daily' && (day < 0 || day > 31)) return 'scheduleDay must be an integer between 0 and 31.';
  return null;
}

// Strict allow-list + type validator for a sync-batch request body, shared
// by create (full body, source required, `current` is
// CREATE_SCHEDULE_DEFAULTS) and update (partial patch, source fields are
// forbidden, `current` is the existing stored batch — batchRepository.
// updateBatch itself merges a partial patch over the existing row, see its
// own header note). Mirrors the existing PCO `validateBatchBody` in
// routes/integrations.js in spirit (a pure function returning `null` or a
// single error string) but adapted for the new generic schema's field set
// AND for partial-patch semantics PCO's own (always-full-body) validator
// never had to handle.
//
// `current` matters specifically for the schedule day/frequency
// cross-check: a patch that changes ONLY scheduleFrequency (or ONLY
// scheduleDay) must be validated against the RESULTING pair — this field's
// own new value if supplied, else whatever is already stored/defaulted —
// not just whichever of the two happens to be present in this one request.
// Without this, e.g. a batch stored with {frequency:'monthly', day:20}
// patched to {scheduleFrequency:'weekly'} alone would silently persist an
// impossible pair (weekly only ever matches day 0-6), and
// scheduler.isDueToday would then never fire for that batch again, with no
// error anywhere.
function validateBatchBody(body, { create = false, current = CREATE_SCHEDULE_DEFAULTS } = {}) {
  if (!isPlainObject(body)) return 'Request body must be an object.';
  for (const key of Object.keys(body)) {
    if (!BATCH_BODY_ALLOWED.has(key)) return `Unknown batch field: ${key}`;
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
  if (create && (!SOURCE_KINDS_BY_PROVIDER.elvanto.has(body.sourceKind) || typeof body.sourceExternalId !== 'string' || !body.sourceExternalId.trim())) return 'An Elvanto source is required.';
  if (!create && (Object.hasOwn(body, 'sourceKind') || Object.hasOwn(body, 'sourceExternalId'))) return 'Sync sources must be changed through the source draft endpoint.';

  const resultingFrequency = body.scheduleFrequency !== undefined ? body.scheduleFrequency : current.scheduleFrequency;
  const resultingDay = body.scheduleDay !== undefined ? body.scheduleDay : current.scheduleDay;
  const dayError = validateScheduleDayForFrequency(resultingFrequency, resultingDay);
  if (dayError) return dayError;

  return null;
}

function extractBatchFields(body) {
  const fields = {};
  for (const key of BATCH_BODY_ALLOWED) {
    if (key === 'sourceKind' || key === 'sourceExternalId') continue;
    if (Object.hasOwn(body || {}, key)) fields[key] = body[key];
  }
  return fields;
}

// ─── Default (production) collaborators ─────────────────────────────────────

const defaultAdapter = createElvantoAdapter();

const defaultDeps = {
  adapter: defaultAdapter,
  routeTimeoutMs: DEFAULT_ROUTE_TIMEOUT_MS,
  getConnection: connectionStore.getConnection,
  markValidated: connectionStore.markValidated,
  getOrMigrateCredentials: legacyCredential.getOrMigrateCredentials,
  replaceConnection: legacyCredential.replaceConnection,
  disconnectConnection: legacyCredential.disconnectConnection,
  listBatches: batchRepository.listBatches,
  getBatch: batchRepository.getBatch,
  createBatch: batchRepository.createBatch,
  updateBatch: batchRepository.updateBatch,
  deleteBatch: batchRepository.deleteBatch,
  resolveVisibleSource,
  buildReview: orchestrator.buildReview,
  previewLinkCorrections: orchestrator.previewLinkCorrections,
  applyReviewed: orchestrator.applyReviewed,
};

// ─── Safe error mapping ──────────────────────────────────────────────────────
//
// Exhaustive over every typed error this router can actually observe:
//   - RouteTimeoutError (from withTimeout, above) — the aggregate route
//     deadline was exceeded; always a safe 503, never leaks which specific
//     network call was still in flight.
//   - OrchestratorError (from buildReview/applyReviewed) —
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
  [ELVANTO_AUTH]: 401,
  ELVANTO_AUTH: 401,
  ELVANTO_UNAVAILABLE: 503,
  ELVANTO_RESPONSE: 502,
  ELVANTO_PAGINATION: 502,
};

function isElvantoAuthError(err) {
  return err instanceof ElvantoError &&
    (err.code === ELVANTO_AUTH || err.code === 'ELVANTO_AUTH');
}

function respondWithError(res, err, { context, logLabel } = {}) {
  if (err?.code === 'SYNC_SOURCE_UNAVAILABLE') {
    return res.status(409).json({ error: 'The requested sync source is unavailable. Reconnect Elvanto and try again.', code: err.code });
  }
  if (err instanceof RouteTimeoutError) {
    return res.status(503).json({ error: 'The request took too long to complete. Please try again.', code: err.code });
  }
  if (err instanceof OrchestratorError) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  if (err instanceof ElvantoError) {
    if (isElvantoAuthError(err)) {
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
  if (err instanceof legacyCredential.ElvantoAuthorityConnectionRequiredError ||
      err instanceof legacyCredential.ElvantoConnectionStaleError ||
      err?.code === legacyCredential.ELVANTO_AUTHORITY_CONNECTION_REQUIRED ||
      err?.code === legacyCredential.ELVANTO_CONNECTION_STALE) {
    return res.status(err.status || 409).json({ error: err.message, code: err.code });
  }
  logger.error(`${logLabel}: ${err && err.message}`, { stack: err && err.stack });
  return res.status(500).json({ error: 'An unexpected error occurred.' });
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
        if (isElvantoAuthError(err)) {
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
      // The credential service snapshots and CAS-checks the connection
      // generation around this slow provider call. A concurrent disconnect
      // therefore wins instead of being undone by a late validation result.
      const { status } = await deps.replaceConnection({
        churchId,
        credentials: { apiKey },
        connectedBy: req.user.id,
        validateConnection: (input) => withTimeout(
          deps.adapter.validateConnection(input), deps.routeTimeoutMs
        ),
      });
      res.json({ success: true, status });
    } catch (err) {
      respondWithError(res, err, { context: 'connect', logLabel: 'elvanto POST /connect' });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const churchId = req.user.church_id;
    try {
      // Authority gating plus encrypted and legacy credential deletion are
      // one church transaction in the credential service. Active or pending
      // authority is rejected; disconnect never silently disables it.
      const disconnected = await deps.disconnectConnection(churchId);
      res.json({ success: true, disconnected });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto POST /disconnect' });
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
      const bodyError = validateBatchBody(body, { create: true });
      if (bodyError) return res.status(400).json({ error: bodyError });

      const fields = extractBatchFields(body);
      const source = await deps.resolveVisibleSource({ churchId, provider: PROVIDER, sourceKind: body.sourceKind, sourceExternalId: body.sourceExternalId });
      const batch = await deps.createBatch({
        churchId, provider: PROVIDER, ...fields,
        name: source.name,
        initialDraftSource: { kind: source.kind, externalId: source.externalId, name: source.name },
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
      const bodyError = validateBatchBody(body, { current: existing });
      if (bodyError) return res.status(400).json({ error: bodyError });

      const fields = extractBatchFields(body);
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
      const result = await withTimeout(
        deps.buildReview({ churchId, provider: PROVIDER, batchId, trigger: 'manual' }), deps.routeTimeoutMs
      );
      res.json({ success: true, ...result });
    } catch (err) {
      respondWithError(res, err, { logLabel: 'elvanto GET /sync-batches/:id/plan' });
    }
  });

  router.post('/sync-batches/:id/preview-link-corrections', async (req, res) => {
    const churchId = req.user.church_id;
    const batchId = parseBatchId(req.params.id);
    const baseReviewToken = typeof req.body?.baseReviewToken === 'string'
      ? req.body.baseReviewToken.trim()
      : '';
    if (batchId === null) return res.status(400).json({ error: 'Invalid batch id.' });
    if (!baseReviewToken) {
      return res.status(400).json({
        error: 'A base review token is required.',
        code: 'SYNC_REVIEW_TOKEN_REQUIRED',
      });
    }
    if (!isPlainObject(req.body?.linkCorrections)) {
      return res.status(400).json({
        error: 'Link corrections must be an object.',
        code: 'SYNC_SELECTIONS_INVALID',
      });
    }
    try {
      const result = await withTimeout(deps.previewLinkCorrections({
        churchId,
        provider: PROVIDER,
        batchId,
        baseReviewToken,
        linkCorrections: req.body.linkCorrections,
      }), deps.routeTimeoutMs);
      return res.json({ success: true, ...result });
    } catch (err) {
      return respondWithError(res, err, { logLabel: 'elvanto POST /sync-batches/:id/preview-link-corrections' });
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
      const result = await withTimeout(
        deps.applyReviewed({ churchId, provider: PROVIDER, batchId, reviewToken, selections, userId: req.user.id }),
        deps.routeTimeoutMs
      );
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
      const result = await withTimeout(
        deps.buildReview({ churchId, provider: PROVIDER, batchId, trigger: 'manual' }),
        deps.routeTimeoutMs
      );
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
  RouteTimeoutError,
};
