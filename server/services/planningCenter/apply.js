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
// selections: { ambiguous?: {individualId: pcoId}, skipAddPcoIds?: string[] }
// Returns counts + per-item errors (never throws on item failure).
async function applyPlan(churchId, plan, userId, selections = {}) {
  const result = { linked: 0, added: 0, updated: 0, archived: 0, reactivated: 0, errors: [] };
  const skipAdd = new Set(selections.skipAddPcoIds || []);
  const ambiguousChoices = selections.ambiguous || {};

  // links (high-confidence + any ambiguous resolved by the reviewer)
  const links = [...plan.link];
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
      let familyId = g.householdId ? familyByHousehold.get(g.householdId) : null;
      if (!familyId) {
        const famRes = await Database.query(
          `INSERT INTO families (church_id, family_name, planning_center_id, created_by, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
          [churchId, buildFamilyName(g.members), g.householdId || null, userId]
        );
        familyId = famRes.insertId;
        if (g.householdId) familyByHousehold.set(g.householdId, familyId);
      }
      for (const m of g.members) {
        await Database.query(
          `INSERT INTO individuals (church_id, family_id, first_name, last_name, people_type, is_child, is_active, created_by, created_at, planning_center_id)
           VALUES (?, ?, ?, ?, 'regular', ?, 1, ?, datetime('now'), ?)`,
          [churchId, familyId, m.firstName, m.lastName, m.isChild ? 1 : 0, userId, m.pcoId]
        );
        result.added++;
      }
    } catch (e) { result.errors.push({ type: 'add', household: g.householdId, error: e.message }); }
  }

  return result;
}

module.exports = { applyPlan, buildFamilyName, groupAdds };
