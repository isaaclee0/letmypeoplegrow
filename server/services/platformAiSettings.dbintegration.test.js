const { test } = require('node:test');
const assert = require('node:assert');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { getModel, setModel, DEFAULT_MODELS } = require('./platformAiSettings');

test('getModel returns null when no override has been set', async () => {
  await withTestChurchDb(async () => {
    assert.strictEqual(await getModel('anthropic'), null);
    assert.strictEqual(await getModel('xai'), null);
  });
});

test('setModel then getModel round-trips a saved override', async () => {
  await withTestChurchDb(async () => {
    await setModel('anthropic', 'claude-sonnet-5');
    assert.strictEqual(await getModel('anthropic'), 'claude-sonnet-5');
    // The other provider is untouched
    assert.strictEqual(await getModel('xai'), null);
  });
});

test('setModel(provider, null) clears an existing override', async () => {
  await withTestChurchDb(async () => {
    await setModel('xai', 'grok-3-mini');
    assert.strictEqual(await getModel('xai'), 'grok-3-mini');
    await setModel('xai', null);
    assert.strictEqual(await getModel('xai'), null);
  });
});

test('setModel overwrites a previous override for the same provider', async () => {
  await withTestChurchDb(async () => {
    await setModel('anthropic', 'claude-haiku-4-5-20251001');
    await setModel('anthropic', 'claude-opus-4-8');
    assert.strictEqual(await getModel('anthropic'), 'claude-opus-4-8');
  });
});

test('getModel throws for an unknown provider', async () => {
  await withTestChurchDb(async () => {
    await assert.rejects(() => getModel('bogus'));
  });
});

test('DEFAULT_MODELS exposes the code-level fallback for both providers', () => {
  assert.strictEqual(DEFAULT_MODELS.anthropic, 'claude-haiku-4-5-20251001');
  assert.strictEqual(DEFAULT_MODELS.xai, 'grok-4-fast');
});
