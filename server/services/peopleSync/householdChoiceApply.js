'use strict';

const authority = require('./authority');
const repository = require('./householdChoiceRepository');
const { canonicalHouseholdChoices } = require('./householdChoices');

function invalid(message, code = 'SYNC_PLAN_STALE') {
  return Object.assign(new Error(`${message} Refresh the review before applying.`), { code, status: code === 'SYNC_SELECTIONS_INVALID' ? 400 : 409 });
}

function validateHouseholdChoiceSelections(plan, selections = {}) {
  const submitted = canonicalHouseholdChoices(selections.householdChoices === undefined ? {} : selections.householdChoices);
  const signed = canonicalHouseholdChoices(plan.householdChoices?.edits || {});
  if (JSON.stringify(submitted) !== JSON.stringify(signed)) {
    throw invalid('Local household choices must match the signed preview.', 'SYNC_SELECTIONS_INVALID');
  }
  if (Object.keys(submitted).length && (plan.provider !== 'planning_center' || plan.householdChoices?.version !== 2 ||
      !plan.authoritative || plan.operationKind === 'people_import')) {
    throw invalid('Local household choices require an authoritative Planning Center review.', 'SYNC_SELECTIONS_INVALID');
  }
  return submitted;
}

async function assertHouseholdChoicesWithConnection(conn, { churchId, provider, plan, selections, reviewedApply, allowedMutationBuckets, accepted }) {
  const edits = validateHouseholdChoiceSelections(plan, selections);
  const context = plan.householdChoices;
  if (!context) return;
  if (provider !== 'planning_center' || context.version !== 2) throw invalid('The local household review is out of date.');
  await repository.assertHouseholdPreferencesWithConnection(conn, {
    churchId, provider, expectedPreferences: context.basePreferences,
  });
  if (!Object.keys(edits).length) return;
  if (!reviewedApply || reviewedApply.operationKind !== 'people_sync' || allowedMutationBuckets !== null ||
      accepted?.linkCorrections?.length) {
    throw invalid('Saving local household choices requires a full signed sync review.');
  }
  if ((await authority.getAuthorityWithConnection(conn, churchId)).active !== provider) {
    throw invalid('The people-sync authority changed.');
  }
  if (!Array.isArray(context.decisions) || context.decisions.length !== Object.keys(edits).length) {
    throw invalid('The local household decisions are incomplete.');
  }
  const claimed = new Set();
  const groupIds = new Set();
  const otherMoves = new Set([
    ...(plan.moveFamily || []).map(a => a.individualId),
    ...(plan.familyConflicts || []).filter(a => accepted?.acceptedFamilyResolutionIds?.has(a.id))
      .flatMap(a => (a.resolution?.moves || []).map(p => p.individualId)),
  ]);
  for (const decision of context.decisions) {
    const edit = edits[decision.groupId];
    if (!edit || groupIds.has(decision.groupId) || JSON.stringify(edit.destination) !== JSON.stringify(decision.destination) ||
        !Array.isArray(decision.people) || !decision.people.length) throw invalid('The local household decision changed.');
    groupIds.add(decision.groupId);
    if (decision.destination.kind === 'forget') continue;
    for (const person of decision.people) {
      if (claimed.has(person.individualId) || otherMoves.has(person.individualId) ||
          accepted?.acceptedArchiveIndividualIds?.has(person.individualId)) throw invalid('Local household choices conflict with another selected action.');
      claimed.add(person.individualId);
      const rows = await conn.query(`SELECT i.family_id FROM individuals i
        JOIN external_person_links l ON l.church_id = i.church_id AND l.individual_id = i.id
        WHERE i.church_id = ? AND i.id = ? AND l.provider = ? AND l.external_person_id = ?`,
      [churchId, person.individualId, provider, person.externalPersonId]);
      if (rows.length !== 1 || (rows[0].family_id ?? null) !== person.fromFamilyId) {
        throw invalid('A local household member or their person link changed.');
      }
    }
    const ids = decision.destination.kind === 'existing' ? [decision.destination.familyId]
      : decision.destination.kind === 'keep' ? [...new Set(decision.people.map(p => p.fromFamilyId).filter(id => id !== null))] : [];
    for (const familyId of ids) {
      const families = await conn.query('SELECT family_name FROM families WHERE church_id = ? AND id = ?', [churchId, familyId]);
      if (families.length !== 1 || ids.length === 1 && decision.fromName !== null && families[0].family_name !== decision.fromName) {
        throw invalid('The local household or its name changed.');
      }
    }
    if (decision.resolvedName !== null && (typeof decision.resolvedName !== 'string' || !decision.resolvedName.trim() || decision.resolvedName.length > 200)) {
      throw invalid('The reviewed local household name is invalid.');
    }
    if (decision.destination.kind === 'create' && !decision.resolvedName) throw invalid('The new local household needs a name.');
    if (decision.destination.kind === 'keep' && decision.resolvedName &&
        (ids.length !== 1 || decision.people.some(p => p.fromFamilyId === null))) {
      throw invalid('A shared name requires one existing local household.');
    }
  }
}

async function persistHouseholdChoicesWithConnection(conn, { churchId, provider, plan, userId, result, accepted }) {
  const context = plan.householdChoices;
  if (!context) return;
  const preferences = [];
  const renamedFamilies = new Map();
  for (const decision of context.decisions) {
    const { destination } = decision;
    if (destination.kind === 'forget') {
      for (const person of decision.people) {
        const saved = context.basePreferences.find(p => p.externalPersonId === person.externalPersonId);
        if (saved) preferences.push({ ...saved, forget: true });
      }
      continue;
    }
    let familyId = destination.kind === 'existing' ? destination.familyId : null;
    if (destination.kind === 'create') {
      const inserted = await conn.query('INSERT INTO families (church_id, family_name, created_by) VALUES (?, ?, ?)',
        [churchId, decision.resolvedName, userId || null]);
      familyId = inserted.insertId;
      result.addFamilies++;
    }
    if (decision.resolvedName && destination.kind !== 'create') {
      const renamedId = familyId ?? decision.people[0].fromFamilyId;
      if (renamedFamilies.has(renamedId)) {
        if (renamedFamilies.get(renamedId) !== decision.resolvedName) throw invalid('Local household names conflict across cards.');
      } else {
        const renamed = await conn.query("UPDATE families SET family_name = ?, updated_at = datetime('now') WHERE church_id = ? AND id = ? AND family_name = ?",
          [decision.resolvedName, churchId, renamedId, decision.fromName]);
        if (renamed.affectedRows !== 1) throw invalid('The local household name changed during apply.');
        if (decision.resolvedName !== decision.fromName) result.familyNamesUpdated++;
        renamedFamilies.set(renamedId, decision.resolvedName);
      }
    }
    for (const person of decision.people) {
      const targetId = destination.kind === 'keep' ? person.fromFamilyId : familyId;
      if (targetId !== person.fromFamilyId) {
        const moved = await conn.query("UPDATE individuals SET family_id = ?, updated_at = datetime('now') WHERE church_id = ? AND id = ? AND family_id IS ?",
          [targetId, churchId, person.individualId, person.fromFamilyId]);
        if (moved.affectedRows !== 1) throw invalid('A local household member changed during apply.');
        result.moveFamily++;
      }
      preferences.push({ externalPersonId: person.externalPersonId, individualId: person.individualId, familyId: targetId, groupId: decision.groupId,
        sourceFingerprint: person.sourceFingerprint });
    }
  }
  // A genuine PCO change can supersede an earlier local decision through the
  // normal reviewed household move. Remember the newly accepted arrangement
  // against the latest provider evidence, without changing unrelated keeps.
  for (const action of plan.familyConflicts || []) {
    if (!accepted?.acceptedFamilyResolutionIds?.has(action.id)) continue;
    const movedIds = new Set((action.resolution?.moves || []).map(p => p.externalPersonId));
    const memberIds = action.resolution?.kind === 'household' ? new Set(action.memberExternalIds) : movedIds;
    const [destination] = action.resolution?.kind === 'household' ? await conn.query(`SELECT family_id FROM external_family_links
      WHERE church_id = ? AND provider = ? AND external_family_id = ?`, [churchId, provider, action.externalFamilyId])
      : action.resolution?.kind === 'single_person' ? await conn.query(
        'SELECT family_id FROM individuals WHERE church_id = ? AND id = ?', [churchId, action.resolution.moves[0].individualId])
        : [{ family_id: null }];
    if (!destination) throw invalid('The reviewed household destination is no longer available.');
    for (const saved of context.basePreferences.filter(p => memberIds.has(p.externalPersonId))) {
      if (preferences.some(p => p.externalPersonId === saved.externalPersonId)) continue;
      const person = context.groups.flatMap(g => g.people).find(p => p.externalPersonId === saved.externalPersonId && p.individualId === saved.individualId);
      if (!person?.sourceFingerprint) continue;
      const [row] = await conn.query('SELECT family_id FROM individuals WHERE church_id = ? AND id = ?', [churchId, saved.individualId]);
      if (!row) throw invalid('The reviewed household member is no longer available.');
      if (row.family_id !== destination.family_id || !movedIds.has(saved.externalPersonId) &&
          (row.family_id !== saved.familyId || row.family_id !== person.currentFamilyId)) continue;
      preferences.push({ ...saved, familyId: row.family_id, sourceFingerprint: person.sourceFingerprint });
    }
  }
  await repository.persistHouseholdPreferencesWithConnection(conn, { churchId, provider, changes: preferences, createdBy: userId });
  if (Object.keys(context.edits).length) result.householdChoices = Object.keys(context.edits).length;
}

module.exports = { validateHouseholdChoiceSelections, assertHouseholdChoicesWithConnection, persistHouseholdChoicesWithConnection };
