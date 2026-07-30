const Database = require('../../config/database');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const HOLD_REASONS = new Set(['deferred', 'pair_rejected']);

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) {
    throw new Error(`Unsupported people sync provider: ${provider}`);
  }
}

function assertChurchId(churchId) {
  if (typeof churchId !== 'string' || churchId.trim() === '') {
    throw new Error('Church ID is required');
  }
}

function assertExternalPersonId(externalPersonId) {
  if (typeof externalPersonId !== 'string' || externalPersonId.trim() === '') {
    throw new Error('External person ID is required');
  }
}

function assertPositiveLocalId(value, label, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertHoldReason(reason) {
  if (!HOLD_REASONS.has(reason)) {
    throw new Error(`Unsupported match review hold reason: ${reason}`);
  }
}

function assertExclusionInput({ churchId, provider, externalPersonId, individualId, userId }) {
  assertChurchId(churchId);
  assertProvider(provider);
  assertExternalPersonId(externalPersonId);
  assertPositiveLocalId(individualId, 'Individual ID');
  assertPositiveLocalId(userId, 'User ID', { optional: true });
}

function assertHoldInput({ churchId, provider, externalPersonId, reason, userId }) {
  assertChurchId(churchId);
  assertProvider(provider);
  assertExternalPersonId(externalPersonId);
  assertHoldReason(reason);
  assertPositiveLocalId(userId, 'User ID', { optional: true });
}

function assertExclusionDeleteInput({ churchId, provider, externalPersonId, individualId }) {
  assertChurchId(churchId);
  assertProvider(provider);
  assertExternalPersonId(externalPersonId);
  assertPositiveLocalId(individualId, 'Individual ID');
}

function assertHoldDeleteInput({ churchId, provider, externalPersonId }) {
  assertChurchId(churchId);
  assertProvider(provider);
  assertExternalPersonId(externalPersonId);
}

async function listMatchReviewState(churchId, provider) {
  assertChurchId(churchId);
  assertProvider(provider);
  const [exclusions, holds] = await Promise.all([
    Database.queryForChurch(churchId, `SELECT external_person_id, individual_id
      FROM people_sync_match_exclusions
      WHERE church_id = ? AND provider = ?
      ORDER BY external_person_id, individual_id`, [churchId, provider]),
    Database.queryForChurch(churchId, `SELECT external_person_id, reason
      FROM people_sync_match_holds
      WHERE church_id = ? AND provider = ?
      ORDER BY external_person_id`, [churchId, provider]),
  ]);
  return {
    exclusions: exclusions.map((row) => ({
      externalPersonId: row.external_person_id,
      individualId: Number(row.individual_id),
    })),
    holds: holds.map((row) => ({
      externalPersonId: row.external_person_id,
      reason: row.reason,
    })),
  };
}

async function upsertExclusionWithConnection(conn, input) {
  assertExclusionInput(input);
  await conn.query(`INSERT INTO people_sync_match_exclusions
    (church_id, provider, external_person_id, individual_id, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(church_id, provider, external_person_id, individual_id) DO UPDATE SET
      created_by = excluded.created_by,
      updated_at = datetime('now')`, [
    input.churchId, input.provider, input.externalPersonId, input.individualId, input.userId || null,
  ]);
}

async function deleteExclusionWithConnection(conn, input) {
  assertExclusionDeleteInput(input);
  const result = await conn.query(`DELETE FROM people_sync_match_exclusions
    WHERE church_id = ? AND provider = ? AND external_person_id = ? AND individual_id = ?`, [
    input.churchId, input.provider, input.externalPersonId, input.individualId,
  ]);
  return result.affectedRows > 0;
}

async function upsertHoldWithConnection(conn, input) {
  assertHoldInput(input);
  await conn.query(`INSERT INTO people_sync_match_holds
    (church_id, provider, external_person_id, reason, created_by)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(church_id, provider, external_person_id) DO UPDATE SET
      reason = excluded.reason,
      created_by = excluded.created_by,
      updated_at = datetime('now')`, [
    input.churchId, input.provider, input.externalPersonId, input.reason, input.userId || null,
  ]);
}

async function deleteHoldWithConnection(conn, input) {
  assertHoldDeleteInput(input);
  const result = await conn.query(`DELETE FROM people_sync_match_holds
    WHERE church_id = ? AND provider = ? AND external_person_id = ?`, [
    input.churchId, input.provider, input.externalPersonId,
  ]);
  return result.affectedRows > 0;
}

async function upsertExclusion(input) {
  assertExclusionInput(input);
  return Database.transactionForChurch(input.churchId, (conn) => upsertExclusionWithConnection(conn, input));
}

async function deleteExclusion(input) {
  assertExclusionDeleteInput(input);
  return Database.transactionForChurch(input.churchId, (conn) => deleteExclusionWithConnection(conn, input));
}

async function upsertHold(input) {
  assertHoldInput(input);
  return Database.transactionForChurch(input.churchId, (conn) => upsertHoldWithConnection(conn, input));
}

async function deleteHold(input) {
  assertHoldDeleteInput(input);
  return Database.transactionForChurch(input.churchId, (conn) => deleteHoldWithConnection(conn, input));
}

module.exports = {
  listMatchReviewState,
  upsertExclusionWithConnection,
  deleteExclusionWithConnection,
  upsertHoldWithConnection,
  deleteHoldWithConnection,
  upsertExclusion,
  deleteExclusion,
  upsertHold,
  deleteHold,
};
