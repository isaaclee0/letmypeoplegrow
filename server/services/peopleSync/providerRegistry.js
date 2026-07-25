const REQUIRED = ['validateConnection', 'fetchSnapshot', 'fetchMetadata', 'validateFilter', 'isEligible'];
const PROVIDERS = new Set(['planning_center', 'elvanto']);
const ALLOWED_KEYS = new Set(['provider', ...REQUIRED]);
const adapters = new Map();

function validateAdapter(adapter) {
  if (!Object.prototype.hasOwnProperty.call(adapter || {}, 'provider')) {
    throw new Error('Provider must define own provider');
  }
  const provider = adapter?.provider;
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported provider: ${provider}`);
  for (const method of REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(adapter, method) || typeof adapter[method] !== 'function') {
      throw new Error(`Provider ${provider} missing ${method}`);
    }
  }
  for (const key of Object.getOwnPropertyNames(adapter)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`Provider ${provider} has unexpected ${key}`);
  }
  if (Object.getOwnPropertySymbols(adapter).length > 0) {
    throw new Error(`Provider ${provider} has unexpected symbol property`);
  }
}

function registerProvider(name, adapter) {
  if (adapter?.provider !== name) throw new Error(`Adapter provider mismatch: ${name}`);
  validateAdapter(adapter);
  if (adapters.has(name)) throw new Error(`Provider already registered: ${name}`);
  adapters.set(name, Object.freeze(adapter));
}

function getProvider(name) {
  const adapter = adapters.get(name);
  if (!adapter) throw new Error(`Unknown provider: ${name}`);
  return adapter;
}

// Wires both real providers (Planning Center, Elvanto) into this module's
// one live registry, for production startup to call exactly once (e.g. from
// server/index.js's boot sequence). pcoAdapter.js and elvanto/adapter.js
// both deliberately do NOT call registerProvider() at require time (see
// each module's own header note) specifically so this is the one place
// responsible for real registration.
//
// Idempotent per-provider (checks `adapters.has(name)` before registering,
// rather than a single "have I run yet" flag) rather than throwing on a
// second call: a production process may reasonably call this more than
// once (e.g. a hot-reload path, or two independent boot steps that both
// want to guarantee providers are registered before use), and re-registering
// an already-registered provider must never crash startup. This does NOT
// change registerProvider()'s own duplicate-registration guard above, which
// is what protects a genuinely buggy caller trying to register a SECOND,
// DIFFERENT adapter under a name that's already taken.
//
// Test isolation: node:test runs each test file in its own process by
// default, so every *.test.js file that requires this module already gets
// a fresh, empty `adapters` map with no extra setup needed — this function
// is simply never called by a test that wants to exercise registerProvider/
// getProvider/validateAdapter against a known-empty registry (see
// providerRegistry.test.js, which is unaffected by this addition since it
// never calls registerBuiltInProviders()).
function registerBuiltInProviders() {
  if (!adapters.has('planning_center')) {
    const { createPcoAdapter } = require('./pcoAdapter');
    registerProvider('planning_center', createPcoAdapter());
  }
  if (!adapters.has('elvanto')) {
    const { createElvantoAdapter } = require('../elvanto/adapter');
    registerProvider('elvanto', createElvantoAdapter());
  }
}

module.exports = { registerProvider, getProvider, validateAdapter, registerBuiltInProviders };
