const { test } = require('node:test');
const assert = require('node:assert/strict');

const { registerProvider, getProvider, validateAdapter } = require('./providerRegistry');

function adapter(provider = 'planning_center', overrides = {}) {
  return {
    provider,
    validateConnection() {},
    fetchSnapshot() {},
    fetchMetadata() {},
    validateFilter() {},
    isEligible() {},
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
  const incomplete = adapter('planning_center', { fetchMetadata: null });

  assert.throws(
    () => validateAdapter(incomplete),
    { message: 'Provider planning_center missing fetchMetadata' }
  );
});

test('registerProvider rejects a mismatched adapter provider', () => {
  assert.throws(
    () => registerProvider('elvanto-secondary', adapter('elvanto')),
    { message: 'Adapter provider mismatch: elvanto-secondary' }
  );
});

for (const method of ['validateConnection', 'fetchSnapshot', 'fetchMetadata', 'validateFilter', 'isEligible']) {
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
