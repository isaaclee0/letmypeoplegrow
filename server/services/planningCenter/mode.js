// Temporary PCO compatibility adapter over provider-neutral people authority.
//
// While mode is active:
//   - linked individuals (planning_center_id set) become read-only for name/age
//     and are not deletable/mergeable/archivable by hand;
//   - creation of new regulars is disabled (visitors only);
//   - sync converges LMPG's regular population to PCO.

const Database = require('../../config/database');
const { getAuthority } = require('../peopleSync/authority');

const PCO_MODE_LOCKED = 'PCO_MODE_LOCKED';

async function isPcoModeActive(churchId) {
  return (await getAuthority(churchId)).active === 'planning_center';
}

// Per-church flag for the background-check status feature. Independent of
// isPcoModeActive — a church can track background checks without PCO being
// source-of-truth for member identity, and vice versa.
async function isBackgroundCheckTrackingEnabled(churchId) {
  const rows = await Database.query(
    `SELECT planning_center_track_background_checks AS enabled
       FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  return rows.length > 0 && !!rows[0].enabled;
}

// A person is "linked" when they have a PCO id.
function isIndividualLocked(individual) {
  if (!individual) return false;
  const pid = individual.planning_center_id != null
    ? individual.planning_center_id
    : individual.planningCenterId;
  return typeof pid === 'string' ? pid.length > 0 : !!pid;
}

// Convenience: fetch the minimal "lock-relevant" fields for one or more ids.
// Returns Map<id, {id, planning_center_id, people_type, is_active}>.
async function getLockInfo(churchId, ids) {
  if (!ids || !ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await Database.query(
    `SELECT id, planning_center_id, people_type, is_active
       FROM individuals
       WHERE church_id = ? AND id IN (${placeholders})`,
    [churchId, ...ids]
  );
  const map = new Map();
  for (const r of rows) map.set(Number(r.id), r);
  return map;
}

// Standard reject payload so the frontend can render a uniform message.
function lockedResponse(message) {
  return {
    error: message || 'This action is managed by Planning Center while PCO sync is on.',
    code: PCO_MODE_LOCKED,
  };
}

module.exports = {
  PCO_MODE_LOCKED,
  isPcoModeActive,
  isBackgroundCheckTrackingEnabled,
  isIndividualLocked,
  getLockInfo,
  lockedResponse,
};
