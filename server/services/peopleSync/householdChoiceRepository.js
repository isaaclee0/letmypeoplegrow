'use strict';

const Database = require('../../config/database');
const { canonicalPreferences } = require('./householdChoices');

function assertScope(churchId, provider) {
  if (typeof churchId !== 'string' || !churchId.trim()) throw new Error('Church ID is required');
  if (!['planning_center', 'elvanto'].includes(provider)) throw new Error('Unsupported people-sync provider');
}

function stale() {
  const error = new Error('Remembered household choices or their person links changed. Refresh the review.');
  error.code = 'SYNC_PLAN_STALE';
  error.status = 409;
  return error;
}

function fromRows(rows) {
  return canonicalPreferences(rows.map((row) => ({
    externalPersonId: row.external_person_id, individualId: row.individual_id,
    familyId: row.family_id, groupId: row.group_id, sourceFingerprint: row.source_fingerprint,
  })));
}

const SELECT_PREFERENCES = `SELECT external_person_id, individual_id, family_id, group_id, source_fingerprint
  FROM people_sync_local_households WHERE church_id = ? AND provider = ? ORDER BY external_person_id`;

async function listHouseholdPreferences(churchId, provider) {
  assertScope(churchId, provider);
  return fromRows(await Database.queryForChurch(churchId, SELECT_PREFERENCES, [churchId, provider]));
}

async function assertHouseholdPreferencesWithConnection(conn, { churchId, provider, expectedPreferences }) {
  assertScope(churchId, provider);
  if (!Array.isArray(expectedPreferences)) throw new Error('Expected household preferences are required');
  const current = fromRows(await conn.query(SELECT_PREFERENCES, [churchId, provider]));
  if (JSON.stringify(current) !== JSON.stringify(canonicalPreferences(expectedPreferences))) throw stale();
}

/** The caller owns the surrounding transaction and source/plan validation. */
async function persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes, createdBy = null }) {
  assertScope(churchId, provider);
  if (!Array.isArray(changes)) throw new Error('Household preference changes must be an array');
  const seen = new Set();
  for (const change of changes) {
    if (!change || typeof change.externalPersonId !== 'string' || !change.externalPersonId.trim() ||
        !Number.isSafeInteger(change.individualId) || change.individualId <= 0 ||
        typeof change.groupId !== 'string' || !change.groupId.trim() || change.groupId.length > 200 ||
        (change.sourceFingerprint != null && !/^[a-f0-9]{64}$/.test(change.sourceFingerprint)) ||
        (!change.forget && change.familyId !== null && (!Number.isSafeInteger(change.familyId) || change.familyId <= 0)) ||
        seen.has(change.externalPersonId)) throw new Error('Invalid local household preference change');
    seen.add(change.externalPersonId);
    if (change.forget) continue;
    const links = await conn.query(`SELECT l.individual_id, i.family_id FROM external_person_links l
      JOIN individuals i ON i.id = l.individual_id AND i.church_id = l.church_id
      WHERE l.church_id = ? AND l.provider = ? AND l.external_person_id = ?`, [churchId, provider, change.externalPersonId]);
    if (links.length !== 1 || Number(links[0].individual_id) !== change.individualId ||
        (links[0].family_id ?? null) !== change.familyId) throw stale();
    if (change.familyId !== null) {
      const families = await conn.query('SELECT id FROM families WHERE church_id = ? AND id = ?', [churchId, change.familyId]);
      if (families.length !== 1) throw stale();
    }
  }
  for (const change of changes) {
    if (change.forget) {
      await conn.query(`DELETE FROM people_sync_local_households
        WHERE church_id = ? AND provider = ? AND external_person_id = ? AND individual_id = ?`, [churchId, provider, change.externalPersonId, change.individualId]);
    } else {
      await conn.query(`INSERT INTO people_sync_local_households
        (church_id, provider, external_person_id, individual_id, family_id, group_id, source_fingerprint, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(church_id, provider, external_person_id) DO UPDATE SET
          individual_id = excluded.individual_id, family_id = excluded.family_id,
          group_id = excluded.group_id, source_fingerprint = excluded.source_fingerprint,
          created_by = excluded.created_by, updated_at = datetime('now')`,
      [churchId, provider, change.externalPersonId, change.individualId, change.familyId, change.groupId, change.sourceFingerprint || null, createdBy]);
    }
  }
}

module.exports = { listHouseholdPreferences, assertHouseholdPreferencesWithConnection, persistHouseholdPreferencesWithConnection };
