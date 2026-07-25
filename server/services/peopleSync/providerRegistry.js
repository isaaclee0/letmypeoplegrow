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

module.exports = { registerProvider, getProvider, validateAdapter };
