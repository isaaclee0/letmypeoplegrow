// Provider-neutral scheduled sync (Task 10 of the provider-neutral
// people-sync project; batch execution wired to the real orchestrator in
// Task 15). Replaces planningCenterSync.js's own cron job — that module's
// start/stop/runNow still delegate here for compatibility.
//
// Task 15 note: this module used to own its own audit-trail bookkeeping
// (startRun/finishRun/failRun) and its own PCO-specific review
// notification (defaultNotify, backed by
// server/services/planningCenter/reviewNotification.js's
// reviewNotificationDecision/buildPcoReviewMessage — a church_settings-
// column-backed, PCO-only mechanism). Both of those responsibilities now
// live INSIDE orchestrator.runUnattended itself (see orchestrator.js's own
// header note on the 10-step pipeline): every due batch's entire
// fetch/match/plan/apply-or-hold/audit/notify sequence happens in ONE
// runUnattended call, so this module no longer starts/finishes runs or
// decides whether to notify admins — it only decides WHICH batches are
// due, confirms the provider is the active authority and its connection
// isn't already known-bad, calls runUnattended once per due batch, and
// (only on success) persists the batch's own last-sync bookkeeping via
// batchRepository.recordBatchResult. The PCO-only reviewNotification
// module is intentionally left untouched and unused by this file now —
// removing its import here (rather than deleting the module outright) is
// deliberate: Task 15's file list does not include deleting it, and nothing
// else in this codebase requires it gone.
const cron = require('node-cron');
const Database = require('../../config/database');
const logger = require('../../config/logger');
const authority = require('./authority');
const batchRepository = require('./batchRepository');
const connectionStore = require('./connectionStore');
const orchestrator = require('./orchestrator');
const unattendedPolicy = require('./unattendedPolicy');
const { isBatchRunnable } = require('./batchOperationalState');

const PROVIDERS = ['planning_center', 'elvanto'];

// ─── isDueToday ───────────────────────────────────────────────────────────────
// Moved unchanged from planningCenterSync.js (see git history for the
// original). Decides whether a batch's configured schedule fires "tonight".
// Weekly day-of-week: 0=Sunday..6=Saturday (JS Date convention). Monthly
// day-of-month: 1-31, clamped to the last day of shorter months (e.g. day 31
// runs on April 30th; day 29 runs on Feb 28th outside leap years).
function isDueToday(frequency, day, now = new Date()) {
  if (frequency === 'daily') return true;
  if (frequency === 'monthly') {
    // A stored day < 1 (e.g. a legacy row saved as day=0 back when this
    // column meant "day of week" for every frequency, before monthly got its
    // own 1-31 validation) must fall back to a safe default rather than
    // resolve to Math.min(0, lastDayOfMonth) === 0, which would never match
    // any date and silently stop the schedule from ever firing again.
    const targetDay = typeof day === 'number' && day >= 1 ? day : 1;
    const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return now.getDate() === Math.min(targetDay, lastDayOfMonth);
  }
  // weekly (default, and fallback for unrecognized frequencies)
  const targetDay = typeof day === 'number' ? day : 1;
  return now.getDay() === targetDay;
}

// Legacy church-wide reconciliation setting retained for stored-data and
// dependency-injection compatibility. Provider-owned source membership is
// always read as a complete source set, so this cadence no longer chooses a
// fetch mode.
async function defaultGetFullReconciliationSchedule(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT full_reconciliation_frequency, full_reconciliation_day FROM people_sync_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  const row = rows[0] || {};
  return {
    frequency: row.full_reconciliation_frequency || 'weekly',
    day: Number.isInteger(row.full_reconciliation_day) ? row.full_reconciliation_day : 1,
  };
}

// ─── Per-church sync ──────────────────────────────────────────────────────────
//
// Runs every due, enabled, authorised batch for one church, across every
// registered provider. Every dependency is injectable so tests can verify
// scheduling/authority/connection-gating behaviour without touching a real
// database, a real provider adapter, or the audit/notification internals
// orchestrator.runUnattended now owns; production callers (start()/runNow()
// below) rely entirely on the defaults.
async function runChurch(churchId, options = {}) {
  const {
    providers = PROVIDERS,
    getAuthority = authority.getAuthority,
    listBatches = batchRepository.listBatches,
    getConnection = connectionStore.getConnection,
    runUnattended = orchestrator.runUnattended,
    recordBatchResult = batchRepository.recordBatchResult,
    getFullReconciliationSchedule = defaultGetFullReconciliationSchedule,
    getUnattendedProviderEnabled = unattendedPolicy.isPeopleSyncEnabled,
    skipScheduleCheck = false,
    now = new Date(),
  } = options;

  return Database.setChurchContext(churchId, async () => {
    let authorityState;
    try {
      authorityState = await getAuthority(churchId);
    } catch (err) {
      logger.error(`peopleSync scheduler: failed to load authority for church ${churchId}: ${err.message}`);
      return;
    }

    // Provider-owned source membership has no provider-neutral incremental
    // contract. Every due source batch is therefore a complete full read;
    // the legacy church-wide reconciliation cadence no longer changes fetch
    // mode (it remains available in settings for backward compatibility).
    void getFullReconciliationSchedule;
    const forceFullToday = true;

    for (const provider of providers) {
      // Only the current authority may run unattended lifecycle
      // reconciliation (archiving/reactivating people with nobody
      // reviewing first). Interactive "Run now"/"Review & sync" from an
      // admin are unaffected; this gate only applies to the unattended
      // cron path. orchestrator.runUnattended enforces the exact same
      // rule independently — this is a cheap pre-filter, not the sole
      // guard.
      if (authorityState.active !== provider) continue;

      let unattendedEnabled;
      try {
        unattendedEnabled = await getUnattendedProviderEnabled(churchId, provider);
      } catch (err) {
        logger.error(`peopleSync scheduler: failed to load unattended policy for ${provider} in church ${churchId}: ${err.message}`);
        continue;
      }
      if (!unattendedEnabled) continue;

      let batches;
      try {
        batches = await listBatches(churchId, provider);
      } catch (err) {
        logger.error(`peopleSync scheduler: failed to list ${provider} batches for church ${churchId}: ${err.message}`);
        continue;
      }

      const dueBatches = (batches || []).filter((batch) =>
        isBatchRunnable(batch, authorityState.active) && batch.scheduleEnabled &&
        (skipScheduleCheck || isDueToday(batch.scheduleFrequency, batch.scheduleDay, now)));
      if (!dueBatches.length) continue;

      // Loaded for observability and as a fast-skip for a connection already
      // known to be broken. Deliberately NOT gating on an absent connection
      // row (connection === null): a church whose credentials haven't been
      // migrated/connected onto integration_connections yet has no row here
      // — treating "no row yet" as "not connected" would permanently block
      // scheduling; orchestrator.runUnattended's own connection load will
      // report a clear, per-batch failure for that case instead.
      let connection;
      try {
        connection = await getConnection(churchId, provider);
      } catch (err) {
        logger.error(`peopleSync scheduler: failed to load ${provider} connection status for church ${churchId}: ${err.message}`);
        connection = null;
      }
      if (connection && connection.connectionStatus === 'invalid') {
        logger.warn(`peopleSync scheduler: skipping ${provider} batches for church ${churchId} — connection is marked invalid`);
        continue;
      }

      for (const batch of dueBatches) {
        let result;
        try {
          result = await runUnattended({ churchId, provider, batchId: batch.id, forceFull: forceFullToday });
        } catch (err) {
          // orchestrator.runUnattended already records its own run failure
          // (failRun) internally before rethrowing — this catch exists only
          // to keep one batch's failure from stopping the rest of this
          // church's (or any other church's) batches.
          logger.error(`peopleSync scheduler: batch ${batch.id} failed for church ${churchId}: ${err.message}`);
          continue;
        }
        if (!result) continue;

        try {
          await recordBatchResult({
            churchId, provider, batchId: batch.id, trigger: 'scheduled',
            fetchMode: result.fetchMode, complete: result.complete,
            status: result.status, externalWatermark: result.externalWatermark,
          });
        } catch (recordErr) {
          logger.error(`peopleSync scheduler: failed to record batch result for batch ${batch.id} (church ${churchId}): ${recordErr.message}`);
        }
      }
    }
  });
}

// ─── All churches ─────────────────────────────────────────────────────────────
//
// Iterates every registered church SEQUENTIALLY (never in parallel — per-church
// SQLite files and provider rate limits make concurrent runs risky) and
// calls runChurch for each. A single church's failure is caught here (in
// addition to runChurch's own internal per-batch isolation) so it can never
// stop any other church's sync from running.
async function runAllChurches(options = {}) {
  // runChurch itself is also injectable (defaults to the real one above) so
  // tests can verify this loop's own per-church isolation directly, without
  // depending on which of runChurch's internal try/catches happens to
  // absorb a given failure.
  const { listChurches = () => Database.listChurches(), runChurch: runChurchFn = runChurch, ...rest } = options;
  const churches = await listChurches();
  for (const church of churches) {
    const churchId = (church && (church.church_id || church.churchId)) || church;
    try {
      await runChurchFn(churchId, rest);
    } catch (err) {
      logger.error(`peopleSync scheduler: unhandled error for church ${churchId}: ${err.message}`);
    }
  }
}

// ─── Cron wiring ──────────────────────────────────────────────────────────────

let cronJob = null;

function start() {
  if (cronJob) cronJob.stop();

  cronJob = cron.schedule('0 2 * * *', async () => {
    try {
      await runAllChurches();
    } catch (err) {
      logger.error(`peopleSync scheduler: cron run failed: ${err.message}`);
    }
  });

  logger.info('peopleSync scheduler started (daily at 2 AM)');
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

// Manual trigger (e.g. for an admin "run now" tool) — runs unconditionally,
// bypassing the frequency/day schedule gate.
async function runNow() {
  await runAllChurches({ skipScheduleCheck: true });
}

module.exports = {
  start, stop, runNow, runChurch, runAllChurches, isDueToday,
};
