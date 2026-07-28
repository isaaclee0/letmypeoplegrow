'use strict';

const Database = require('../../config/database');

// The legacy Planning Center switch is a scheduling master switch. It does
// not select the church's source-of-truth provider and it does not disable
// interactive review or check-in imports. Elvanto has no corresponding
// switch, so its unattended policy remains enabled and authority is still
// enforced independently by the scheduler/orchestrator.
async function isProviderUnattendedEnabled(churchId, provider) {
  if (provider !== 'planning_center') return true;
  const rows = await Database.queryForChurch(churchId,
    `SELECT planning_center_sync_enabled FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]);
  return Number(rows[0]?.planning_center_sync_enabled) === 1;
}

module.exports = { isProviderUnattendedEnabled };
