const Database = require('../../config/database');
const { assertSourceForProvider, normalizeProviderSource, digestSourceIdentity } = require('./sourceModel');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const PEOPLE_TYPES = new Set(['regular', 'local_visitor', 'traveller_visitor']);
const RUN_STATUSES = new Set(['review_required', 'applied', 'failed', 'cancelled']);

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported people-sync provider: ${provider}`);
}

function sourceFromColumns(row, prefix = '') {
  const externalId = row[`${prefix}source_external_id`];
  return externalId ? {
    kind: row[`${prefix}source_kind`],
    externalId,
    name: row[`${prefix}source_name`],
  } : null;
}

function toBatch(row) {
  if (!row) return null;
  const source = sourceFromColumns(row);
  const draftSource = sourceFromColumns(row, 'draft_');
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: Boolean(row.enabled),
    source,
    sourceRevision: Number(row.source_revision),
    draftSource,
    draftSourceBaseRevision: row.draft_source_base_revision === null ? null : Number(row.draft_source_base_revision),
    draftSourceUpdatedAt: row.draft_source_updated_at,
    needsSourceReview: row.draft_source_external_id !== null,
    initialSourceReviewPending: row.source_external_id === null,
    sourceStatus: row.source_status,
    sourceStatusCheckedAt: row.source_status_checked_at,
    sourceStatusErrorCode: row.source_status_error_code,
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
    churchId, provider, name, enabled = true, defaultPeopleType = 'regular', gatheringTypeId = null,
    gatheringAutoRemoveEnabled = false, scheduleEnabled = false, scheduleFrequency = 'weekly', scheduleDay = 1,
    legacyProviderBatchId = null, initialDraftSource,
  } = input || {};
  assertProvider(provider);
  if (!churchId || typeof name !== 'string' || !name.trim()) throw new Error('A batch name is required');
  if (!PEOPLE_TYPES.has(defaultPeopleType)) throw new Error('Invalid default people type');
  if (initialDraftSource !== undefined) assertSourceForProvider(provider, initialDraftSource);
  return {
    churchId, provider, name: name.trim(), enabled: Boolean(enabled), defaultPeopleType, gatheringTypeId,
    gatheringAutoRemoveEnabled: Boolean(gatheringAutoRemoveEnabled), scheduleEnabled: Boolean(scheduleEnabled),
    scheduleFrequency, scheduleDay, legacyProviderBatchId,
    initialDraftSource: initialDraftSource === undefined ? undefined : normalizeProviderSource(provider, initialDraftSource),
  };
}

async function createBatch(input) {
  const batch = normaliseBatchInput(input);
  const draft = batch.initialDraftSource;
  const result = await Database.queryForChurch(batch.churchId, `INSERT INTO people_sync_batches
    (church_id, provider, name, enabled, default_people_type, gathering_type_id, gathering_auto_remove_enabled,
     schedule_enabled, schedule_frequency, schedule_day, legacy_provider_batch_id, draft_source_kind,
     draft_source_external_id, draft_source_name, draft_source_base_revision, draft_source_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END)`, [
    batch.churchId, batch.provider, batch.name, batch.enabled, batch.defaultPeopleType, batch.gatheringTypeId,
    batch.gatheringAutoRemoveEnabled, batch.scheduleEnabled, batch.scheduleFrequency, batch.scheduleDay,
    batch.legacyProviderBatchId, draft?.kind ?? null, draft?.externalId ?? null, draft?.name ?? null,
    draft ? 1 : null, draft ? 1 : 0,
  ]);
  return getBatch(batch.churchId, batch.provider, result.insertId);
}

async function saveSourceDraft({ churchId, provider, batchId, source }) {
  assertProvider(provider);
  const normalized = normalizeProviderSource(provider, source);
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_batches
    SET draft_source_kind = ?, draft_source_external_id = ?, draft_source_name = ?,
      draft_source_base_revision = source_revision, draft_source_updated_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?`, [
    normalized.kind, normalized.externalId, normalized.name, batchId, churchId, provider,
  ]);
  return result.affectedRows > 0 ? getBatch(churchId, provider, batchId) : null;
}

async function discardSourceDraft(churchId, provider, batchId) {
  assertProvider(provider);
  const current = await getBatch(churchId, provider, batchId);
  if (current?.initialSourceReviewPending) {
    const error = new Error('The initial source must be reviewed before this batch can run.');
    error.code = 'SYNC_SOURCE_INITIAL_REVIEW_REQUIRED';
    throw error;
  }
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_batches
    SET draft_source_kind = NULL, draft_source_external_id = NULL, draft_source_name = NULL,
      draft_source_base_revision = NULL, draft_source_updated_at = NULL, updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?`, [batchId, churchId, provider]);
  return result.affectedRows > 0 ? getBatch(churchId, provider, batchId) : null;
}

async function promoteSourceDraftWithConnection(conn, {
  churchId, provider, batchId, expectedBaseRevision, expectedDraftDigest,
}) {
  assertProvider(provider);
  const readOne = async (sql, params) => typeof conn.query === 'function'
    ? (await conn.query(sql, params))[0]
    : conn.prepare(sql).get(...params);
  const write = async (sql, params) => typeof conn.query === 'function'
    ? await conn.query(sql, params)
    : conn.prepare(sql).run(...params);
  const row = await readOne(`SELECT * FROM people_sync_batches
    WHERE id = ? AND church_id = ? AND provider = ?`, [batchId, churchId, provider]);
  const draft = row ? sourceFromColumns(row, 'draft_') : null;
  if (!row || !draft || row.source_revision !== expectedBaseRevision ||
      row.draft_source_base_revision !== expectedBaseRevision ||
      digestSourceIdentity(draft) !== expectedDraftDigest) {
    const error = new Error('Sync source draft is stale');
    error.code = 'SYNC_SOURCE_DRAFT_STALE';
    throw error;
  }
  const result = await write(`UPDATE people_sync_batches
    SET source_kind = draft_source_kind, source_external_id = draft_source_external_id, source_name = draft_source_name,
        source_revision = source_revision + 1, draft_source_kind = NULL, draft_source_external_id = NULL,
        draft_source_name = NULL, draft_source_base_revision = NULL, draft_source_updated_at = NULL,
        source_status = 'unknown', source_status_checked_at = NULL, source_status_error_code = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ? AND source_revision = ? AND draft_source_base_revision = ?
      AND draft_source_kind = ? AND draft_source_external_id = ?`, [
    batchId, churchId, provider, expectedBaseRevision, expectedBaseRevision, draft.kind, draft.externalId,
  ]);
  if ((result.affectedRows ?? result.changes) !== 1) {
    const error = new Error('Sync source draft is stale');
    error.code = 'SYNC_SOURCE_DRAFT_STALE';
    throw error;
  }
  return toBatch(await readOne(`SELECT * FROM people_sync_batches
    WHERE id = ? AND church_id = ? AND provider = ?`, [batchId, churchId, provider]));
}

async function updateBatch(input) {
  const { churchId, provider, batchId } = input || {};
  assertProvider(provider);
  const current = await getBatch(churchId, provider, batchId);
  if (!current) return null;
  const allowed = ['name', 'enabled', 'defaultPeopleType', 'gatheringTypeId', 'gatheringAutoRemoveEnabled',
    'scheduleEnabled', 'scheduleFrequency', 'scheduleDay', 'legacyProviderBatchId'];
  for (const key of Object.keys(input)) {
    if (!['churchId', 'provider', 'batchId', ...allowed].includes(key)) throw new Error(`Batch update field is not allowlisted: ${key}`);
  }
  const next = { ...current };
  for (const key of allowed) if (Object.hasOwn(input, key)) next[key] = input[key];
  const batch = normaliseBatchInput({ churchId, provider, ...next });
  await Database.queryForChurch(churchId, `UPDATE people_sync_batches SET name = ?, enabled = ?,
    default_people_type = ?, gathering_type_id = ?, gathering_auto_remove_enabled = ?, schedule_enabled = ?,
    schedule_frequency = ?, schedule_day = ?, legacy_provider_batch_id = ?, updated_at = datetime('now')
    WHERE id = ? AND church_id = ? AND provider = ?`, [
    batch.name, batch.enabled, batch.defaultPeopleType, batch.gatheringTypeId, batch.gatheringAutoRemoveEnabled,
    batch.scheduleEnabled, batch.scheduleFrequency, batch.scheduleDay, batch.legacyProviderBatchId,
    batchId, churchId, provider,
  ]);
  return getBatch(churchId, provider, batchId);
}

async function deleteBatch(churchId, provider, batchId) {
  assertProvider(provider);
  const result = await Database.queryForChurch(churchId,
    'DELETE FROM people_sync_batches WHERE id = ? AND church_id = ? AND provider = ?', [batchId, churchId, provider]);
  return result.affectedRows > 0;
}

async function recordActiveSourceHealthWithConnection(conn, {
  churchId, provider, batchId, expectedSource, sourceName, sourceStatus, checkedAt, errorCode,
}) {
  assertProvider(provider);
  if (!expectedSource || !expectedSource.kind || !expectedSource.externalId ||
      !['available', 'missing', 'error'].includes(sourceStatus)) {
    throw new Error('Invalid active source health update');
  }
  const readOne = async (sql, params) => typeof conn.query === 'function'
    ? (await conn.query(sql, params))[0]
    : conn.prepare(sql).get(...params);
  const write = async (sql, params) => typeof conn.query === 'function'
    ? await conn.query(sql, params)
    : conn.prepare(sql).run(...params);
  const row = await readOne(`SELECT id, name, source_kind, source_external_id, source_name, source_status
    FROM people_sync_batches WHERE id = ? AND church_id = ? AND provider = ?`, [batchId, churchId, provider]);
  if (!row || row.source_kind !== expectedSource.kind || row.source_external_id !== expectedSource.externalId) {
    return { updated: false, priorSourceStatus: null, batchName: null, sourceName: null };
  }

  const nextSourceName = sourceName ?? row.source_name;
  const result = await write(`UPDATE people_sync_batches
    SET source_name = ?, source_status = ?, source_status_checked_at = ?, source_status_error_code = ?
    WHERE id = ? AND church_id = ? AND provider = ? AND source_kind = ? AND source_external_id = ?`, [
    nextSourceName, sourceStatus, checkedAt, errorCode,
    batchId, churchId, provider, expectedSource.kind, expectedSource.externalId,
  ]);
  if ((result.affectedRows ?? result.changes) !== 1) {
    return { updated: false, priorSourceStatus: null, batchName: null, sourceName: null };
  }
  return {
    updated: true,
    priorSourceStatus: row.source_status,
    batchName: row.name,
    sourceName: nextSourceName,
  };
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
  saveSourceDraft, discardSourceDraft, promoteSourceDraftWithConnection, recordActiveSourceHealthWithConnection,
};
