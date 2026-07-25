const Database = require('../../config/database');

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

function toBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: Boolean(row.enabled),
    filterSchemaVersion: Number(row.filter_schema_version),
    filterConfig: parseFilterConfig(row.filter_config),
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

function normaliseBatchInput(input) {
  const {
    churchId, provider, name, enabled = true, filterSchemaVersion = 1, filterConfig = {},
    defaultPeopleType = 'regular', gatheringTypeId = null, gatheringAutoRemoveEnabled = false,
    scheduleEnabled = false, scheduleFrequency = 'weekly', scheduleDay = 1, legacyProviderBatchId = null,
  } = input || {};
  assertProvider(provider);
  if (!churchId || typeof name !== 'string' || !name.trim()) throw new Error('A batch name is required');
  if (!Number.isInteger(filterSchemaVersion) || filterSchemaVersion < 1) throw new Error('Invalid filter schema version');
  if (!filterConfig || typeof filterConfig !== 'object' || Array.isArray(filterConfig)) throw new Error('Filter config must be an object');
  if (!PEOPLE_TYPES.has(defaultPeopleType)) throw new Error('Invalid default people type');
  return {
    churchId, provider, name: name.trim(), enabled: Boolean(enabled), filterSchemaVersion, filterConfig,
    defaultPeopleType, gatheringTypeId, gatheringAutoRemoveEnabled: Boolean(gatheringAutoRemoveEnabled),
    scheduleEnabled: Boolean(scheduleEnabled), scheduleFrequency, scheduleDay, legacyProviderBatchId,
  };
}

async function createBatch(input) {
  const batch = normaliseBatchInput(input);
  const result = await Database.queryForChurch(batch.churchId, `INSERT INTO people_sync_batches
    (church_id, provider, name, enabled, filter_schema_version, filter_config, default_people_type,
     gathering_type_id, gathering_auto_remove_enabled, schedule_enabled, schedule_frequency, schedule_day,
     legacy_provider_batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    batch.churchId, batch.provider, batch.name, batch.enabled, batch.filterSchemaVersion,
    JSON.stringify(batch.filterConfig), batch.defaultPeopleType, batch.gatheringTypeId,
    batch.gatheringAutoRemoveEnabled, batch.scheduleEnabled, batch.scheduleFrequency, batch.scheduleDay,
    batch.legacyProviderBatchId,
  ]);
  return getBatch(batch.churchId, batch.provider, result.insertId);
}

async function updateBatch(input) {
  const { churchId, provider, batchId } = input || {};
  assertProvider(provider);
  const current = await getBatch(churchId, provider, batchId);
  if (!current) return null;
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
  const successfulScheduledComplete = trigger === 'scheduled' && complete === true &&
    (status === 'applied' || status === 'review_required') && typeof externalWatermark === 'string';
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_batches
    SET last_sync_at = datetime('now'), last_sync_result = ?,
      last_external_watermark = CASE WHEN ? THEN ? ELSE last_external_watermark END,
      updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?`, [
    status, successfulScheduledComplete ? 1 : 0, externalWatermark, batchId, churchId, provider,
  ]);
  return result.affectedRows > 0 ? getBatch(churchId, provider, batchId) : null;
}

module.exports = { listBatches, getBatch, createBatch, updateBatch, deleteBatch, recordBatchResult };
