const { test } = require('node:test');
const assert = require('node:assert');
const { reviewNotificationDecision, buildPcoReviewMessage } = require('./reviewNotification');

const ZERO = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 };

test('reviewNotificationDecision: all zero with no prior snapshot does not notify or clear', () => {
  const result = reviewNotificationDecision(null, ZERO);
  assert.deepStrictEqual(result, { notify: false, clear: false });
});

test('reviewNotificationDecision: all zero with a prior snapshot clears it without notifying', () => {
  const prev = { ambiguous: 2, visitorMatches: 0, familyNameUpdatesPending: 0 };
  const result = reviewNotificationDecision(prev, ZERO);
  assert.deepStrictEqual(result, { notify: false, clear: true });
});

test('reviewNotificationDecision: nonzero with no prior snapshot notifies', () => {
  const totals = { ambiguous: 3, visitorMatches: 0, familyNameUpdatesPending: 0 };
  const result = reviewNotificationDecision(null, totals);
  assert.deepStrictEqual(result, { notify: true, clear: false });
});

test('reviewNotificationDecision: identical to prior snapshot does not notify again', () => {
  const totals = { ambiguous: 3, visitorMatches: 1, familyNameUpdatesPending: 2 };
  const prev = { ambiguous: 3, visitorMatches: 1, familyNameUpdatesPending: 2 };
  const result = reviewNotificationDecision(prev, totals);
  assert.deepStrictEqual(result, { notify: false, clear: false });
});

test('reviewNotificationDecision: a changed count notifies again', () => {
  const prev = { ambiguous: 3, visitorMatches: 1, familyNameUpdatesPending: 2 };
  const totals = { ambiguous: 5, visitorMatches: 1, familyNameUpdatesPending: 2 };
  const result = reviewNotificationDecision(prev, totals);
  assert.deepStrictEqual(result, { notify: true, clear: false });
});

test('buildPcoReviewMessage: singular ambiguous match', () => {
  const totals = { ambiguous: 1, visitorMatches: 0, familyNameUpdatesPending: 0 };
  assert.strictEqual(buildPcoReviewMessage(totals), '1 ambiguous match need review in Review & Sync.');
});

test('buildPcoReviewMessage: plural counts across all three review-needed buckets', () => {
  const totals = { ambiguous: 3, visitorMatches: 2, familyNameUpdatesPending: 1 };
  assert.strictEqual(
    buildPcoReviewMessage(totals),
    '3 ambiguous matches, 2 possible visitor matches, 1 family name update need review in Review & Sync.'
  );
});

test('buildPcoReviewMessage: ambiguous-only totals produce just the pending-review sentence', () => {
  const totals = { ambiguous: 2, visitorMatches: 0, familyNameUpdatesPending: 0 };
  assert.strictEqual(
    buildPcoReviewMessage(totals),
    '2 ambiguous matches need review in Review & Sync.'
  );
});
