'use strict';

const linkRepository = require('./linkRepository');
const authority = require('./authority');
const reconciliationKeepRepository = require('./reconciliationKeepRepository');
const { reconciliationKeepFor } = require('./reconciliation');

function stale(message) {
  const error = new Error(`${message} Refresh the signed review before applying.`);
  error.code = 'SYNC_PLAN_STALE';
  error.status = 409;
  return error;
}

function selectedFamilyResolutions(plan, accepted) {
  return (plan.familyConflicts || []).filter((action) => accepted.acceptedFamilyResolutionIds.has(action.id));
}

async function assertReconciliationAuthority(conn, { churchId, provider, plan, accepted, reviewedApply, activateAuthority }) {
  if (!accepted.acceptedFamilyResolutionIds.size && !accepted.acceptedGatheringRemovalIds.size) return;
  if (!reviewedApply || !plan.authoritative || plan.snapshot?.mode !== 'full' || plan.operationKind === 'people_import') {
    throw stale('Reconciliation requires an authoritative, complete signed review.');
  }
  const state = await authority.getAuthorityWithConnection(conn, churchId);
  if (state.active !== provider && !(activateAuthority && state.pending === provider)) {
    throw stale('The people-sync authority changed.');
  }
}

async function applyReviewedFamilies(conn, { churchId, provider, plan, accepted, userId, result, markLinksSeen }) {
  const actions = selectedFamilyResolutions(plan, accepted);
  const claimed = new Set();
  // Check all participants before any move; selected proposals cannot overlap.
  for (const action of actions) {
    const { resolution } = action;
    if (!Array.isArray(resolution.moves) || !resolution.moves.length ||
        !['household', 'detach', 'single_person'].includes(resolution.kind) ||
        (resolution.kind === 'detach' && (action.externalFamilyId !== null || resolution.destination?.kind !== 'none')) ||
        (resolution.kind === 'single_person' && (provider !== 'planning_center' || action.externalFamilyId !== null ||
          resolution.destination?.kind !== 'create' || resolution.moves.length !== 1)) ||
        (resolution.kind === 'household' && (!action.externalFamilyId || !['create', 'existing'].includes(resolution.destination?.kind)))) {
      throw stale('The household proposal is invalid.');
    }
    for (const move of resolution.moves) {
      if (claimed.has(move.individualId) || accepted.acceptedArchiveIndividualIds.has(move.individualId)) {
        throw stale('Household selections conflict with another selected action.');
      }
      claimed.add(move.individualId);
      const rows = await conn.query(
        `SELECT i.family_id FROM individuals i
          JOIN external_person_links l ON l.church_id = i.church_id AND l.individual_id = i.id
         WHERE i.church_id = ? AND i.id = ? AND l.provider = ? AND l.external_person_id = ?`,
        [churchId, move.individualId, provider, move.externalPersonId]
      );
      if (rows.length !== 1 || (rows[0].family_id ?? null) !== move.fromFamilyId) {
        throw stale('A household member or their provider link changed.');
      }
    }
    if (resolution.kind === 'household') {
      const linked = await conn.query(
        `SELECT family_id FROM external_family_links WHERE church_id = ? AND provider = ? AND external_family_id = ?`,
        [churchId, provider, action.externalFamilyId]
      );
      const destination = resolution.destination;
      if (destination.kind === 'create' && linked.length) throw stale('The provider household already has a local family link.');
      if (destination.kind === 'existing') {
        const families = await conn.query(`SELECT planning_center_id FROM families WHERE church_id = ? AND id = ?`, [churchId, destination.familyId]);
        const owners = await conn.query(`SELECT external_family_id FROM external_family_links WHERE church_id = ? AND provider = ? AND family_id = ?`, [churchId, provider, destination.familyId]);
        if (families.length !== 1 || linked.some((row) => row.family_id !== destination.familyId) ||
            owners.some((row) => row.external_family_id !== action.externalFamilyId) ||
            (provider === 'planning_center' && families[0].planning_center_id && families[0].planning_center_id !== action.externalFamilyId)) {
          throw stale('The destination family or its provider ownership changed.');
        }
      }
    }
  }

  for (const action of actions) {
    const { resolution } = action;
    let familyId = null;
    if (resolution.destination.kind === 'existing') familyId = resolution.destination.familyId;
    else if (resolution.destination.kind === 'create') {
      const familyName = typeof resolution.destination.familyName === 'string' ? resolution.destination.familyName.trim() : '';
      if (!familyName) throw stale('The new household is missing its reviewed family name.');
      const inserted = await conn.query(`INSERT INTO families (church_id, family_name, created_by) VALUES (?, ?, ?)`, [churchId, familyName, userId || null]);
      familyId = inserted.insertId;
      result.addFamilies++;
    }
    if (resolution.kind === 'household') {
      await linkRepository.upsertFamilyLinkWithConnection(conn, {
        churchId, provider, externalFamilyId: action.externalFamilyId, familyId,
        linkSource: 'manual', markSeen: markLinksSeen,
      });
      if (provider === 'planning_center') await conn.query(
        `UPDATE families SET planning_center_id = ?, updated_at = datetime('now') WHERE church_id = ? AND id = ?`,
        [action.externalFamilyId, churchId, familyId]
      );
      result.linkFamilies++;
    }
    for (const move of resolution.moves) {
      const updated = await conn.query(
        `UPDATE individuals SET family_id = ?, updated_at = datetime('now')
          WHERE church_id = ? AND id = ? AND family_id IS ?`,
        [familyId, churchId, move.individualId, move.fromFamilyId]
      );
      if (updated.affectedRows !== 1) throw stale('A household member changed.');
      result.moveFamily++;
    }
    result.familyConflicts++;
  }
}

async function removeReviewedLegacyMembership(conn, { churchId, provider, action }) {
  const links = await conn.query(
    `SELECT individual_id FROM external_person_links WHERE church_id = ? AND provider = ? AND external_person_id = ?`,
    [churchId, provider, action.externalPersonId]
  );
  if (links.length !== 1 || links[0].individual_id !== action.individualId) throw stale('The attendance-list member identity changed.');
  const sources = await conn.query(
    `SELECT id, enabled, provider FROM people_sync_batches WHERE church_id = ? AND gathering_type_id = ? ORDER BY id`,
    [churchId, action.gatheringTypeId]
  );
  if (!sources.length || sources.some((source) => !source.enabled || source.provider !== provider) ||
      JSON.stringify(sources.map(({ id }) => id)) !== JSON.stringify(action.sourceBatchIds)) {
    throw stale('The attendance-list sync sources changed.');
  }
  const deleted = await conn.query(
    `DELETE FROM gathering_lists WHERE church_id = ? AND gathering_type_id = ? AND individual_id = ?
       AND added_by_sync_batch_id IS NULL AND added_by_pco_batch_id IS NULL`,
    [churchId, action.gatheringTypeId, action.individualId]
  );
  if (deleted.affectedRows !== 1) throw stale('The attendance-list membership or its ownership changed.');
  return deleted;
}

// Remember "keep LMPG as it is" choices, and forget any older keep on a
// subject the reviewer has now accepted. Keys come from the signed plan
// actions, never from client-supplied facts.
async function persistReconciliationKeeps(conn, { churchId, provider, plan, accepted, reviewedApply, userId }) {
  const kept = accepted.keptReconciliationIds || new Set();
  const acceptedIds = [...(accepted.acceptedFamilyResolutionIds || []), ...(accepted.acceptedGatheringRemovalIds || [])];
  if (!kept.size && !acceptedIds.length) return;
  if (kept.size && (!reviewedApply || !plan.authoritative || plan.operationKind === 'people_import')) {
    throw stale('Keeping a difference requires an authoritative, signed review.');
  }
  const byId = new Map([
    ...(plan.familyConflicts || []).map((action) => [action.id, ['familyConflicts', action]]),
    ...(plan.removeFromGathering || []).map((action) => [action.id, ['removeFromGathering', action]]),
  ]);
  for (const id of kept) {
    const [bucket, action] = byId.get(id) || [];
    const key = action ? reconciliationKeepFor(bucket, action) : null;
    if (!key) throw stale('A kept difference is no longer part of this review.');
    await reconciliationKeepRepository.upsertKeepWithConnection(conn, { churchId, provider, ...key, userId });
  }
  for (const id of acceptedIds) {
    const [bucket, action] = byId.get(id) || [];
    const key = action ? reconciliationKeepFor(bucket, action) : null;
    if (key) {
      await reconciliationKeepRepository.deleteKeepBySubjectWithConnection(conn, {
        churchId, provider, kind: key.kind, subjectKey: key.subjectKey,
      });
    }
  }
}

module.exports = { assertReconciliationAuthority, applyReviewedFamilies, removeReviewedLegacyMembership, persistReconciliationKeeps };
