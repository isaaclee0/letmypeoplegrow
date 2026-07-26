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
const { DEFAULT_ROUTE_TIMEOUT_MS, RouteTimeoutError, withTimeout } = require('./routeTimeout');

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
// by create (full body, name required, `current` is
// CREATE_SCHEDULE_DEFAULTS) and update (partial patch, name only validated
// if supplied, `current` is the existing stored batch — batchRepository.
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
function validateBatchBody(body, { requireName, current = CREATE_SCHEDULE_DEFAULTS } = {}) {
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

  const resultingFrequency = body.scheduleFrequency !== undefined ? body.scheduleFrequency : current.scheduleFrequency;
  const resultingDay = body.scheduleDay !== undefined ? body.scheduleDay : current.scheduleDay;
  const dayError = validateScheduleDayForFrequency(resultingFrequency, resultingDay);
  if (dayError) return dayError;

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

// Church-scoped (not per-admin, unlike the pre-Task-16 disconnect handler's
// own per-user delete) belt-and-suspenders cleanup: clears the specific
// legacy `elvanto_api_key` row this module migrates from, AND any other
// elvanto-prefixed preference row (e.g. a stale `elvanto_integration` OAuth
// remnant from an even older version of this integration) — mirroring the
// pre-Task-16 handler's own `LIKE 'elvanto%'` breadth, which this rewrite
// had narrowed to just the one key it actively reads. Nothing in this
// codebase currently reads an `elvanto_integration` row, so there is no
// "resurrection" risk from leaving it behind, but a church that still has
// one would otherwise export it in cleartext via church takeout (see
// routes/takeout.js's REDACT_PREFERENCE_KEYS, widened alongside this).
async function defaultDeleteLegacyPreferences(churchId) {
  await Database.queryForChurch(
    churchId,
    `DELETE FROM user_preferences WHERE church_id = ? AND preference_key LIKE 'elvanto%'`,
    [churchId]
  );
}

const defaultAdapter = createElvantoAdapter();

const defaultDeps = {
  adapter: defaultAdapter,
  routeTimeoutMs: DEFAULT_ROUTE_TIMEOUT_MS,
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
//   - RouteTimeoutError (from withTimeout, above) — the aggregate route
//     deadline was exceeded; always a safe 503, never leaks which specific
//     network call was still in flight.
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
  if (err instanceof RouteTimeoutError) {
    return res.status(503).json({ error: 'The request took too long to complete. Please try again.', code: err.code });
  }
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

// Bounded as ONE aggregate operation (not per-call) — a full-roster
// snapshot fetch followed by six more paginated metadata-definition calls
// is exactly the "several sequential network calls in one request" case
// the route-timeout wrapper exists for (see its own header note above
// defaultDeps).
async function fetchLiveMetadata(deps, churchId, credentials, force) {
  return withTimeout((async () => {
    const snapshot = await deps.adapter.fetchSnapshot({ churchId, credentials, mode: 'full' });
    return deps.adapter.fetchMetadata({ churchId, credentials, force, snapshot });
  })(), deps.routeTimeoutMs);
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
      const validation = await withTimeout(
        deps.adapter.validateConnection({ churchId, credentials: { apiKey } }), deps.routeTimeoutMs
      );
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
      const bodyError = validateBatchBody(body, { requireName: false, current: existing });
      if (bodyError) return res.status(400).json({ error: bodyError });

      const fields = extractBatchFields(body);
      // Re-validate whenever EITHER filterConfig OR filterSchemaVersion is
      // present in the patch — not just filterConfig alone. A body of
      // `{filterSchemaVersion: 2}` on its own used to skip this entirely
      // (normaliseBatchInput only checks filterSchemaVersion is a positive
      // integer; it has no idea validateElvantoFilter hard-rejects anything
      // != version 1), silently persisting a filterConfig/filterSchemaVersion
      // pair that would then fail SYNC_BATCH_FILTER_INVALID on every future
      // plan/apply/run-now AND every scheduled run for this batch forever —
      // and the scheduled path just logs and skips, so it would fail
      // silently. Validates the EFFECTIVE resulting pair: whichever of the
      // two this patch supplies, plus whichever it doesn't (from the
      // existing stored batch).
      if (Object.hasOwn(fields, 'filterConfig') || Object.hasOwn(fields, 'filterSchemaVersion')) {
        const filterConfig = Object.hasOwn(fields, 'filterConfig') ? fields.filterConfig : existing.filterConfig;
        const filterSchemaVersion = Object.hasOwn(fields, 'filterSchemaVersion')
          ? fields.filterSchemaVersion : existing.filterSchemaVersion;
        const filterValidation = deps.adapter.validateFilter(filterConfig, filterSchemaVersion);
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
      const result = await withTimeout(
        deps.buildReview({ churchId, provider: PROVIDER, batchId, trigger: 'manual' }), deps.routeTimeoutMs
      );
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
      const result = await withTimeout(
        deps.applyReviewed({ churchId, provider: PROVIDER, batchId, reviewToken, selections, userId: req.user.id }),
        deps.routeTimeoutMs
      );
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
      //
      // The ENTIRE unit of work — the orchestrator call AND its batch
      // bookkeeping — is raced against the timeout as ONE continuation
      // (`work`), not just the orchestrator call alone. withTimeout does
      // NOT cancel the losing promise (see its own header note): if the
      // timeout wins, runUnattended keeps running in the background,
      // still commits real data mutations, and still finishes its own run
      // row — so recordBatchResult must run as part of that SAME
      // background continuation regardless of whether the client-facing
      // response already timed out. Racing only the orchestrator call (an
      // earlier version of this route did) left a real regression: a run
      // that genuinely completed after the client-facing deadline would
      // never update people_sync_batches.last_sync_at/last_sync_result/
      // last_external_watermark, making the batch look "never synced"
      // forever and starting the next incremental run from a stale
      // watermark.
      const work = (async () => {
        const workResult = await deps.runUnattended({ churchId, provider: PROVIDER, batchId, trigger: 'run_now' });
        try {
          await deps.recordBatchResult({
            churchId, provider: PROVIDER, batchId, trigger: 'run_now',
            fetchMode: workResult.fetchMode, complete: workResult.complete,
            status: workResult.status, externalWatermark: workResult.externalWatermark,
          });
        } catch (recordErr) {
          logger.error(
            `elvanto POST /sync-batches/:id/run-now: failed to record batch result for batch ${batchId} (church ${churchId}): ${recordErr.message}`
          );
        }
        return workResult;
      })();

      const result = await withTimeout(work, deps.routeTimeoutMs);
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
