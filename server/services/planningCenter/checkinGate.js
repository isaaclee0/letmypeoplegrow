// Gate for PCO check-in (attendance history) import.
//
// The check-in importer matches PCO attendees to LMPG individuals only by
// planning_center_id (see checkinsImport.js's resolvePeople) — never by name.
// Importing before any person has ever been linked would silently create a
// brand-new duplicate individual for every attendee instead of matching
// existing ones, and any pre-existing manual record with the same name becomes
// permanently unlinkable afterward (the PCO person is already claimed). This
// module answers "has this church linked anyone yet?" so routes can refuse to
// import until that's no longer true.

const Database = require('../../config/database');

const PCO_NOT_LINKED = 'PCO_NOT_LINKED';

// True once at least one individual in this church has planning_center_id set,
// however that link happened (a sync batch, a manual link, or a prior check-in
// import that already matched someone).
async function hasLinkedPeople(churchId) {
  const rows = await Database.query(
    `SELECT 1 FROM individuals WHERE church_id = ? AND planning_center_id IS NOT NULL LIMIT 1`,
    [churchId]
  );
  return rows.length > 0;
}

// Standard reject payload so the frontend can render a uniform message.
function notLinkedResponse(message) {
  return {
    error: message || 'Link at least one person to Planning Center before importing check-in history.',
    code: PCO_NOT_LINKED,
  };
}

module.exports = { PCO_NOT_LINKED, hasLinkedPeople, notLinkedResponse };
