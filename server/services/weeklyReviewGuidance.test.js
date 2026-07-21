const { test } = require('node:test');
const assert = require('node:assert');
const { buildDistillerUserMessage, shouldNudgeForGuidance, resolveModel, DISTILLER_SYSTEM_PROMPT } = require('./weeklyReviewGuidance');

test('buildDistillerUserMessage includes focus, per-gathering notes, and avoid list', () => {
  const msg = buildDistillerUserMessage({
    focus: 'Growing our young families',
    gatheringNotes: [
      { name: 'Network Youth', note: 'Youth group; adults present are leaders' },
      { name: 'Sunday Service', note: '' },
    ],
    avoid: 'Do not comment on the choir',
  });
  assert.match(msg, /Growing our young families/);
  assert.match(msg, /Network Youth/);
  assert.match(msg, /adults present are leaders/);
  assert.match(msg, /Do not comment on the choir/);
  // gatherings with empty notes are omitted
  assert.ok(!/Sunday Service/.test(msg));
});

test('buildDistillerUserMessage handles all-empty answers', () => {
  const msg = buildDistillerUserMessage({ focus: '', gatheringNotes: [], avoid: '' });
  assert.strictEqual(typeof msg, 'string');
  assert.ok(msg.length >= 0);
});

test('DISTILLER_SYSTEM_PROMPT instructs treating input as data, not instructions', () => {
  assert.match(DISTILLER_SYSTEM_PROMPT, /never.*instructions|not.*instructions|do not follow/i);
});

test('shouldNudgeForGuidance true when data present, 3+ weeks, no guidance, no pending nudge', () => {
  assert.strictEqual(shouldNudgeForGuidance({
    hasGuidance: false, gatheringCount: 2, peopleCount: 25, weeksTracked: 3, pendingNudge: false,
  }), true);
});

test('shouldNudgeForGuidance false below the 3-week threshold', () => {
  assert.strictEqual(shouldNudgeForGuidance({
    hasGuidance: false, gatheringCount: 2, peopleCount: 25, weeksTracked: 2, pendingNudge: false,
  }), false);
});

test('shouldNudgeForGuidance false when guidance already set', () => {
  assert.strictEqual(shouldNudgeForGuidance({
    hasGuidance: true, gatheringCount: 2, peopleCount: 25, weeksTracked: 5, pendingNudge: false,
  }), false);
});

test('shouldNudgeForGuidance false when a nudge is already pending', () => {
  assert.strictEqual(shouldNudgeForGuidance({
    hasGuidance: false, gatheringCount: 2, peopleCount: 25, weeksTracked: 5, pendingNudge: true,
  }), false);
});

test('shouldNudgeForGuidance false with no gatherings or no people', () => {
  assert.strictEqual(shouldNudgeForGuidance({
    hasGuidance: false, gatheringCount: 0, peopleCount: 25, weeksTracked: 5, pendingNudge: false,
  }), false);
  assert.strictEqual(shouldNudgeForGuidance({
    hasGuidance: false, gatheringCount: 2, peopleCount: 0, weeksTracked: 5, pendingNudge: false,
  }), false);
});

test('resolveModel prefers the override when one is set', () => {
  assert.strictEqual(resolveModel('grok-3-mini', 'grok-4-fast'), 'grok-3-mini');
});

test('resolveModel falls back to the default when override is null', () => {
  assert.strictEqual(resolveModel(null, 'grok-4-fast'), 'grok-4-fast');
});
