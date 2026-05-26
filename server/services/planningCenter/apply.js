const Database = require('../../config/database');

// "Lastname, Firstname and Firstname" from adults first (matches importer convention).
function buildFamilyName(members) {
  const adults = members.filter((m) => !m.isChild);
  const nameMembers = adults.length ? adults : members;
  const lastName = (nameMembers[0] && nameMembers[0].lastName) || 'Unknown';
  const firstNames = nameMembers.map((m) => m.firstName).filter(Boolean);
  return firstNames.length ? `${lastName}, ${firstNames.join(' and ')}` : lastName;
}

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
//     skipArchiveExtraIds?: number[],
//     visitorChoices?: {individualId: 'promote' | 'keep'} }
// Returns counts + per-item errors (never throws on item failure).
async function applyPlan(churchId, plan, userId, selections = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, errors: [] };
  const skipAdd = new Set(selections.skipAddPcoIds || []);
  const skipArchiveExtras = new Set((selections.skipArchiveExtraIds || []).map(Number));
  const ambiguousChoices = selections.ambiguous || {};
  const visitorChoices = selections.visitorChoices || {};

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
    } catch (e) { result.errors.push({ type: 'restore', id: r.individualId, error: e.message }); }
  }

  // archiveExtras: active 'regular' rows that didn't match PCO -> archive (is_active = 0).
  // Per-item skip honoured via selections.skipArchiveExtraIds (mirrors skipAddPcoIds).
  for (const x of (plan.archiveExtras || [])) {
    if (skipArchiveExtras.has(Number(x.individualId))) continue;
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [x.individualId, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveExtra', id: x.individualId, error: e.message }); }
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

  // adds: resolve/create family per household, then insert individuals
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
      const createdHouseholdFamilyId = await Database.transaction(async (conn) => {
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
        for (const m of g.members) {
          await conn.query(
            `INSERT INTO individuals (church_id, family_id, first_name, last_name, people_type, is_child, is_active, created_by, created_at, planning_center_id)
             VALUES (?, ?, ?, ?, 'regular', ?, 1, ?, datetime('now'), ?)`,
            [churchId, familyId, m.firstName, m.lastName, m.isChild ? 1 : 0, userId, m.pcoId]
          );
        }
        return created;
      });
      if (createdHouseholdFamilyId) familyByHousehold.set(g.householdId, createdHouseholdFamilyId);
      result.added += g.members.length;
    } catch (e) {
      result.errors.push({ type: 'add', household: g.householdId, error: e.message });
    }
  }

  return result;
}

module.exports = { applyPlan, buildFamilyName, groupAdds };
