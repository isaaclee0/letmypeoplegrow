// Provider-neutral scheduled sync (Task 10 of the provider-neutral
// people-sync project). Replaces planningCenterSync.js's own cron job —
// that module's start/stop/runNow now delegate here for compatibility.
//
// This task keeps the actual per-batch execution PCO-specific (via an
// injected `executeBatch`, whose production default delegates to
// planningCenterSync.js's existing runBatchSync) since the generic
// fetch/match/review/apply orchestrator doesn't exist yet — Task 15 swaps
// that default out for orchestrator.runUnattended. Everything AROUND
// execution (which batches are due, which provider may run unattended,
// connection health, per-church isolation, audit trail, review
// notification) is already provider-neutral here.
const cron = require('node-cron');
const Database = require('../../config/database');
const logger = require('../../config/logger');
const authority = require('./authority');
const batchRepository = require('./batchRepository');
const runRepository = require('./runRepository');
const connectionStore = require('./connectionStore');
const { reviewNotificationDecision, buildPcoReviewMessage } = require('../planningCenter/reviewNotification');

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

// ─── Default (production) collaborators ──────────────────────────────────────
// Lazy-required inside functions, never at module top level: planningCenterSync.js
// requires this module (to delegate start/stop/runNow), so a top-level
// require here would be circular. By the time these run, both modules are
// already fully loaded.

async function defaultGetAccessToken(churchId, provider) {
  if (provider !== 'planning_center') return null;
  const pcoSync = require('../planningCenterSync');
  return pcoSync.getAccessTokenForChurch(churchId);
}

// batch here is the generic batchRepository shape; runBatchSync wants the
// legacy PCO DTO shape (flattened filter fields, legacyProviderBatchId) —
// reuse planningCenterSync.js's own batch loader so the two shapes never
// drift apart.
async function defaultExecuteBatch(churchId, batch, context) {
  if (batch.provider !== 'planning_center') {
    logger.warn(`peopleSync scheduler: no unattended executor registered for provider "${batch.provider}" (church ${churchId}, batch ${batch.id}) — skipping`);
    return null;
  }
  const pcoSync = require('../planningCenterSync');
  const legacyBatch = await pcoSync.getBatch(churchId, batch.id);
  if (!legacyBatch) return null;
  return pcoSync.runBatchSync(churchId, context.accessToken, legacyBatch, context.userId || null);
}

// Provider-specific for now (PCO's summary shape and church_settings column);
// a future task can generalize once Elvanto has its own review-count shape.
async function defaultNotify(churchId, totals) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT planning_center_last_notified_review AS last FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  const prev = rows.length && rows[0].last ? JSON.parse(rows[0].last) : null;
  const decision = reviewNotificationDecision(prev, totals);

  if (decision.clear) {
    await Database.queryForChurch(
      churchId,
      `UPDATE church_settings SET planning_center_last_notified_review = NULL WHERE church_id = ?`,
      [churchId]
    );
  }
  if (!decision.notify) return;

  const message = buildPcoReviewMessage(totals);
  const admins = await Database.queryForChurch(
    churchId,
    `SELECT id FROM users WHERE role IN ('admin', 'coordinator') AND is_active = 1 AND church_id = ?`,
    [churchId]
  );
  for (const admin of admins) {
    await Database.queryForChurch(
      churchId,
      `INSERT INTO notifications (user_id, title, message, notification_type, church_id)
       VALUES (?, ?, ?, 'system', ?)`,
      [admin.id, 'Planning Center sync needs your review', message, churchId]
    );
  }
  await Database.queryForChurch(
    churchId,
    `UPDATE church_settings SET planning_center_last_notified_review = ? WHERE church_id = ?`,
    [JSON.stringify(totals), churchId]
  );
  logger.info(`peopleSync scheduler: church ${churchId} notified ${admins.length} admin(s) — ${JSON.stringify(totals)}`);
}

// Maps a PCO batch-sync summary onto runRepository's allowlisted count keys.
// Deliberately conservative: only include a key when there is an unambiguous
// mapping, and never pass through anything runRepository doesn't recognise —
// finishRun/failRun reject unknown keys outright (see COUNT_KEYS), and this
// audit trail must never end up silently dropped because of a stray field.
function toRunCounts(summary) {
  const counts = {};
  if (summary.added) counts.addPeople = summary.added;
  if (summary.updated) counts.updateManagedFields = summary.updated;
  if (summary.archived) counts.archive = summary.archived;
  if (summary.reactivated) counts.reactivate = summary.reactivated;
  if (summary.linked) counts.linkPeople = summary.linked;
  if (summary.gatheringAssigned) counts.addToGathering = summary.gatheringAssigned;
  if (summary.gatheringRemoved) counts.removeFromGathering = summary.gatheringRemoved;
  if (summary.familyNamesUpdated) counts.familyNamesUpdated = summary.familyNamesUpdated;
  if (summary.ambiguous) counts.ambiguousPeople = summary.ambiguous;
  return counts;
}

function hasReviewItems(summary) {
  return !!(
    (summary.ambiguous || 0) > 0 ||
    (summary.visitorMatches || 0) > 0 ||
    (summary.familyNameUpdatesPending || 0) > 0 ||
    // Per-item apply failures (e.g. one bad row in an otherwise-fine batch)
    // aren't a "review" bucket in the plan/diff sense, but a run that hit
    // them is not a clean "applied" either — mark it review_required so it
    // surfaces for a human rather than reading as an unremarkable success.
    (summary.errors || 0) > 0
  );
}

// ─── Per-church sync ──────────────────────────────────────────────────────────
//
// Runs every due, enabled, authorised batch for one church, across every
// registered provider, and returns the accumulated review-required totals.
// Every dependency is injectable so tests can verify scheduling/authority/
// audit behaviour without touching a real database or making a network call;
// production callers (start()/runNow() below) rely entirely on the defaults.
async function runChurch(churchId, options = {}) {
  const {
    providers = PROVIDERS,
    getAuthority = authority.getAuthority,
    listBatches = batchRepository.listBatches,
    getConnection = connectionStore.getConnection,
    getAccessToken = defaultGetAccessToken,
    executeBatch = defaultExecuteBatch,
    startRun = runRepository.startRun,
    finishRun = runRepository.finishRun,
    failRun = runRepository.failRun,
    notify = defaultNotify,
    skipScheduleCheck = false,
    now = new Date(),
  } = options;

  return Database.setChurchContext(churchId, async () => {
    const totals = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 };
    // Tracks whether we actually got far enough to dispatch at least one
    // batch this run (past due/authority/connection/token gating — see
    // below). notify() must only run when this is true: the old syncChurch
    // returned immediately when nothing was due, before ever touching the
    // review-notification logic. If notify() ran unconditionally on a
    // nothing-due night, reviewNotificationDecision sees all-zero totals
    // against an existing dedup marker and CLEARS it — so the next time the
    // same unresolved items reappear (e.g. the following week, for a weekly
    // batch), they look "new" again and re-notify admins who already saw and
    // haven't resolved them. Skipping notify entirely (rather than just
    // skipping the clear) also means it does not spuriously NOTIFY on a
    // nothing-ran night either — there is nothing new to report either way.
    let anyBatchDispatched = false;
    let authorityState;
    try {
      authorityState = await getAuthority(churchId);
    } catch (err) {
      logger.error(`peopleSync scheduler: failed to load authority for church ${churchId}: ${err.message}`);
      return totals;
    }

    for (const provider of providers) {
      let batches;
      try {
        batches = await listBatches(churchId, provider);
      } catch (err) {
        logger.error(`peopleSync scheduler: failed to list ${provider} batches for church ${churchId}: ${err.message}`);
        continue;
      }

      const dueBatches = (batches || []).filter((batch) =>
        batch.enabled && batch.scheduleEnabled &&
        (skipScheduleCheck || isDueToday(batch.scheduleFrequency, batch.scheduleDay, now)));

      if (!dueBatches.length) continue;

      // Only the current authority may run unattended lifecycle reconciliation
      // (archiving/reactivating people with nobody reviewing first). A batch
      // for a provider that is NOT the active authority — including when no
      // authority has been chosen yet ('none') — is skipped entirely for this
      // scheduled cycle. Interactive "Run now"/"Review & sync" from an admin
      // are unaffected; this gate only applies to the unattended cron path.
      if (authorityState.active !== provider) {
        logger.info(`peopleSync scheduler: skipping ${dueBatches.length} due ${provider} batch(es) for church ${churchId} — active authority is "${authorityState.active}", not "${provider}"`);
        continue;
      }

      // Loaded for observability and as a fast-skip for a connection already
      // known to be broken. Deliberately NOT gating on an absent connection
      // row (connection === null): a church whose PCO tokens haven't been
      // migrated onto integration_connections yet (see
      // pcoCredentialMigration.js) has no row here until getAccessToken's
      // first call triggers that migration — treating "no row yet" as "not
      // connected" would permanently block a legacy church from ever syncing
      // again after this change ships.
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

      let accessToken;
      try {
        accessToken = await getAccessToken(churchId, provider);
      } catch (err) {
        logger.error(`peopleSync scheduler: failed to get ${provider} access token for church ${churchId}: ${err.message}`);
        continue;
      }
      if (!accessToken) continue;

      anyBatchDispatched = true;

      for (const batch of dueBatches) {
        let run = null;
        try {
          run = await startRun({ churchId, provider, batchId: batch.id, trigger: 'scheduled', fetchMode: 'full' });
        } catch (err) {
          logger.error(`peopleSync scheduler: failed to start run for batch ${batch.id} (church ${churchId}): ${err.message}`);
        }

        let summary = null;
        try {
          summary = await executeBatch(churchId, batch, { accessToken, provider });
        } catch (err) {
          logger.error(`peopleSync scheduler: batch ${batch.id} failed for church ${churchId}: ${err.message}`);
          if (run) {
            try {
              await failRun({ churchId, provider, runId: run.id, errorCode: 'BATCH_EXECUTION_ERROR', errorMessage: err.message });
            } catch (recordErr) {
              logger.error(`peopleSync scheduler: failed to record run failure for batch ${batch.id} (church ${churchId}): ${recordErr.message}`);
            }
          }
          continue;
        }

        if (!summary) {
          if (run) {
            try {
              await failRun({ churchId, provider, runId: run.id, errorCode: 'BATCH_EXECUTION_FAILED', errorMessage: 'Batch execution did not return a summary' });
            } catch (recordErr) {
              logger.error(`peopleSync scheduler: failed to record run failure for batch ${batch.id} (church ${churchId}): ${recordErr.message}`);
            }
          }
          continue;
        }

        totals.ambiguous += summary.ambiguous || 0;
        totals.visitorMatches += summary.visitorMatches || 0;
        totals.familyNameUpdatesPending += summary.familyNameUpdatesPending || 0;

        if (run) {
          try {
            await finishRun({
              churchId, provider, runId: run.id,
              status: hasReviewItems(summary) ? 'review_required' : 'applied',
              counts: toRunCounts(summary),
            });
          } catch (recordErr) {
            logger.error(`peopleSync scheduler: failed to record run completion for batch ${batch.id} (church ${churchId}): ${recordErr.message}`);
          }
        }
      }
    }

    if (anyBatchDispatched) {
      try {
        await notify(churchId, totals);
      } catch (err) {
        logger.error(`peopleSync scheduler: review notification failed for church ${churchId}: ${err.message}`);
      }
    }

    return totals;
  });
}

// ─── All churches ─────────────────────────────────────────────────────────────
//
// Iterates every registered church SEQUENTIALLY (never in parallel — per-church
// SQLite files and the shared PCO rate limit make concurrent runs risky) and
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
