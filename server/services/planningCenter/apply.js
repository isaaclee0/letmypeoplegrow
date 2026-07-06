const Database = require('../../config/database');
const { buildFamilyName } = require('./familyName');

// Group add entries by householdId; null household => its own solo group.
function groupAdds(adds) {
  const map = new Map();
  for (const a of adds) {
    const key = a.householdId || `solo_${a.pcoId}`;
    if (!map.has(key)) map.set(key, { householdId: a.householdId || null, members: [] });
    map.get(key).members.push(a);
  }
  return [...map.values()];
}

// Apply a plan within the CURRENT church DB context (caller sets context).
// selections:
//   { ambiguous?: {individualId: pcoId},
//     skipAddPcoIds?: string[],
//     visitorChoices?: {individualId: 'promote' | 'keep'} }
// batchConfig:
//   { defaultPeopleType?: 'regular'|'local_visitor'|'traveller_visitor', gatheringTypeId?: number|null }
//   — the batch's own settings; applied to every person this run creates or links.
// Returns counts + per-item errors (never throws on item failure). Does NOT touch
// plan.archiveExtras/unmatchedVisitors — those are whole-roster concerns handled by
// applyArchiveExtras() below, called only from the reconciliation endpoints.
async function applyPlan(churchId, plan, userId, selections = {}, batchConfig = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, gatheringAssigned: 0, errors: [] };
  const skipAdd = new Set(selections.skipAddPcoIds || []);
  const ambiguousChoices = selections.ambiguous || {};
  const visitorChoices = selections.visitorChoices || {};
  const defaultPeopleType = batchConfig.defaultPeopleType || 'regular';
  const gatheringTypeId = batchConfig.gatheringTypeId || null;
  // Every individual this run links, restores, promotes, or creates, PLUS every
  // already-linked individual who's currently active and eligible for this batch's
  // filter (plan.gatheringEligible, from diffEngine.js) — used to populate the
  // batch's gathering roster (if one is configured) at the end. Being in this set
  // doesn't imply any change to the individuals row itself; already-linked/eligible
  // people are added here purely so they end up on the gathering roster even though
  // nothing else about their link/active state needs to change this run.
  const touchedIndividualIds = new Set();
  for (const g of (plan.gatheringEligible || [])) touchedIndividualIds.add(g.individualId);

  // links (high-confidence active matches + any ambiguous resolved by the reviewer)
  const links = [...(plan.link || [])];
  for (const [individualId, pcoId] of Object.entries(ambiguousChoices)) {
    if (pcoId) links.push({ individualId: Number(individualId), pcoId });
  }
  for (const l of links) {
    try {
      await Database.query(
        `UPDATE individuals SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [l.pcoId, l.individualId, churchId]
      );
      result.linked++;
      touchedIndividualIds.add(l.individualId);
    } catch (e) { result.errors.push({ type: 'link', id: l.individualId, error: e.message }); }
  }

  // restore: archived LMPG individual whose name matches a PCO person -> link + reactivate.
  for (const r of (plan.restore || [])) {
    try {
      await Database.query(
        `UPDATE individuals SET planning_center_id = ?, is_active = 1, updated_at = datetime('now')
           WHERE id = ? AND church_id = ?`,
        [r.pcoId, r.individualId, churchId]
      );
      result.linked++;
      result.reactivated++;
      touchedIndividualIds.add(r.individualId);
    } catch (e) { result.errors.push({ type: 'restore', id: r.individualId, error: e.message }); }
  }

  // visitorMatches: reviewer decides per-person. Validate against the plan so a
  // client can only promote/keep visitors actually offered by this plan, and
  // only to the PCO id this plan associates with them.
  const visitorByIndividual = new Map((plan.visitorMatches || []).map((v) => [Number(v.individualId), v]));
  for (const [rawId, choice] of Object.entries(visitorChoices)) {
    const id = Number(rawId);
    const offer = visitorByIndividual.get(id);
    if (!offer) continue;
    try {
      if (choice === 'promote') {
        await Database.query(
          `UPDATE individuals
             SET planning_center_id = ?, people_type = 'regular', updated_at = datetime('now')
             WHERE id = ? AND church_id = ?`,
          [offer.candidate.pcoId, id, churchId]
        );
        result.linked++;
        touchedIndividualIds.add(id);
      } else if (choice === 'keep') {
        await Database.query(
          `UPDATE individuals
             SET pco_link_declined = 1, updated_at = datetime('now')
             WHERE id = ? AND church_id = ?`,
          [id, churchId]
        );
      }
    } catch (e) { result.errors.push({ type: 'visitorChoice', id, error: e.message }); }
  }

  for (const u of plan.update) {
    try {
      await Database.query(
        `UPDATE individuals SET first_name = ?, last_name = ?, is_child = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [u.firstName, u.lastName, u.isChild ? 1 : 0, u.individualId, churchId]
      );
      result.updated++;
    } catch (e) { result.errors.push({ type: 'update', id: u.individualId, error: e.message }); }
  }

  for (const a of plan.archive) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [a.individualId, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archive', id: a.individualId, error: e.message }); }
  }

  for (const r of plan.reactivate) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 1, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [r.individualId, churchId]
      );
      result.reactivated++;
    } catch (e) { result.errors.push({ type: 'reactivate', id: r.individualId, error: e.message }); }
  }

  // Ambiguous individuals the reviewer chose to archive outright instead of picking
  // a candidate (or a manual search result). Independent of plan.archive (which is
  // driven by PCO status, not reviewer choice).
  for (const individualId of (selections.archiveAmbiguousIds || [])) {
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [individualId, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveAmbiguous', id: individualId, error: e.message }); }
  }

  // adds: resolve/create family per household, then insert individuals using this
  // batch's default_people_type. Capture new individual ids for gathering assignment.
  const adds = plan.add.filter((a) => !skipAdd.has(a.pcoId));
  const householdIds = [...new Set(adds.map((a) => a.householdId).filter(Boolean))];
  const familyByHousehold = new Map();
  if (householdIds.length) {
    const placeholders = householdIds.map(() => '?').join(',');
    const existing = await Database.query(
      `SELECT id, planning_center_id FROM families WHERE church_id = ? AND planning_center_id IN (${placeholders})`,
      [churchId, ...householdIds]
    );
    for (const f of existing) familyByHousehold.set(f.planning_center_id, f.id);
  }

  for (const g of groupAdds(adds)) {
    try {
      const { createdHouseholdFamilyId, newIds } = await Database.transaction(async (conn) => {
        let familyId = g.householdId ? familyByHousehold.get(g.householdId) : null;
        let created = null;
        if (!familyId) {
          const famRes = await conn.query(
            `INSERT INTO families (church_id, family_name, planning_center_id, created_by, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
            [churchId, buildFamilyName(g.members), g.householdId || null, userId]
          );
          familyId = famRes.insertId;
          if (g.householdId) created = familyId;
        }
        const ids = [];
        for (const m of g.members) {
          const insRes = await conn.query(
            `INSERT INTO individuals (church_id, family_id, first_name, last_name, people_type, is_child, is_active, created_by, created_at, planning_center_id)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), ?)`,
            [churchId, familyId, m.firstName, m.lastName, defaultPeopleType, m.isChild ? 1 : 0, userId, m.pcoId]
          );
          ids.push(insRes.insertId);
        }
        return { createdHouseholdFamilyId: created, newIds: ids };
      });
      if (createdHouseholdFamilyId) familyByHousehold.set(g.householdId, createdHouseholdFamilyId);
      for (const id of newIds) touchedIndividualIds.add(id);
      result.added += g.members.length;
    } catch (e) {
      result.errors.push({ type: 'add', household: g.householdId, error: e.message });
    }
  }

  // Gathering assignment: add everyone this run touched (freshly linked/restored/
  // promoted/added, or already-linked-and-currently-eligible via gatheringEligible)
  // to the batch's gathering roster. result.gatheringAssigned only counts rows that
  // were genuinely new this run — affectedRows === 0 means they were already on the
  // roster (ON CONFLICT DO NOTHING is a safe no-op, not an error, not a new count).
  if (gatheringTypeId) {
    for (const individualId of touchedIndividualIds) {
      try {
        const insertResult = await Database.query(
          `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
           VALUES (?, ?, ?, ?) ON CONFLICT(gathering_type_id, individual_id) DO NOTHING`,
          [gatheringTypeId, individualId, userId, churchId]
        );
        if (insertResult.affectedRows > 0) result.gatheringAssigned++;
      } catch (e) { result.errors.push({ type: 'gatheringAssign', id: individualId, error: e.message }); }
    }
  }

  return result;
}

// Archives active 'regular' individuals whose name matched no one in PCO's full
// people export (plan.archiveExtras from computePlan) — OR, if the reviewer found
// the right PCO person via manual search, links them instead of archiving (link
// always wins over archive/skip for that individual). Used only by the
// reconciliation endpoints — never called as part of a batch's own apply.
async function applyArchiveExtras(churchId, archiveExtras, { skipArchiveExtraIds = [], manualLinks = {} } = {}) {
  const skip = new Set(skipArchiveExtraIds.map(Number));
  const result = { archived: 0, linked: 0, errors: [] };
  for (const x of archiveExtras) {
    const id = Number(x.individualId);
    const linkPcoId = manualLinks[id];
    if (linkPcoId) {
      try {
        await Database.query(
          `UPDATE individuals SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
          [linkPcoId, id, churchId]
        );
        result.linked++;
      } catch (e) { result.errors.push({ type: 'manualLink', id, error: e.message }); }
      continue;
    }
    if (skip.has(id)) continue;
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [id, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveExtra', id, error: e.message }); }
  }
  return result;
}

module.exports = { applyPlan, groupAdds, applyArchiveExtras };
