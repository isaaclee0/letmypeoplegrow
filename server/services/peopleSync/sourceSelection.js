'use strict';

const providerRegistry = require('./providerRegistry');
const connectionStore = require('./connectionStore');

const PROVIDERS = new Set(['planning_center', 'elvanto']);

function unavailable() {
  const error = new Error('The requested sync source is unavailable. Reconnect the provider and try again.');
  error.code = 'SYNC_SOURCE_UNAVAILABLE';
  return error;
}

function createSourceResolver({ getCredentials = connectionStore.getCredentials, getProvider = providerRegistry.getProvider } = {}) {
  return async function resolveVisibleSource({ churchId, provider, sourceKind, sourceExternalId } = {}) {
    if (!churchId || !PROVIDERS.has(provider) || typeof sourceKind !== 'string' ||
        !sourceKind.trim() || typeof sourceExternalId !== 'string' || !sourceExternalId.trim()) {
      throw unavailable();
    }

    try {
      const credentials = await getCredentials(churchId, provider);
      if (!credentials) throw unavailable();
      const sources = await getProvider(provider).listSources({ churchId, credentials });
      const match = Array.isArray(sources) && sources.find((source) => source &&
        source.kind === sourceKind && source.externalId === sourceExternalId);
      if (!match) throw unavailable();
      return match;
    } catch (error) {
      if (error?.code === 'SYNC_SOURCE_UNAVAILABLE') throw error;
      throw unavailable();
    }
  };
}

const resolveVisibleSource = createSourceResolver();

module.exports = { createSourceResolver, resolveVisibleSource };
