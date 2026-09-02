'use strict';

const Database = require('../../config/database');
const logger = require('../../config/logger');
const { backfillEngagementHistory } = require('./historyBackfill');

async function backfillPendingChurches({ churches, asOf = new Date(), __deps = {} } = {}) {
  const database = __deps.database || Database;
  const backfill = __deps.backfillEngagementHistory || backfillEngagementHistory;
  const log = __deps.log || logger;
  const candidates = (churches || database.listChurches()).filter(
    (church) => Number(church.is_approved) === 1,
  );
  const results = [];

  for (const church of candidates) {
    const churchId = church.church_id;
    const started = Date.now();
    try {
      const result = await backfill(churchId, { asOf });
      results.push({ churchId, ...result });
      log.info('Engagement history backfill checked', {
        churchId,
        status: result.status,
        rulesVersion: result.rulesVersion,
        weeksEvaluated: result.weeksEvaluated,
        transitionsReconstructed: result.transitionsReconstructed,
        elapsedMs: Date.now() - started,
      });
    } catch (error) {
      results.push({ churchId, status: 'failed', error: error.message });
      log.warn('Engagement history backfill failed', {
        churchId, error: error.message, elapsedMs: Date.now() - started,
      });
    }
  }
  return results;
}

module.exports = { backfillPendingChurches };
