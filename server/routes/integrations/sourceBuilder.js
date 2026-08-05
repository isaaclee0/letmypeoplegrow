'use strict';

const express = require('express');
const logger = require('../../config/logger');
const { requireRole } = require('../../middleware/auth');
const { ensureChurchIsolation } = require('../../middleware/churchIsolation');
const providerRegistry = require('../../services/peopleSync/providerRegistry');
const connectionStore = require('../../services/peopleSync/connectionStore');
const batchRepository = require('../../services/peopleSync/batchRepository');
const { resolveVisibleSource } = require('../../services/peopleSync/sourceSelection');
const { SOURCE_KINDS_BY_PROVIDER } = require('../../services/peopleSync/sourceModel');
const {
  deriveBatchOperationalState,
  isBatchReviewable,
  isBatchRunnable,
} = require('../../services/peopleSync/batchOperationalState');
const authority = require('../../services/peopleSync/authority');
const {
  CODE: LEGACY_BATCH_RETIRED, MESSAGE: LEGACY_BATCH_RETIRED_MESSAGE, assertPlanningCenterBatchOperational,
} = require('../../services/peopleSync/legacyBatch');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const MAX_BODY_BYTES = 16 * 1024;

function safeSource(source) {
  if (!source) return null;
  return {
    kind: source.kind,
    externalId: source.externalId,
    name: source.name,
    memberCount: source.memberCount ?? null,
    providerRefreshedAt: source.providerRefreshedAt ?? null,
  };
}

function withOperationalState(batch, authorityProvider) {
  const operationalState = deriveBatchOperationalState(batch, authorityProvider);
  return {
    ...batch,
    operationalState,
    reviewable: isBatchReviewable(batch, authorityProvider),
    runnable: isBatchRunnable(batch, authorityProvider),
  };
}

function safeBatch(batch, authorityProvider) {
  if (!batch) return null;
  return withOperationalState({
    id: batch.id,
    provider: batch.provider,
    name: batch.name,
    enabled: Boolean(batch.enabled),
    source: safeSource(batch.source),
    sourceRevision: batch.sourceRevision,
    draftSource: safeSource(batch.draftSource),
    draftSourceBaseRevision: batch.draftSourceBaseRevision ?? null,
    draftSourceUpdatedAt: batch.draftSourceUpdatedAt ?? null,
    needsSourceReview: Boolean(batch.needsSourceReview),
    initialSourceReviewPending: Boolean(batch.initialSourceReviewPending),
    sourceStatus: batch.sourceStatus ?? 'unknown',
    sourceStatusCheckedAt: batch.sourceStatusCheckedAt ?? null,
    sourceStatusErrorCode: batch.sourceStatusErrorCode ?? null,
    unresolvedIdentityCount: Number.isSafeInteger(batch.unresolvedIdentityCount)
      ? batch.unresolvedIdentityCount
      : null,
    defaultPeopleType: batch.defaultPeopleType,
    gatheringTypeId: batch.gatheringTypeId ?? null,
    gatheringAutoRemoveEnabled: Boolean(batch.gatheringAutoRemoveEnabled),
    scheduleEnabled: Boolean(batch.scheduleEnabled),
    scheduleFrequency: batch.scheduleFrequency,
    scheduleDay: batch.scheduleDay,
  }, authorityProvider);
}

function parseBatchId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function sourceUnavailable() {
  const error = new Error('The requested sync source is unavailable. Reconnect the provider and try again.');
  error.code = 'SYNC_SOURCE_UNAVAILABLE';
  return error;
}

async function defaultListSources({ churchId, provider }) {
  const credentials = await connectionStore.getCredentials(churchId, provider);
  if (!credentials) throw sourceUnavailable();
  try {
    return await providerRegistry.getProvider(provider).listSources({ churchId, credentials });
  } catch (error) {
    throw sourceUnavailable();
  }
}

function createJsonParser() {
  const parser = express.json({ limit: MAX_BODY_BYTES, strict: true });
  return (req, res, next) => parser(req, res, (error) => {
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Invalid sync source request.', code: 'SYNC_SOURCE_INVALID' });
    if (error?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid sync source request.', code: 'SYNC_SOURCE_INVALID' });
    return error ? next(error) : next();
  });
}

function respondError(res, error, label) {
  if (error?.code === 'SYNC_SOURCE_UNAVAILABLE') return res.status(409).json({ error: 'The requested sync source is unavailable. Reconnect the provider and try again.', code: error.code });
  if (error?.code === 'SYNC_SOURCE_INITIAL_REVIEW_REQUIRED') return res.status(409).json({ error: 'The initial source must be reviewed before this batch can run.', code: error.code });
  if (error?.code === LEGACY_BATCH_RETIRED) return res.status(409).json({ error: LEGACY_BATCH_RETIRED_MESSAGE, code: error.code });
  logger.error(`${label}: ${error?.message}`, { stack: error?.stack });
  return res.status(500).json({ error: 'Unable to complete this sync source request.' });
}

function validSourceBody(body, provider) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 ||
      typeof body.sourceKind !== 'string' || typeof body.sourceExternalId !== 'string' ||
      !body.sourceKind.trim() || !body.sourceExternalId.trim() || !SOURCE_KINDS_BY_PROVIDER[provider]?.has(body.sourceKind)) return false;
  return true;
}

const defaultDeps = {
  getAuthority: authority.getAuthority,
  listSources: defaultListSources,
  resolveVisibleSource,
  getBatch: batchRepository.getBatch,
  saveSourceDraft: batchRepository.saveSourceDraft,
  discardSourceDraft: batchRepository.discardSourceDraft,
};

function createSourceBuilderRouter(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();
  router.use(ensureChurchIsolation);
  router.use(requireRole(['admin']));
  router.use(createJsonParser());
  router.param('provider', (req, res, next, provider) => {
    if (!PROVIDERS.has(provider)) return res.status(404).json({ error: 'Sync provider not found.' });
    return next();
  });

  router.get('/:provider/sources', async (req, res) => {
    try {
      const sources = await deps.listSources({ churchId: req.user.church_id, provider: req.params.provider });
      return res.json({ success: true, sources: (Array.isArray(sources) ? sources : []).map(safeSource) });
    } catch (error) { return respondError(res, error, 'list sync sources'); }
  });

  router.put('/:provider/sync-batches/:id/source-draft', async (req, res) => {
    const provider = req.params.provider;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null || !validSourceBody(req.body, provider)) return res.status(400).json({ error: 'Invalid sync source request.', code: 'SYNC_SOURCE_INVALID' });
    const churchId = req.user.church_id;
    try {
      const existing = await deps.getBatch(churchId, provider, batchId);
      if (!existing) return res.status(404).json({ error: 'Sync batch not found.' });
      assertPlanningCenterBatchOperational(existing);
      const resolved = await deps.resolveVisibleSource({ churchId, provider, sourceKind: req.body.sourceKind, sourceExternalId: req.body.sourceExternalId });
      const batch = await deps.saveSourceDraft({ churchId, provider, batchId, source: { kind: resolved.kind, externalId: resolved.externalId, name: resolved.name } });
      const authorityState = await deps.getAuthority(churchId);
      return res.json({ success: true, batch: safeBatch(batch, authorityState.active) });
    } catch (error) { return respondError(res, error, 'save sync source draft'); }
  });

  router.delete('/:provider/sync-batches/:id/source-draft', async (req, res) => {
    const provider = req.params.provider;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid sync source request.', code: 'SYNC_SOURCE_INVALID' });
    const churchId = req.user.church_id;
    try {
      const existing = await deps.getBatch(churchId, provider, batchId);
      if (!existing) return res.status(404).json({ error: 'Sync batch not found.' });
      assertPlanningCenterBatchOperational(existing);
      const batch = await deps.discardSourceDraft(churchId, provider, batchId);
      const authorityState = await deps.getAuthority(churchId);
      return res.json({ success: true, batch: safeBatch(batch, authorityState.active) });
    } catch (error) { return respondError(res, error, 'discard sync source draft'); }
  });
  return router;
}

module.exports = { createSourceBuilderRouter, createSourceBuilderJsonParser: createJsonParser, safeSource, safeBatch, withOperationalState, defaultDeps, MAX_BODY_BYTES };
