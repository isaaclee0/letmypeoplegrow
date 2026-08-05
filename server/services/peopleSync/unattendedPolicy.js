'use strict';

const Database = require('../../config/database');

// Sync execution is provider-neutral. The active authority remains selected
// while paused so a church can resume without re-linking or re-reviewing.
async function isPeopleSyncEnabled(churchId) {
  const rows = await Database.queryForChurch(churchId,
    `SELECT sync_enabled FROM people_sync_settings WHERE church_id = ? LIMIT 1`,
    [churchId]);
  return rows[0]?.sync_enabled === undefined ? true : Number(rows[0].sync_enabled) === 1;
}

module.exports = { isPeopleSyncEnabled };
