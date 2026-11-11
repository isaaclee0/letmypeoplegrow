'use strict';

// "Keep LMPG as it is" decisions for household and attendance-list
// differences. See people_sync_reconciliation_keeps in config/schema.js.
const Database = require('../../config/database');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const KINDS = new Set(['household', 'gathering_removal']);

function assertScope(churchId, provider) {
  if (typeof churchId !== 'string' || churchId.trim() === '') throw new Error('Church ID is required');
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported people sync provider: ${provider}`);
}

function assertKey({ kind, subjectKey }) {
  if (!KINDS.has(kind)) throw new Error(`Unsupported reconciliation keep kind: ${kind}`);
  if (typeof subjectKey !== 'string' || subjectKey.trim() === '') throw new Error('Reconciliation keep subject is required');
}

function rowToKeep(row) {
  return {
    id: Number(row.id),
    kind: row.kind,
    subjectKey: row.subject_key,
    fingerprint: row.fingerprint,
    keptAt: row.updated_at || row.created_at || null,
  };
}

async function listReconciliationKeeps(churchId, provider) {
  assertScope(churchId, provider);
  const rows = await Database.queryForChurch(churchId, `SELECT id, kind, subject_key, fingerprint, created_at, updated_at
    FROM people_sync_reconciliation_keeps
    WHERE church_id = ? AND provider = ?
    ORDER BY kind, subject_key`, [churchId, provider]);
  return rows.map(rowToKeep);
}

async function upsertKeepWithConnection(conn, { churchId, provider, kind, subjectKey, fingerprint, userId }) {
  assertScope(churchId, provider);
  assertKey({ kind, subjectKey });
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Reconciliation keep fingerprint is invalid');
  await conn.query(`INSERT INTO people_sync_reconciliation_keeps
    (church_id, provider, kind, subject_key, fingerprint, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(church_id, provider, kind, subject_key) DO UPDATE SET
      fingerprint = excluded.fingerprint,
      created_by = excluded.created_by,
      updated_at = datetime('now')`, [churchId, provider, kind, subjectKey, fingerprint, userId || null]);
}

async function deleteKeepBySubjectWithConnection(conn, { churchId, provider, kind, subjectKey }) {
  assertScope(churchId, provider);
  assertKey({ kind, subjectKey });
  const result = await conn.query(`DELETE FROM people_sync_reconciliation_keeps
    WHERE church_id = ? AND provider = ? AND kind = ? AND subject_key = ?`, [churchId, provider, kind, subjectKey]);
  return result.affectedRows > 0;
}

/** "Ask again": forget one keep so its difference returns on the next review. */
async function deleteKeep({ churchId, provider, keepId }) {
  assertScope(churchId, provider);
  if (!Number.isSafeInteger(keepId) || keepId <= 0) throw new Error('Reconciliation keep ID must be a positive integer');
  return Database.transactionForChurch(churchId, async (conn) => {
    const result = await conn.query(`DELETE FROM people_sync_reconciliation_keeps
      WHERE church_id = ? AND provider = ? AND id = ?`, [churchId, provider, keepId]);
    return result.affectedRows > 0;
  });
}

module.exports = {
  listReconciliationKeeps,
  upsertKeepWithConnection,
  deleteKeepBySubjectWithConnection,
  deleteKeep,
};
