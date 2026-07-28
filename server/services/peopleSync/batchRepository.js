const Database = require('../../config/database');
const crypto = require('node:crypto');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const PEOPLE_TYPES = new Set(['regular', 'local_visitor', 'traveller_visitor']);
const RUN_STATUSES = new Set(['review_required', 'applied', 'failed', 'cancelled']);

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported people-sync provider: ${provider}`);
}

function parseFilterConfig(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertBooleanFilterV2Envelope(filterConfig) {
  if (!isPlainObject(filterConfig) ||
      Object.keys(filterConfig).length !== 2 ||
      !Object.hasOwn(filterConfig, 'branches') || !Object.hasOwn(filterConfig, 'exclusions') ||
      !Array.isArray(filterConfig.branches) || !Array.isArray(filterConfig.exclusions) ||
      !filterConfig.branches.every((branch) => isPlainObject(branch) &&
        Object.keys(branch).length === 1 && Object.hasOwn(branch, 'groups') && Array.isArray(branch.groups))) {
    throw new Error('Invalid Boolean filter v2 envelope');
  }
}

function assertSchema2ActiveFilterUsesDrafts() {
  throw new Error('Schema-2 active filters must use saveFilterDraft and promoteFilterDraftWithConnection');
}

function canonicalFilterJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalFilterJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalFilterJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestFilterConfig(value) {
  return crypto.createHash('sha256').update(canonicalFilterJson(value)).digest('hex');
}

function parseDraftFilterConfig(value) {
  return value === null || value === undefined ? null : parseFilterConfig(value);
}

function toBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: Boolean(row.enabled),
    filterSchemaVersion: Number(row.filter_schema_version),
    filterConfig: parseFilterConfig(row.filter_config),
    filterRevision: Number(row.filter_revision),
    draftFilterSchemaVersion: row.draft_filter_schema_version === null ? null : Number(row.draft_filter_schema_version),
    draftFilterConfig: parseDraftFilterConfig(row.draft_filter_config),
    draftFilterBaseRevision: row.draft_filter_base_revision === null ? null : Number(row.draft_filter_base_revision),
    draftFilterUpdatedAt: row.draft_filter_updated_at,
    needsFilterReview: row.draft_filter_config !== null,
    defaultPeopleType: row.default_people_type,
    gatheringTypeId: row.gathering_type_id,
    gatheringAutoRemoveEnabled: Boolean(row.gathering_auto_remove_enabled),
    scheduleEnabled: Boolean(row.schedule_enabled),
    scheduleFrequency: row.schedule_frequency,
    scheduleDay: Number(row.schedule_day),
    legacyProviderBatchId: row.legacy_provider_batch_id,
    lastExternalWatermark: row.last_external_watermark,
    lastSyncAt: row.last_sync_at,
    lastSyncResult: row.last_sync_result,
  };
}

async function getBatch(churchId, provider, batchId) {
  assertProvider(provider);
  const rows = await Database.queryForChurch(churchId, `SELECT * FROM people_sync_batches
    WHERE id = ? AND church_id = ? AND provider = ?`, [batchId, churchId, provider]);
  return toBatch(rows[0]);
}

async function listBatches(churchId, provider) {
  assertProvider(provider);
  const rows = await Database.queryForChurch(churchId, `SELECT * FROM people_sync_batches
    WHERE church_id = ? AND provider = ? ORDER BY id`, [churchId, provider]);
  return rows.map(toBatch);
}

async function listEnabledBatches(churchId, provider) {
  assertProvider(provider);
  const rows = await Database.queryForChurch(churchId, `SELECT * FROM people_sync_batches
    WHERE church_id = ? AND provider = ? AND enabled = 1 ORDER BY id`, [churchId, provider]);
  return rows.map(toBatch);
}

function normaliseBatchInput(input) {
  const {
    churchId, provider, name, enabled = true, filterSchemaVersion = 1, filterConfig = {},
    defaultPeopleType = 'regular', gatheringTypeId = null, gatheringAutoRemoveEnabled = false,
    scheduleEnabled = false, scheduleFrequency = 'weekly', scheduleDay = 1, legacyProviderBatchId = null,
    initialDraftFilterConfig,
  } = input || {};
  assertProvider(provider);
  if (!churchId || typeof name !== 'string' || !name.trim()) throw new Error('A batch name is required');
  if (!Number.isInteger(filterSchemaVersion) || filterSchemaVersion < 1) throw new Error('Invalid filter schema version');
  if (!filterConfig || typeof filterConfig !== 'object' || Array.isArray(filterConfig)) throw new Error('Filter config must be an object');
  if (initialDraftFilterConfig !== undefined) {
    assertBooleanFilterV2Envelope(initialDraftFilterConfig);
  }
  if (!PEOPLE_TYPES.has(defaultPeopleType)) throw new Error('Invalid default people type');
  return {
    churchId, provider, name: name.trim(), enabled: Boolean(enabled), filterSchemaVersion, filterConfig,
    defaultPeopleType, gatheringTypeId, gatheringAutoRemoveEnabled: Boolean(gatheringAutoRemoveEnabled),
    scheduleEnabled: Boolean(scheduleEnabled), scheduleFrequency, scheduleDay, legacyProviderBatchId,
    initialDraftFilterConfig,
  };
}

async function createBatch(input) {
  const batch = normaliseBatchInput(input);
  const hasInitialDraft = batch.initialDraftFilterConfig !== undefined;
  if (!hasInitialDraft && batch.filterSchemaVersion === 2) assertSchema2ActiveFilterUsesDrafts();
  const activeFilterSchemaVersion = hasInitialDraft ? 2 : batch.filterSchemaVersion;
  const activeFilterConfig = hasInitialDraft ? { branches: [], exclusions: [] } : batch.filterConfig;
  const result = await Database.queryForChurch(batch.churchId, `INSERT INTO people_sync_batches
    (church_id, provider, name, enabled, filter_schema_version, filter_config, default_people_type,
     gathering_type_id, gathering_auto_remove_enabled, schedule_enabled, schedule_frequency, schedule_day,
     legacy_provider_batch_id, draft_filter_schema_version, draft_filter_config, draft_filter_base_revision,
     draft_filter_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CASE WHEN ? THEN datetime('now') ELSE NULL END)`, [
    batch.churchId, batch.provider, batch.name, batch.enabled, activeFilterSchemaVersion,
    JSON.stringify(activeFilterConfig), batch.defaultPeopleType, batch.gatheringTypeId,
    batch.gatheringAutoRemoveEnabled, batch.scheduleEnabled, batch.scheduleFrequency, batch.scheduleDay,
    batch.legacyProviderBatchId, hasInitialDraft ? 2 : null,
    hasInitialDraft ? JSON.stringify(batch.initialDraftFilterConfig) : null,
    hasInitialDraft ? 1 : null, hasInitialDraft ? 1 : 0,
  ]);
  return getBatch(batch.churchId, batch.provider, result.insertId);
}

async function saveFilterDraft({ churchId, provider, batchId, schemaVersion, filterConfig }) {
  assertProvider(provider);
  if (schemaVersion !== 2) throw new Error('Draft filters must use schema version 2');
  assertBooleanFilterV2Envelope(filterConfig);
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_batches
    SET draft_filter_schema_version = ?, draft_filter_config = ?, draft_filter_base_revision = filter_revision,
      draft_filter_updated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?`, [
    schemaVersion, JSON.stringify(filterConfig), batchId, churchId, provider,
  ]);
  return result.affectedRows > 0 ? getBatch(churchId, provider, batchId) : null;
}

async function discardFilterDraft(churchId, provider, batchId) {
  assertProvider(provider);
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_batches
    SET draft_filter_schema_version = NULL, draft_filter_config = NULL, draft_filter_base_revision = NULL,
      draft_filter_updated_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?`, [batchId, churchId, provider]);
  return result.affectedRows > 0 ? getBatch(churchId, provider, batchId) : null;
}

async function promoteFilterDraftWithConnection(conn, {
  churchId, provider, batchId, expectedBaseRevision, expectedDraftDigest,
}) {
  assertProvider(provider);
  const row = conn.prepare(`SELECT * FROM people_sync_batches
    WHERE id = ? AND church_id = ? AND provider = ?`).get(batchId, churchId, provider);
  const draftConfig = parseDraftFilterConfig(row?.draft_filter_config);
  if (!row || draftConfig === null || row.filter_revision !== expectedBaseRevision ||
      row.draft_filter_base_revision !== expectedBaseRevision ||
      digestFilterConfig(draftConfig) !== expectedDraftDigest) {
    const error = new Error('Sync filter draft is stale');
    error.code = 'SYNC_FILTER_DRAFT_STALE';
    throw error;
  }
  const result = conn.prepare(`UPDATE people_sync_batches
    SET filter_schema_version = draft_filter_schema_version,
        filter_config = draft_filter_config,
        filter_revision = filter_revision + 1,
        draft_filter_schema_version = NULL,
        draft_filter_config = NULL,
        draft_filter_base_revision = NULL,
        draft_filter_updated_at = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ? AND filter_revision = ?`).run(
    batchId, churchId, provider, expectedBaseRevision
  );
  if (result.changes !== 1) {
    const error = new Error('Sync filter draft is stale');
    error.code = 'SYNC_FILTER_DRAFT_STALE';
    throw error;
  }
  return toBatch(conn.prepare(`SELECT * FROM people_sync_batches
    WHERE id = ? AND church_id = ? AND provider = ?`).get(batchId, churchId, provider));
}

// Used only after a reviewed, exact-compatible v1 upgrade has verified every
// selected batch in the surrounding church transaction.  Keeping the update
// connection-scoped makes a stale row roll the whole bulk operation back.
async function upgradeLegacyFilterWithConnection(conn, {
  churchId, provider, batchId, expectedRevision, convertedFilterConfig,
}) {
  assertProvider(provider);
  assertBooleanFilterV2Envelope(convertedFilterConfig);
  const result = await conn.query(`UPDATE people_sync_batches
    SET filter_schema_version = 2, filter_config = ?, filter_revision = filter_revision + 1,
        draft_filter_schema_version = NULL, draft_filter_config = NULL, draft_filter_base_revision = NULL,
        draft_filter_updated_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?
      AND filter_schema_version = 1 AND filter_revision = ?`, [
    JSON.stringify(convertedFilterConfig), batchId, churchId, provider, expectedRevision,
  ]);
  if (result.affectedRows !== 1) {
    const error = new Error('Sync filter upgrade is stale');
    error.code = 'SYNC_UPGRADE_STALE';
    throw error;
  }
}

async function updateBatch(input) {
  const { churchId, provider, batchId } = input || {};
  assertProvider(provider);
  const current = await getBatch(churchId, provider, batchId);
  if (!current) return null;
  const isActiveFilterChange = Object.hasOwn(input, 'filterSchemaVersion') || Object.hasOwn(input, 'filterConfig');
  if (isActiveFilterChange && (current.filterSchemaVersion === 2 || input.filterSchemaVersion === 2)) {
    assertSchema2ActiveFilterUsesDrafts();
  }
  const allowed = ['name', 'enabled', 'filterSchemaVersion', 'filterConfig', 'defaultPeopleType', 'gatheringTypeId',
    'gatheringAutoRemoveEnabled', 'scheduleEnabled', 'scheduleFrequency', 'scheduleDay', 'legacyProviderBatchId'];
  for (const key of Object.keys(input)) {
    if (!['churchId', 'provider', 'batchId', ...allowed].includes(key)) throw new Error(`Batch update field is not allowlisted: ${key}`);
  }
  const next = { ...current };
  for (const key of allowed) if (Object.hasOwn(input, key)) next[key] = input[key];
  const normalised = normaliseBatchInput({ churchId, provider, ...next });
  await Database.queryForChurch(churchId, `UPDATE people_sync_batches SET name = ?, enabled = ?,
    filter_schema_version = ?, filter_config = ?, default_people_type = ?, gathering_type_id = ?,
    gathering_auto_remove_enabled = ?, schedule_enabled = ?, schedule_frequency = ?, schedule_day = ?,
    legacy_provider_batch_id = ?, updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?`, [
    normalised.name, normalised.enabled, normalised.filterSchemaVersion, JSON.stringify(normalised.filterConfig),
    normalised.defaultPeopleType, normalised.gatheringTypeId, normalised.gatheringAutoRemoveEnabled,
    normalised.scheduleEnabled, normalised.scheduleFrequency, normalised.scheduleDay,
    normalised.legacyProviderBatchId, batchId, churchId, provider,
  ]);
  return getBatch(churchId, provider, batchId);
}

async function deleteBatch(churchId, provider, batchId) {
  assertProvider(provider);
  const result = await Database.queryForChurch(churchId,
    'DELETE FROM people_sync_batches WHERE id = ? AND church_id = ? AND provider = ?', [batchId, churchId, provider]);
  return result.affectedRows > 0;
}

async function recordBatchResult({ churchId, provider, batchId, trigger, fetchMode, complete, status, externalWatermark }) {
  assertProvider(provider);
  if (!RUN_STATUSES.has(status)) throw new Error('Invalid batch result status');
  const shouldAdvanceWatermark = complete === true && typeof externalWatermark === 'string' &&
    (status === 'applied' || (status === 'review_required' && trigger === 'scheduled'));
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_batches
    SET last_sync_at = datetime('now'), last_sync_result = ?,
      last_external_watermark = CASE WHEN ? THEN ? ELSE last_external_watermark END,
      updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?`, [
    status, shouldAdvanceWatermark ? 1 : 0, externalWatermark, batchId, churchId, provider,
  ]);
  return result.affectedRows > 0 ? getBatch(churchId, provider, batchId) : null;
}

module.exports = {
  listBatches, listEnabledBatches, getBatch, createBatch, updateBatch, deleteBatch, recordBatchResult,
  saveFilterDraft, discardFilterDraft, promoteFilterDraftWithConnection,
  upgradeLegacyFilterWithConnection,
};
