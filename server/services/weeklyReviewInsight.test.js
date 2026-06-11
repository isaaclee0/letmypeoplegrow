const { test } = require('node:test');
const assert = require('node:assert');
const { composeSystemPrompt, truncateGuidance, BASE_SYSTEM_PROMPT } = require('./weeklyReviewInsight');

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
