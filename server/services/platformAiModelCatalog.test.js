const { test } = require('node:test');
const assert = require('node:assert');
const { isChatModel, mapAnthropicModel, mapXaiModel } = require('./platformAiModelCatalog');

test('isChatModel accepts ordinary chat model ids', () => {
  assert.strictEqual(isChatModel('grok-4-fast'), true);
  assert.strictEqual(isChatModel('grok-3-mini'), true);
});

test('isChatModel rejects image and embedding model ids', () => {
  assert.strictEqual(isChatModel('grok-2-image'), false);
  assert.strictEqual(isChatModel('grok-2-image-1212'), false);
  assert.strictEqual(isChatModel('text-embedding-3-small'), false);
});

test('mapAnthropicModel prefers display_name, falls back to id', () => {
  assert.deepStrictEqual(
    mapAnthropicModel({ id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' }),
    { id: 'claude-opus-4-8', displayName: 'Claude Opus 4.8' }
  );
  assert.deepStrictEqual(
    mapAnthropicModel({ id: 'claude-opus-4-8' }),
    { id: 'claude-opus-4-8', displayName: 'claude-opus-4-8' }
  );
});

test('mapXaiModel uses id as displayName', () => {
  assert.deepStrictEqual(mapXaiModel({ id: 'grok-4-fast' }), { id: 'grok-4-fast', displayName: 'grok-4-fast' });
});
