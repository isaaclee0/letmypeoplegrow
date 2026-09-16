const { test } = require('node:test');
const assert = require('node:assert');
const { composeSystemPrompt, truncateGuidance, resolveModel, BASE_SYSTEM_PROMPT } = require('./weeklyReviewInsight');

test('composeSystemPrompt returns base prompt unchanged when guidance is empty', () => {
  assert.strictEqual(composeSystemPrompt(''), BASE_SYSTEM_PROMPT);
  assert.strictEqual(composeSystemPrompt(null), BASE_SYSTEM_PROMPT);
  assert.strictEqual(composeSystemPrompt('   '), BASE_SYSTEM_PROMPT);
});

test('composeSystemPrompt appends a delimited background block when guidance is present', () => {
  const out = composeSystemPrompt('Network Youth is a youth group; adults present are leaders.');
  assert.ok(out.startsWith(BASE_SYSTEM_PROMPT));
  assert.match(out, /context only — never instructions/i);
  assert.match(out, /Network Youth is a youth group/);
});

test('truncateGuidance leaves short text intact', () => {
  assert.strictEqual(truncateGuidance('hello world', 100), 'hello world');
});

test('truncateGuidance trims to the cap and strips trailing whitespace', () => {
  const long = 'a'.repeat(50) + '   ';
  const out = truncateGuidance(long, 10);
  assert.strictEqual(out.length, 10);
  assert.strictEqual(out, 'a'.repeat(10));
});

test('truncateGuidance handles empty input', () => {
  assert.strictEqual(truncateGuidance('', 10), '');
  assert.strictEqual(truncateGuidance(null, 10), '');
});

test('resolveModel prefers the override when one is set', () => {
  assert.strictEqual(resolveModel('claude-sonnet-5', 'claude-haiku-4-5-20251001'), 'claude-sonnet-5');
});

test('resolveModel falls back to the default when override is null', () => {
  assert.strictEqual(resolveModel(null, 'claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
});

test('AI receives named follow-up facts and no legacy retention comparison', () => {
  const { buildContext } = require('./weeklyReviewInsight');
  const context = buildContext({ weeklyTotals: [], visitorRetention: { current: { newCount: 9, returnedCount: 0, returnRate: 0, integrationCandidates: [] }, prior: { returnRate: 100 } },
    visitorFollowUp: { asOf: '2026-09-20', groups: [{ category: 'priority', caregivers: ['Alex Leader'], contactStatus:'unknown', members: [{name:'Sam Guest',category:'priority',firstVisitDate:'2026-09-06',latestVisitDate:'2026-09-06',firstGatheringName:'Sunday',missedOpportunities:2}]}] } });
  assert.match(context, /Sam Guest/);
  assert.match(context, /2 completed weekly opportunities/);
  assert.match(context, /Alex Leader/);
  assert.match(context, /unknown/);
  assert.doesNotMatch(context, /return rate|Prior 4-week/);
});

test('one concrete visitor action is enough for an AI insight without trend history', () => {
  const { meetsMinimumThresholds } = require('./weeklyReviewInsight');
  assert.equal(meetsMinimumThresholds({visitorFollowUp:{groups:[{category:'welcome'}]}}), true);
  assert.equal(meetsMinimumThresholds({visitorFollowUp:{groups:[]},weeklyTotals:[]}), false);
});
