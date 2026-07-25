const REQUIRED = ['validateConnection', 'fetchSnapshot', 'fetchMetadata', 'validateFilter', 'isEligible'];
const adapters = new Map();

function validateAdapter(adapter) {
  const provider = adapter?.provider;
  for (const method of REQUIRED) {
    if (typeof adapter?.[method] !== 'function') {
      throw new Error(`Provider ${provider} missing ${method}`);
    }
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
