const { test } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();
const {
  getLocalHour,
  getLocalDayName,
  getLocalDateString,
  createProcessChurch,
} = require('./weeklyReviewScheduler');

test('weekly review send day and hour use the church timezone', () => {
  const now = new Date('2026-08-13T21:15:00Z'); // Friday 7:15am Hobart
  assert.equal(getLocalHour('Australia/Hobart', now), 7);
  assert.equal(getLocalDayName('Australia/Hobart', now), 'Friday');
  assert.equal(getLocalDateString('Australia/Hobart', now), '2026-08-14');
});

function schedulerHarness({
  enabled = 0,
  day = 'Friday',
  confirmationError = null,
  pastoralError = null,
  lastSent = null,
  reviewData = undefined,
  mainGatheringData = true,
} = {}) {
  const calls = { stages: [], evaluations: [], pastorals: [], reviews: [], digests: [] };
  const database = {
    setChurchContext: async (_churchId, fn) => fn(),
    query: async (sql) => {
      if (sql.includes('weekly_review_email_enabled')) return [{
        weekly_review_email_enabled: enabled,
        weekly_review_email_day: day,
        weekly_review_email_include_insight: 0,
        weekly_review_email_last_sent: lastSent,
        timezone: 'Australia/Hobart',
      }];
      if (sql.includes('weekly_review_guidance')) return [{ weekly_review_guidance: 'Known context' }];
      if (sql.startsWith('UPDATE church_settings SET weekly_review_email_last_sent')) return { affectedRows: 1 };
      return [];
    },
  };
  const processChurch = createProcessChurch({
    database,
    evaluateEngagementTierConfirmations: async (churchId, options) => {
      calls.stages.push('confirm');
      calls.evaluations.push({ churchId, asOf: options.asOf.toISOString() });
      if (confirmationError) throw confirmationError;
      return { completedWeekEnd: '2026-08-09' };
    },
    processConfirmedPrimaryTransitions: async (churchId, options) => {
      calls.stages.push('pastoral');
      calls.pastorals.push({ churchId, throughWeekEnd: options?.throughWeekEnd });
      if (pastoralError) throw pastoralError;
      return { transitionsProcessed: 0 };
    },
    generateWeeklyReviewData: async (churchId) => reviewData === undefined ? ({
      churchName: 'Test Church',
      weekStartDate: '2026-08-03',
      weekEndDate: '2026-08-09',
      gatherings: [],
      weeklyTotals: [],
      recipients: [{ id: 7, email: 'admin@example.test', first_name: 'Admin' }],
      churchId,
    }) : reviewData,
    sendWeeklyReviewEmail: async (email) => calls.reviews.push(email),
    sendWeeklyCaregiverDigests: async (churchId, options) => calls.digests.push({
      churchId,
      now: options.now.toISOString(),
      includeAbsences: options.includeAbsences,
    }),
    hasMainGatheringData: async () => mainGatheringData,
    generateInsight: async () => null,
    saveInsightAsConversation: async () => {},
  });
  return { calls, processChurch };
}

test('configured primary day confirms tiers before processing pastoral transitions even when weekly email delivery is disabled', async () => {
  const { calls, processChurch } = schedulerHarness({ enabled: 0 });
  const now = new Date('2026-08-13T21:15:00.000Z');

  await processChurch({ church_id: 'church-a' }, { now });

  assert.deepEqual(calls.evaluations, [{
    churchId: 'church-a',
    asOf: '2026-08-13T21:15:00.000Z',
  }]);
  assert.deepEqual(calls.stages, ['confirm', 'pastoral']);
  assert.deepEqual(calls.pastorals, [{ churchId: 'church-a', throughWeekEnd: '2026-08-09' }]);
  assert.deepEqual(calls.reviews, []);
  assert.deepEqual(calls.digests, []);
});

test('retry day sends enabled emails without rerunning the primary-day evaluation', async () => {
  const { calls, processChurch } = schedulerHarness({ enabled: 1 });
  const now = new Date('2026-08-14T21:15:00.000Z');

  await processChurch({ church_id: 'church-a' }, { now });

  assert.deepEqual(calls.evaluations, []);
  assert.deepEqual(calls.pastorals, []);
  assert.deepEqual(calls.reviews, ['admin@example.test']);
  assert.deepEqual(calls.digests, [{
    churchId: 'church-a',
    now: '2026-08-14T21:15:00.000Z',
    includeAbsences: undefined,
  }]);
});

test('an already-sent week retries only pending decline deliveries without duplicating review content', async () => {
  const { calls, processChurch } = schedulerHarness({
    enabled: 1,
    lastSent: '2026-08-14',
  });
  const now = new Date('2026-08-14T21:15:00.000Z');

  await processChurch({ church_id: 'church-a' }, { now });

  assert.deepEqual(calls.evaluations, []);
  assert.deepEqual(calls.reviews, []);
  assert.deepEqual(calls.digests, [{
    churchId: 'church-a',
    now: '2026-08-14T21:15:00.000Z',
    includeAbsences: false,
  }]);
});

test('missing weekly review data still attempts pending decline delivery without absence content', async () => {
  const { calls, processChurch } = schedulerHarness({ enabled: 1, reviewData: null });
  const now = new Date('2026-08-13T21:15:00.000Z');

  await processChurch({ church_id: 'church-a' }, { now });

  assert.equal(calls.evaluations.length, 1);
  assert.deepEqual(calls.reviews, []);
  assert.deepEqual(calls.digests, [{
    churchId: 'church-a',
    now: '2026-08-13T21:15:00.000Z',
    includeAbsences: false,
  }]);
});

test('primary-day attendance deferral still attempts pending decline delivery without absence content', async () => {
  const { calls, processChurch } = schedulerHarness({
    enabled: 1,
    mainGatheringData: false,
  });
  const now = new Date('2026-08-13T21:15:00.000Z');

  await processChurch({ church_id: 'church-a' }, { now });

  assert.equal(calls.evaluations.length, 1);
  assert.deepEqual(calls.reviews, []);
  assert.deepEqual(calls.digests, [{
    churchId: 'church-a',
    now: '2026-08-13T21:15:00.000Z',
    includeAbsences: false,
  }]);
});

test('a church confirmation failure is contained so the next church still evaluates', async () => {
  const failing = schedulerHarness({ enabled: 0, confirmationError: new Error('broken church') });
  const healthy = schedulerHarness({ enabled: 0 });
  const now = new Date('2026-08-13T21:15:00.000Z');

  await failing.processChurch({ church_id: 'church-a' }, { now });
  await healthy.processChurch({ church_id: 'church-b' }, { now });

  assert.equal(failing.calls.evaluations.length, 1);
  assert.deepEqual(failing.calls.pastorals, [{ churchId: 'church-a', throughWeekEnd: undefined }]);
  assert.deepEqual(healthy.calls.evaluations, [{
    churchId: 'church-b',
    asOf: '2026-08-13T21:15:00.000Z',
  }]);
});

test('a confirmation failure does not suppress pastoral, weekly, or absence email paths', async () => {
  const { calls, processChurch } = schedulerHarness({
    enabled: 1,
    confirmationError: new Error('confirmation evaluator unavailable'),
  });
  const now = new Date('2026-08-13T21:15:00.000Z');

  await processChurch({ church_id: 'church-a' }, { now });

  assert.equal(calls.evaluations.length, 1);
  assert.deepEqual(calls.stages, ['confirm', 'pastoral']);
  assert.deepEqual(calls.pastorals, [{ churchId: 'church-a', throughWeekEnd: undefined }]);
  assert.deepEqual(calls.reviews, ['admin@example.test']);
  assert.deepEqual(calls.digests, [{
    churchId: 'church-a',
    now: '2026-08-13T21:15:00.000Z',
    includeAbsences: undefined,
  }]);
});

test('a pastoral processing failure does not suppress the ordinary weekly or absence email paths', async () => {
  const { calls, processChurch } = schedulerHarness({
    enabled: 1,
    pastoralError: new Error('pastoral processor unavailable'),
  });
  const now = new Date('2026-08-13T21:15:00.000Z');

  await processChurch({ church_id: 'church-a' }, { now });

  assert.deepEqual(calls.stages, ['confirm', 'pastoral']);
  assert.deepEqual(calls.reviews, ['admin@example.test']);
  assert.deepEqual(calls.digests, [{
    churchId: 'church-a',
    now: '2026-08-13T21:15:00.000Z',
    includeAbsences: undefined,
  }]);
});
