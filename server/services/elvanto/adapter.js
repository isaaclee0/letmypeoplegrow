'use strict';

const { createElvantoClient } = require('./httpClient');
const { listElvantoSources, fetchElvantoSourceSnapshot, fetchElvantoAllSnapshot } = require('./sourceAdapter');

const PEOPLE_PATH = '/people/getAll.json';

// The source-era adapter intentionally does not expose the legacy filter and
// full-roster methods. The provider registry/runtime migration owns adapting
// their callers; source reads must be provider-owned from the outset.
function createElvantoAdapter(deps = {}) {
  const clientFactory = deps.clientFactory || createElvantoClient;
  const resolved = {
    async validateConnection(apiKey) {
      const client = clientFactory({ apiKey });
      await client.get(PEOPLE_PATH, { page: 1, page_size: 10 });
      return { ok: true, metadata: { connectionLabel: 'Connected via API key' } };
    },
    async listSources({ apiKey }) {
      return listElvantoSources({ client: clientFactory({ apiKey }) });
    },
    async fetchSourceSnapshot({ apiKey, sourceKind, sourceExternalId, signal }) {
      return fetchElvantoSourceSnapshot({
        client: clientFactory({ apiKey }), sourceKind, sourceExternalId, signal,
      });
    },
    async fetchAllSnapshot({ apiKey, signal }) {
      return fetchElvantoAllSnapshot({ client: clientFactory({ apiKey }), signal });
    },
    ...deps,
  };

  return {
    provider: 'elvanto',

    async validateConnection({ credentials } = {}) {
      return resolved.validateConnection(credentials && credentials.apiKey);
    },

    async listSources({ credentials } = {}) {
      return resolved.listSources({ apiKey: credentials && credentials.apiKey });
    },

    async fetchSourceSnapshot({ credentials, sourceKind, sourceExternalId, signal } = {}) {
      const source = {
        apiKey: credentials && credentials.apiKey,
        sourceKind,
        sourceExternalId,
      };
      if (signal !== undefined) source.signal = signal;
      return resolved.fetchSourceSnapshot(source);
    },

    async fetchImportSnapshot({ credentials, selection, signal } = {}) {
      if (selection?.kind === 'all') {
        return resolved.fetchAllSnapshot({ apiKey: credentials && credentials.apiKey, signal });
      }
      return resolved.fetchSourceSnapshot({
        apiKey: credentials && credentials.apiKey,
        sourceKind: selection?.kind,
        sourceExternalId: selection?.externalId,
        signal,
      });
    },

    isLifecycleEligible(person, settings = {}) {
      if (!person || person.state === 'archived' || person.state === 'deceased') return false;
      return person.state !== 'contact' || settings.includeContacts !== false;
    },
  };
}

module.exports = { createElvantoAdapter };
