const Database = require('../../config/database');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const TRIGGERS = new Set(['onboarding', 'manual', 'run_now', 'scheduled', 'authority_switch', 'full_reconciliation']);
const FETCH_MODES = new Set(['full', 'incremental']);
const FINISHED_STATUSES = new Set(['review_required', 'applied', 'cancelled']);
const COUNT_KEYS = new Set([
  'linkPeople', 'linkFamilies', 'addPeople', 'addFamilies', 'updateManagedFields', 'promoteToRegular',
  'demoteToLocalVisitor', 'archive', 'reactivate', 'moveFamily', 'renameFamily', 'addToGathering',
  'removeFromGathering', 'ambiguousPeople', 'familyConflicts', 'unmatchedLocalRegulars', 'skipped',
  'familyNamesUpdated', 'gatheringAssigned', 'gatheringRemoved',
]);
const CREDENTIAL_KEYS = new Set(['apikey', 'accesstoken', 'refreshtoken', 'credential', 'authorization', 'password', 'secret', 'token']);

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported people-sync provider: ${provider}`);
}

function assertNoCredentialShape(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialShape(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (CREDENTIAL_KEYS.has(key.replace(/[_-]/g, '').toLowerCase()) || /payload/i.test(key)) {
      throw new Error(`Audit input cannot contain credential or raw payload key "${key}"`);
    }
    assertNoCredentialShape(nested);
  }
}

function assertAllowlistedInput(input, allowed, label) {
  assertNoCredentialShape(input);
  for (const key of Object.keys(input || {})) {
    if (!allowed.has(key)) throw new Error(`${label} input field is not allowlisted: ${key}`);
  }
}

function sanitiseCounts(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Run counts must be an object');
  assertNoCredentialShape(counts);
  const safe = {};
  for (const [key, value] of Object.entries(counts)) {
    if (!COUNT_KEYS.has(key)) throw new Error(`Run count is not allowlisted: ${key}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Run count must be a non-negative integer: ${key}`);
    safe[key] = value;
  }
  return safe;
}

function parseCounts(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? sanitiseCounts(parsed) : {};
  } catch (_) {
    return {};
  }
}

function toRun(row) {
  if (!row) return null;
  return {
    id: row.id, provider: row.provider, batchId: row.batch_id, trigger: row.trigger, fetchMode: row.fetch_mode,
    status: row.status, counts: parseCounts(row.counts), reviewNotificationFingerprint: row.review_notification_fingerprint,
    errorCode: row.error_code, errorMessage: row.error_message, externalWatermark: row.external_watermark,
    startedAt: row.started_at, completedAt: row.completed_at,
  };
}

async function getRunForChurch(runId, churchId) {
  const rows = await Database.queryForChurch(churchId,
    'SELECT * FROM people_sync_runs WHERE id = ? AND church_id = ?', [runId, churchId]);
  return rows[0] || null;
}

async function startRun(input) {
  const allowed = new Set(['churchId', 'provider', 'batchId', 'trigger', 'fetchMode']);
  assertAllowlistedInput(input, allowed, 'Run start');
  const { churchId, provider, batchId = null, trigger, fetchMode } = input;
  assertProvider(provider);
  if (!churchId || !TRIGGERS.has(trigger) || !FETCH_MODES.has(fetchMode)) throw new Error('Invalid run start input');
  if (batchId !== null) {
    const batches = await Database.queryForChurch(churchId,
      'SELECT id FROM people_sync_batches WHERE id = ? AND church_id = ? AND provider = ?', [batchId, churchId, provider]);
    if (!batches[0]) throw new Error('Run batch is not available for this church and provider');
  }
  const result = await Database.queryForChurch(churchId, `INSERT INTO people_sync_runs
    (church_id, provider, batch_id, trigger, fetch_mode, status) VALUES (?, ?, ?, ?, ?, 'running')`,
  [churchId, provider, batchId, trigger, fetchMode]);
  return toRun(await getRunForChurch(result.insertId, churchId));
}

async function finishRun(input) {
  const allowed = new Set(['churchId', 'runId', 'status', 'counts', 'externalWatermark']);
  assertAllowlistedInput(input, allowed, 'Run finish');
  const { churchId, runId, status, counts, externalWatermark = null } = input;
  if (!FINISHED_STATUSES.has(status)) throw new Error('Invalid completed run status');
  const safeCounts = sanitiseCounts(counts);
  const existing = await getRunForChurch(runId, churchId);
  if (!existing) return null;
  await Database.queryForChurch(churchId, `UPDATE people_sync_runs SET status = ?, counts = ?, external_watermark = ?,
      completed_at = datetime('now') WHERE id = ? AND church_id = ? AND provider = ?`,
  [status, JSON.stringify(safeCounts), externalWatermark, runId, churchId, existing.provider]);
  return toRun(await getRunForChurch(runId, churchId));
}

async function failRun(input) {
  const allowed = new Set(['churchId', 'runId', 'errorCode', 'errorMessage']);
  assertAllowlistedInput(input, allowed, 'Run failure');
  const { churchId, runId, errorCode = null, errorMessage = null } = input;
  if (errorCode !== null && typeof errorCode !== 'string') throw new Error('Run error code must be a string');
  if (errorMessage !== null && typeof errorMessage !== 'string') throw new Error('Run error message must be a string');
  const existing = await getRunForChurch(runId, churchId);
  if (!existing) return null;
  await Database.queryForChurch(churchId, `UPDATE people_sync_runs SET status = 'failed', error_code = ?, error_message = ?,
      completed_at = datetime('now') WHERE id = ? AND church_id = ? AND provider = ?`,
  [errorCode, errorMessage, runId, churchId, existing.provider]);
  return toRun(await getRunForChurch(runId, churchId));
}

async function setReviewNotificationFingerprint(runId, churchId, fingerprint) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error('Review notification fingerprint must be a lowercase SHA-256 digest');
  }
  const existing = await getRunForChurch(runId, churchId);
  if (!existing) return false;
  const result = await Database.queryForChurch(churchId, `UPDATE people_sync_runs
    SET review_notification_fingerprint = ? WHERE id = ? AND church_id = ? AND provider = ?`,
  [fingerprint, runId, churchId, existing.provider]);
  return result.affectedRows > 0;
}

async function findLatestReviewNotificationFingerprint(churchId, provider) {
  assertProvider(provider);
  const rows = await Database.queryForChurch(churchId, `SELECT review_notification_fingerprint
    FROM people_sync_runs WHERE church_id = ? AND provider = ? AND review_notification_fingerprint IS NOT NULL
    ORDER BY id DESC LIMIT 1`, [churchId, provider]);
  return rows[0] ? rows[0].review_notification_fingerprint : null;
}

async function listRecentRuns(churchId, provider, limit = 20) {
  assertProvider(provider);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid recent-runs limit');
  const rows = await Database.queryForChurch(churchId, `SELECT * FROM people_sync_runs
    WHERE church_id = ? AND provider = ? ORDER BY id DESC LIMIT ?`, [churchId, provider, limit]);
  return rows.map(toRun);
}

module.exports = {
  startRun,
  finishRun,
  failRun,
  setReviewNotificationFingerprint,
  findLatestReviewNotificationFingerprint,
  listRecentRuns,
  COUNT_KEYS,
};
