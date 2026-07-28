'use strict';

// Provider-neutral Boolean-filter endpoints.  This router intentionally has
// no provider client calls except the explicit refresh endpoint: previews and
// draft editing must be useful offline against the complete, church-scoped
// facts snapshot without ever putting provider people/IDs on the wire.
const express = require('express');
const logger = require('../../config/logger');
const Database = require('../../config/database');
const { requireRole } = require('../../middleware/auth');
const { ensureChurchIsolation } = require('../../middleware/churchIsolation');
const providerRegistry = require('../../services/peopleSync/providerRegistry');
const connectionStore = require('../../services/peopleSync/connectionStore');
const batchRepository = require('../../services/peopleSync/batchRepository');
const filterFactsCache = require('../../services/peopleSync/filterFactsCache');
const { captureFilterSnapshotInput, populationGateDigest, normalizeProviderMetadata } = require('../../services/peopleSync/filterSnapshot');
const { previewFilter, requiredDimensionIdsForBatch } = require('../../services/peopleSync/filterPreview');
const { validateFilterV2, evaluateFilterV2, selectedDimensionIds, selectedPairs } = require('../../services/peopleSync/filterEngine');
const { convertV1Filter, compareUpgradeSets, createUpgradeToken, applyCompatibleUpgrades } = require('../../services/peopleSync/filterUpgrade');
const pcoSync = require('../../services/planningCenterSync');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const PEOPLE_TYPES = new Set(['regular', 'local_visitor', 'traveller_visitor']);
const MAX_BODY_BYTES = 64 * 1024;
const EMPTY_V2 = Object.freeze({ branches: [], exclusions: [] });

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function parseProvider(value) {
  return typeof value === 'string' && PROVIDERS.has(value) ? value : null;
}

function parseBatchId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function dimensionsFromBatches(batches, proposedConfig, selectedDimensions, requiredDimensions) {
  const dimensions = new Set();
  for (const batch of Array.isArray(batches) ? batches : []) {
    const required = requiredDimensions(batch);
    if (required === null) return null;
    for (const dimensionId of required) dimensions.add(dimensionId);
  }
  for (const dimensionId of selectedDimensions(proposedConfig || EMPTY_V2)) dimensions.add(dimensionId);
  return [...dimensions].sort();
}

function snapshotDto(entry) {
  if (!entry) return null;
  return {
    id: entry.snapshotId,
    capturedAt: entry.capturedAt,
    fresh: Boolean(entry.fresh),
    expiresAt: entry.expiresAt,
    coveredDimensionIds: [...new Set(entry.coveredDimensionIds || [])].sort(),
  };
}

function metadataFromEntry(entry) {
  return { dimensions: Array.isArray(entry?.dimensions) ? entry.dimensions : [] };
}

function safeBatch(batch) {
  if (!batch) return null;
  // Batch DTOs carry only local IDs/configuration. Explicitly construct the
  // response so a future repository field cannot leak facts or credentials.
  return {
    id: batch.id,
    provider: batch.provider,
    filterSchemaVersion: batch.filterSchemaVersion,
    filterConfig: batch.filterConfig,
    filterRevision: batch.filterRevision,
    draftFilterSchemaVersion: batch.draftFilterSchemaVersion ?? null,
    draftFilterConfig: batch.draftFilterConfig ?? null,
    draftFilterBaseRevision: batch.draftFilterBaseRevision ?? null,
    draftFilterUpdatedAt: batch.draftFilterUpdatedAt ?? null,
    needsFilterReview: Boolean(batch.needsFilterReview),
  };
}

function isNotOnlyFilter(config) {
  return isPlainObject(config) && Array.isArray(config.branches) && config.branches.length === 0 &&
    Array.isArray(config.exclusions) && config.exclusions.length > 0;
}

function permissiveMetadata(config, selectedPairsFn) {
  const byDimension = new Map();
  for (const pair of selectedPairsFn(config)) {
    if (!byDimension.has(pair.dimensionId)) byDimension.set(pair.dimensionId, new Set());
    byDimension.get(pair.dimensionId).add(pair.valueId);
  }
  return { dimensions: [...byDimension].map(([id, values]) => ({ id, cardinality: 'multi', values: [...values].map((valueId) => ({ id: valueId })) })) };
}

function validateProposedFilter(config, entry, deps) {
  const metadata = entry ? metadataFromEntry(entry) : permissiveMetadata(config, deps.selectedPairs);
  return deps.validateFilterV2(config, metadata);
}

function createFilterBuilderJsonParser() {
  const parser = express.json({ limit: MAX_BODY_BYTES, strict: true });
  return (req, res, next) => parser(req, res, (error) => {
    if (!error) return next();
    if (error.type === 'entity.too.large' || error.type === 'entity.parse.failed') {
      return res.status(error.type === 'entity.too.large' ? 413 : 400)
        .json({ error: 'Invalid filter request.', code: 'SYNC_FILTER_INVALID' });
    }
    next(error);
  });
}

function unresolvedPairsFromDraft(batch, selectedPairsFn) {
  const active = Number(batch?.filterSchemaVersion) === 2 && batch?.filterConfig
    ? selectedPairsFn(batch.filterConfig) : [];
  const draft = batch?.draftFilterConfig ? selectedPairsFn(batch.draftFilterConfig) : [];
  return new Set([...active, ...draft]
    .map((pair) => JSON.stringify([pair.dimensionId, pair.valueId])));
}

function safeError(res, error, label) {
  const code = error?.code;
  if (code === 'SYNC_FILTER_DRAFT_STALE') return res.status(409).json({ error: 'The filter draft changed. Refresh and try again.', code });
  if (code === 'SYNC_FILTER_UPGRADE_STALE' || code === 'SYNC_UPGRADE_STALE') {
    return res.status(409).json({ error: 'The filter upgrade is no longer current. Refresh and try again.', code: 'SYNC_FILTER_UPGRADE_STALE' });
  }
  logger.error(`${label}: ${error?.message}`, { stack: error?.stack });
  return res.status(500).json({ error: 'Unable to complete this filter request.' });
}

async function defaultCredentials(churchId, provider) {
  if (provider !== 'planning_center') return connectionStore.getCredentials(churchId, provider);
  const owned = await pcoSync.getTokensForChurch(churchId);
  return owned?.tokens?.access_token ? { accessToken: owned.tokens.access_token } : null;
}

async function defaultGetSettings(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT elvanto_include_contacts, elvanto_align_people_type
       FROM people_sync_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  const row = rows[0] || {};
  return {
    includeContacts: row.elvanto_include_contacts === undefined ? true : !!row.elvanto_include_contacts,
    alignPeopleType: row.elvanto_align_people_type === undefined ? true : !!row.elvanto_align_people_type,
  };
}

const defaultDeps = {
  getProvider: providerRegistry.getProvider,
  getCredentials: defaultCredentials,
  listBatches: batchRepository.listBatches,
  getBatch: batchRepository.getBatch,
  saveFilterDraft: batchRepository.saveFilterDraft,
  discardFilterDraft: batchRepository.discardFilterDraft,
  cache: filterFactsCache,
  getSettings: defaultGetSettings,
  captureFilterSnapshotInput,
  populationGateDigest,
  normalizeProviderMetadata,
  previewFilter,
  validateFilterV2,
  evaluateFilterV2,
  selectedDimensionIds,
  selectedPairs,
  requiredDimensionIdsForBatch,
  peekCachedPcoPeople: pcoSync.peekCachedPcoPeople,
  convertV1Filter,
  compareUpgradeSets,
  createUpgradeToken,
  applyCompatibleUpgrades,
};

function createFilterBuilderRouter(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  // A mounted integrations router already establishes these guards. Keep them
  // here as a hard boundary for tests, alternative mounts, and future routes.
  router.use(ensureChurchIsolation);
  router.use(requireRole(['admin']));

  router.param('provider', (req, res, next, provider) => {
    if (!parseProvider(provider)) return res.status(404).json({ error: 'Sync provider not found.' });
    next();
  });

  router.get('/:provider/filter-metadata', async (req, res) => {
    const churchId = req.user.church_id;
    const provider = req.params.provider;
    try {
      let entry = deps.cache.get(churchId, provider);
      // Cold PCO metadata must not make a provider call. A warm PCO roster is
      // safe to project locally, but it only exposes the dimensions already
      // needed by active filters until an explicit full refresh supplies more.
      if (!entry && provider === 'planning_center') {
        const warm = deps.peekCachedPcoPeople(churchId);
        if (warm) {
          const adapter = deps.getProvider(provider);
          const batches = await deps.listBatches(churchId, provider);
          const coverage = dimensionsFromBatches(batches, EMPTY_V2, deps.selectedDimensionIds, deps.requiredDimensionIdsForBatch);
          if (!coverage) return res.status(400).json({ error: 'Invalid saved filter.', code: 'SYNC_FILTER_INVALID' });
          const facts = (warm.people || []).filter((person) => adapter.isInFilterPopulation(person, {}))
            .map((person) => adapter.toFilterFacts(person, new Set(coverage)));
          entry = { snapshotId: null, capturedAt: new Date(warm.fetchedAt || Date.now()).toISOString(), fresh: true,
            expiresAt: null, coveredDimensionIds: coverage,
            dimensions: adapter.buildFilterDimensions({ facts, providerMetadata: {}, coveredDimensionIds: coverage }) };
        }
      }
      if (!entry) return res.status(409).json({ error: 'A complete filter snapshot is required.', code: 'SYNC_FILTER_CACHE_UNAVAILABLE' });
      return res.json({ success: true, metadata: metadataFromEntry(entry), snapshot: snapshotDto(entry) });
    } catch (error) {
      return safeError(res, error, 'filter metadata');
    }
  });

  router.post('/:provider/filter-snapshot/refresh', async (req, res) => {
    const churchId = req.user.church_id;
    const provider = req.params.provider;
    try {
      const body = req.body;
      if (body !== undefined && !isPlainObject(body)) return res.status(400).json({ error: 'Invalid filter request.', code: 'SYNC_FILTER_INVALID' });
      if (body && !Object.keys(body).every((key) => key === 'filterConfig') || body?.filterConfig !== undefined && !isPlainObject(body.filterConfig)) {
        return res.status(400).json({ error: 'Invalid filter request.', code: 'SYNC_FILTER_INVALID' });
      }
      const previous = deps.cache.get(churchId, provider);
      const proposedValidation = validateProposedFilter(body?.filterConfig || EMPTY_V2, previous, deps);
      if (!proposedValidation.ok) return res.status(400).json({ error: 'Invalid filter request.', code: 'SYNC_FILTER_INVALID' });
      const proposedConfig = proposedValidation.value;
      const batches = await deps.listBatches(churchId, provider);
      const coveredDimensionIds = dimensionsFromBatches(batches, proposedConfig, deps.selectedDimensionIds, deps.requiredDimensionIdsForBatch);
      if (!coveredDimensionIds) return res.status(400).json({ error: 'Invalid saved filter.', code: 'SYNC_FILTER_INVALID' });
      const credentials = await deps.getCredentials(churchId, provider);
      if (!credentials) return res.status(409).json({ error: 'A provider connection is required.', code: 'SYNC_FILTER_CACHE_UNAVAILABLE' });
      const adapter = deps.getProvider(provider);
      const snapshot = await adapter.fetchSnapshot({ churchId, credentials, mode: 'full', customFieldIds: coveredDimensionIds
        .filter((id) => id.startsWith('custom_field:')).map((id) => id.slice('custom_field:'.length)) });
      if (!snapshot || snapshot.complete !== true || snapshot.mode !== 'full' || !Array.isArray(snapshot.people)) {
        return res.status(409).json({ error: 'The provider did not return a complete snapshot.', code: 'SYNC_FILTER_CACHE_UNAVAILABLE' });
      }
      // Metadata consumes exactly this captured snapshot. It is deliberately
      // not allowed to ask the adapter for a second people snapshot.
      // PCO's metadata adapter reuses its just-refreshed people cache when
      // force is false; Elvanto consumes `snapshot` directly. In both cases
      // this does not initiate a second roster fetch.
      const metadataResult = await adapter.fetchMetadata({ churchId, credentials, snapshot, force: false });
      const providerMetadata = deps.normalizeProviderMetadata(provider, metadataResult);
      const settings = await deps.getSettings(churchId, provider);
      const captured = deps.captureFilterSnapshotInput({ provider, snapshot, providerMetadata, settings, coveredDimensionIds, adapter });
      const entry = deps.cache.putComplete({ churchId, provider, mode: 'full', complete: true,
        coveredDimensionIds: captured.coverage, facts: captured.facts, dimensions: captured.dimensions,
        populationGateDigest: captured.populationGateDigest });
      return res.json({ success: true, metadata: metadataFromEntry(entry), snapshot: snapshotDto(entry) });
    } catch (error) {
      return safeError(res, error, 'filter snapshot refresh');
    }
  });

  router.post('/:provider/filter-preview', async (req, res) => {
    const churchId = req.user.church_id;
    const provider = req.params.provider;
    try {
      const body = req.body;
      if (!isPlainObject(body) || !Object.keys(body).every((key) => ['batchId', 'filterConfig', 'enabled', 'defaultPeopleType', 'gatheringTypeId'].includes(key)) ||
          !(body.batchId === null || (Number.isSafeInteger(body.batchId) && body.batchId > 0)) || !isPlainObject(body.filterConfig) ||
          typeof body.enabled !== 'boolean' || !PEOPLE_TYPES.has(body.defaultPeopleType) ||
          !(body.gatheringTypeId === null || (Number.isSafeInteger(body.gatheringTypeId) && body.gatheringTypeId > 0))) {
        return res.status(400).json({ error: 'Invalid filter preview.', code: 'SYNC_FILTER_INVALID' });
      }
      const targetBatch = body.batchId === null ? null : await deps.getBatch(churchId, provider, body.batchId);
      if (body.batchId !== null && !targetBatch) {
        return res.status(404).json({ error: 'Sync batch not found.' });
      }
      const cacheEntry = deps.cache.get(churchId, provider);
      if (!cacheEntry) return res.status(409).json({ error: 'A complete filter snapshot is required.', code: 'SYNC_FILTER_CACHE_UNAVAILABLE' });
      const validation = deps.validateFilterV2(body.filterConfig, metadataFromEntry(cacheEntry), {
        allowedUnresolvedPairs: unresolvedPairsFromDraft(targetBatch, deps.selectedPairs),
      });
      if (!validation.ok) return res.status(400).json({ error: 'Invalid filter preview.', code: 'SYNC_FILTER_INVALID' });
      const batches = await deps.listBatches(churchId, provider);
      const settings = await deps.getSettings(churchId, provider);
      const result = deps.previewFilter({ churchId, provider, batchId: body.batchId, cacheEntry, batches,
        metadata: metadataFromEntry(cacheEntry), populationGateDigest: deps.populationGateDigest(provider, settings),
        proposed: { filterSchemaVersion: 2, filterConfig: validation.value, enabled: body.enabled,
          defaultPeopleType: body.defaultPeopleType, gatheringTypeId: body.gatheringTypeId } });
      return res.json({ success: true, matchCount: result.matchCount, snapshot: result.snapshot, overlaps: result.overlaps,
        uniqueEnabledPopulationCount: result.uniqueEnabledPopulationCount, missingDimensionIds: result.missingDimensionIds, warnings: result.warnings });
    } catch (error) {
      return safeError(res, error, 'filter preview');
    }
  });

  router.put('/:provider/sync-batches/:id/filter-draft', async (req, res) => {
    const churchId = req.user.church_id;
    const provider = req.params.provider;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid sync batch id.', code: 'SYNC_FILTER_INVALID' });
    try {
      const body = req.body;
      if (!isPlainObject(body) || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'filterConfig') ||
          !Object.hasOwn(body, 'broadMatchAcknowledged') || !isPlainObject(body.filterConfig) || typeof body.broadMatchAcknowledged !== 'boolean') {
        return res.status(400).json({ error: 'Invalid filter draft.', code: 'SYNC_FILTER_INVALID' });
      }
      const batch = await deps.getBatch(churchId, provider, batchId);
      if (!batch) return res.status(404).json({ error: 'Sync batch not found.' });
      const entry = deps.cache.get(churchId, provider);
      if (!entry) return res.status(409).json({ error: 'A complete filter snapshot is required.', code: 'SYNC_FILTER_CACHE_UNAVAILABLE' });
      const validation = deps.validateFilterV2(body.filterConfig, metadataFromEntry(entry), {
        allowedUnresolvedPairs: unresolvedPairsFromDraft(batch, deps.selectedPairs),
      });
      if (!validation.ok) return res.status(400).json({ error: 'Invalid filter draft.', code: 'SYNC_FILTER_INVALID' });
      const wholePopulation = Array.isArray(entry.facts) && entry.facts.length > 0 &&
        entry.facts.every((facts) => deps.evaluateFilterV2(facts, validation.value));
      if ((isNotOnlyFilter(validation.value) || wholePopulation) && !body.broadMatchAcknowledged) {
        return res.status(400).json({ error: 'Broad filters must be acknowledged.', code: 'SYNC_FILTER_BROAD_ACK_REQUIRED' });
      }
      const saved = await deps.saveFilterDraft({ churchId, provider, batchId, schemaVersion: 2, filterConfig: validation.value });
      return res.json({ success: true, batch: safeBatch(saved) });
    } catch (error) {
      return safeError(res, error, 'save filter draft');
    }
  });

  router.delete('/:provider/sync-batches/:id/filter-draft', async (req, res) => {
    const churchId = req.user.church_id;
    const provider = req.params.provider;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid sync batch id.', code: 'SYNC_FILTER_INVALID' });
    try {
      if (!(await deps.getBatch(churchId, provider, batchId))) return res.status(404).json({ error: 'Sync batch not found.' });
      const batch = await deps.discardFilterDraft(churchId, provider, batchId);
      return res.json({ success: true, batch: safeBatch(batch) });
    } catch (error) {
      return safeError(res, error, 'discard filter draft');
    }
  });

  router.post('/:provider/sync-batches/:id/filter-upgrade/preview', async (req, res) => {
    const churchId = req.user.church_id;
    const provider = req.params.provider;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null) return res.status(400).json({ error: 'Invalid sync batch id.', code: 'SYNC_FILTER_INVALID' });
    try {
      const batch = await deps.getBatch(churchId, provider, batchId);
      const entry = deps.cache.get(churchId, provider);
      if (!batch) return res.status(404).json({ error: 'Sync batch not found.' });
      if (Number(batch.filterSchemaVersion) !== 1 || !entry || entry.fresh !== true) return res.status(409).json({ error: 'A fresh legacy filter snapshot is required.', code: 'SYNC_FILTER_UPGRADE_STALE' });
      const converted = deps.convertV1Filter(provider, batch.filterConfig);
      const comparison = deps.compareUpgradeSets({ provider, config: batch.filterConfig, facts: entry.facts, convertedConfig: converted });
      const token = deps.createUpgradeToken({ churchId, provider, batchId: batch.id, filterRevision: batch.filterRevision,
        activeConfigDigest: require('../../services/peopleSync/planDigest').digestFilterConfig(batch.filterConfig), snapshotId: entry.snapshotId,
        convertedDigest: require('../../services/peopleSync/planDigest').digestFilterConfig(converted), compatible: comparison.compatible });
      return res.json({ success: true, compatible: comparison.compatible, oldCount: comparison.oldCount, newCount: comparison.newCount,
        convertedFilterConfig: converted, snapshot: snapshotDto(entry), upgradeToken: token });
    } catch (error) {
      return safeError(res, error, 'filter upgrade preview');
    }
  });

  router.post('/:provider/sync-batches/:id/filter-upgrade/apply', async (req, res) => {
    const provider = req.params.provider;
    const batchId = parseBatchId(req.params.id);
    if (batchId === null || !isPlainObject(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.upgradeToken !== 'string') {
      return res.status(400).json({ error: 'Invalid filter upgrade.', code: 'SYNC_FILTER_INVALID' });
    }
    try {
      const result = await deps.applyCompatibleUpgrades({ churchId: req.user.church_id, provider, upgrades: [{ batchId, upgradeToken: req.body.upgradeToken }], cache: deps.cache });
      return res.json({ success: true, batches: result });
    } catch (error) { return safeError(res, error, 'apply filter upgrade'); }
  });

  router.post('/:provider/filter-upgrades/apply-compatible', async (req, res) => {
    const provider = req.params.provider;
    const upgrades = req.body?.upgrades;
    if (!isPlainObject(req.body) || Object.keys(req.body).length !== 1 || !Array.isArray(upgrades) || upgrades.length === 0 ||
        !upgrades.every((item) => isPlainObject(item) && Object.keys(item).length === 2 &&
          Number.isSafeInteger(item.batchId) && item.batchId > 0 && typeof item.upgradeToken === 'string')) {
      return res.status(400).json({ error: 'Invalid filter upgrade.', code: 'SYNC_FILTER_INVALID' });
    }
    try {
      const batches = await deps.applyCompatibleUpgrades({ churchId: req.user.church_id, provider, upgrades, cache: deps.cache });
      return res.json({ success: true, batches });
    } catch (error) { return safeError(res, error, 'apply compatible filter upgrades'); }
  });

  return router;
}

module.exports = { createFilterBuilderRouter, createFilterBuilderJsonParser, defaultDeps, MAX_BODY_BYTES, isNotOnlyFilter };
