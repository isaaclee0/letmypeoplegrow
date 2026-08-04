const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deriveBatchOperationalState,
  isBatchRunnable,
  isBatchReviewable,
  assertBatchRunnable,
  assertBatchReviewable,
} = require('./batchOperationalState');

const source = { kind: 'list', externalId: 'list-1', name: 'Members' };

test('derives the operational state from enabled, source-review, and authority configuration', () => {
  const cases = [
    [{ enabled: false, provider: 'elvanto' }, 'elvanto', 'disabled'],
    [{ enabled: true, provider: 'elvanto', needsSourceReview: true }, 'elvanto', 'source_review_required'],
    [{ enabled: true, provider: 'elvanto', needsSourceReview: false, source }, 'planning_center', 'prepared'],
    [{ enabled: true, provider: 'elvanto', needsSourceReview: false, source }, 'elvanto', 'active'],
  ];

  for (const [batch, authorityProvider, expected] of cases) {
    assert.equal(deriveBatchOperationalState(batch, authorityProvider), expected);
  }
});

test('an active-authority initial or replacement source draft is reviewable but not runnable', () => {
  const initialDraft = { enabled: true, provider: 'elvanto', needsSourceReview: true, draftSource: source };
  const replacementDraft = { ...initialDraft, source };

  for (const batch of [initialDraft, replacementDraft]) {
    assert.equal(isBatchReviewable(batch, 'elvanto'), true);
    assert.equal(isBatchRunnable(batch, 'elvanto'), false);
    assert.doesNotThrow(() => assertBatchReviewable(batch, 'elvanto'));
    assert.throws(() => assertBatchRunnable(batch, 'elvanto'), {
      code: 'SYNC_SOURCE_REVIEW_REQUIRED', status: 409,
    });
  }
});

test('a draft batch under another or no authority is neither reviewable nor runnable', () => {
  const batch = { enabled: true, provider: 'elvanto', needsSourceReview: true, draftSource: source };

  for (const authorityProvider of ['planning_center', 'none']) {
    assert.equal(isBatchReviewable(batch, authorityProvider), false);
    assert.equal(isBatchRunnable(batch, authorityProvider), false);
    assert.throws(() => assertBatchReviewable(batch, authorityProvider), {
      code: 'SYNC_BATCH_PREPARED', status: 409,
    });
  }
});

test('runnable assertions distinguish prepared and missing-source batches', () => {
  assert.throws(() => assertBatchRunnable({ enabled: true, provider: 'elvanto', source }, 'planning_center'), {
    code: 'SYNC_BATCH_PREPARED', status: 409,
  });
  assert.throws(() => assertBatchRunnable({ enabled: true, provider: 'elvanto' }, 'elvanto'), {
    code: 'SYNC_SOURCE_SELECTION_REQUIRED', status: 409,
  });
});
