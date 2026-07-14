// Writes PCO's Person.passed_background_check attribute down to
// individuals.pco_background_check_cleared for every already-linked person.
//
// Deliberately separate from diffEngine/apply.js: this is supplementary
// status data, not an identity change, so it doesn't go through the
// review pipeline (ambiguous-match resolution, family-name confirmation,
// etc.) — it's just written on every real sync run, unconditionally, for
// whichever people are already linked. PCO people with no matching
// individual (planning_center_id) in this church are silently skipped —
// there's no row to write it to yet.

const Database = require('../../config/database');

// pcoPeople: the array returned by planningCenterSync.js's fetchAllPcoPeople
// / projectPerson — each entry has { id, passedBackgroundCheck, ... }.
// Returns the number of individuals actually updated.
async function syncBackgroundCheckStatuses(churchId, pcoPeople) {
  let synced = 0;
  for (const p of pcoPeople) {
    if (typeof p.passedBackgroundCheck !== 'boolean') continue;
    const result = await Database.query(
      `UPDATE individuals
          SET pco_background_check_cleared = ?
        WHERE church_id = ? AND planning_center_id = ?`,
      [p.passedBackgroundCheck ? 1 : 0, churchId, p.id]
    );
    if (result.affectedRows > 0) synced++;
  }
  return synced;
}

module.exports = { syncBackgroundCheckStatuses };
