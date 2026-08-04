const { test } = require('node:test');
const assert = require('node:assert/strict');

const { registerProvider, getProvider, validateAdapter } = require('./providerRegistry');

function adapter(provider = 'planning_center', overrides = {}) {
  return {
    provider,
    validateConnection() {},
    listSources() {},
    fetchSourceSnapshot() {},
    fetchImportSnapshot() {},
    isLifecycleEligible() {},
    ...overrides,
  };
}

test('registerProvider exposes a frozen adapter that implements the complete contract', () => {
  const registered = adapter('planning_center');

  registerProvider('planning_center', registered);

  assert.equal(getProvider('planning_center'), registered);
  assert.equal(Object.isFrozen(registered), true);
  assert.doesNotThrow(() => validateAdapter(registered));
});

test('registerProvider rejects a duplicate provider name', () => {
  registerProvider('elvanto', adapter('elvanto'));

  assert.throws(
    () => registerProvider('elvanto', adapter('elvanto')),
    { message: 'Provider already registered: elvanto' }
  );
});

test('getProvider rejects unknown providers', () => {
  assert.throws(() => getProvider('missing'), { message: 'Unknown provider: missing' });
});

test('validateAdapter rejects every missing required method', () => {
  const incomplete = adapter('planning_center', { listSources: null });

  assert.throws(
    () => validateAdapter(incomplete),
    { message: 'Provider planning_center missing listSources' }
  );
});

test('registerProvider rejects a mismatched adapter provider', () => {
  assert.throws(
    () => registerProvider('elvanto-secondary', adapter('elvanto')),
    { message: 'Adapter provider mismatch: elvanto-secondary' }
  );
});

for (const method of ['validateConnection', 'listSources', 'fetchSourceSnapshot', 'fetchImportSnapshot', 'isLifecycleEligible']) {
  test(`validateAdapter rejects a missing ${method} method`, () => {
    const incomplete = adapter('planning_center', { [method]: undefined });

    assert.throws(
      () => validateAdapter(incomplete),
      { message: `Provider planning_center missing ${method}` }
    );
  });
}

test('registerProvider only accepts the two supported provider names', () => {
  assert.throws(
    () => registerProvider('test_provider', adapter('test_provider')),
    { message: 'Unsupported provider: test_provider' }
  );
});

test('validateAdapter rejects extra keys so test-only APIs cannot enter production', () => {
  assert.throws(
    () => validateAdapter(adapter('planning_center', { resetForTests() {} })),
    { message: 'Provider planning_center has unexpected resetForTests' }
  );
});

test('provider adapters expose source reads and lifecycle rules only, never local filter evaluation', () => {
  const sourceOnly = adapter('planning_center');
  for (const forbidden of ['validate' + 'Filter', 'evaluate' + 'Filter', 'is' + 'Eligible', 'get' + 'FilterMetadata', 'preview' + 'Filter']) {
    assert.equal(Object.hasOwn(sourceOnly, forbidden), false);
  }
  assert.doesNotThrow(() => validateAdapter(sourceOnly));
});

test('validateAdapter rejects inherited provider and required methods', () => {
  const inheritedProvider = Object.create(adapter('planning_center'));
  assert.throws(
    () => validateAdapter(inheritedProvider),
    { message: 'Provider must define own provider' }
  );

  const inheritedMethod = Object.create(adapter('planning_center'));
  inheritedMethod.provider = 'planning_center';
  assert.throws(
    () => validateAdapter(inheritedMethod),
    { message: 'Provider planning_center missing validateConnection' }
  );
});

test('validateAdapter rejects own symbol properties', () => {
  const testOnlySymbol = Symbol('resetForTests');
  assert.throws(
    () => validateAdapter(adapter('planning_center', { [testOnlySymbol]: () => {} })),
    { message: 'Provider planning_center has unexpected symbol property' }
  );
});
