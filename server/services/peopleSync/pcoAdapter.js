// Provider-owned source adapter for Planning Center People.  Lists are read
// exactly as configured in Planning Center; this module deliberately has no
// local membership or field-rule evaluation surface.
const {
  listPlanningCenterSources,
  fetchPlanningCenterSourceSnapshot,
  fetchPlanningCenterAllSnapshot,
} = require('../planningCenter/sourceAdapter');

const defaultDeps = {
  async withPlanningCenterSourceToken(churchId, operation) {
    return require('../planningCenterSync').withPlanningCenterSourceToken(churchId, operation);
  },
  async validateToken(accessToken) {
    return require('../planningCenterSync').validatePlanningCenterToken(accessToken);
  },
  async listSources({ accessToken }) {
    return listPlanningCenterSources({ accessToken });
  },
  async fetchSourceSnapshot({ accessToken, sourceKind, sourceExternalId, signal }) {
    return fetchPlanningCenterSourceSnapshot({ accessToken, sourceKind, sourceExternalId, signal });
  },
  async fetchAllSnapshot({ accessToken, signal }) {
    return fetchPlanningCenterAllSnapshot({ accessToken, signal });
  },
};

function createPcoAdapter(deps = {}) {
  const resolved = { ...defaultDeps, ...deps };

  return {
    provider: 'planning_center',
    async validateConnection({ credentials } = {}) {
      return resolved.validateToken(credentials && credentials.accessToken);
    },
    async listSources({ churchId } = {}) {
      return resolved.withPlanningCenterSourceToken(
        churchId,
        (accessToken) => resolved.listSources({ accessToken })
      );
    },
    async fetchSourceSnapshot({ churchId, sourceKind, sourceExternalId, signal } = {}) {
      const source = { sourceKind, sourceExternalId };
      if (signal !== undefined) source.signal = signal;
      return resolved.withPlanningCenterSourceToken(churchId, (accessToken) => resolved.fetchSourceSnapshot({ accessToken, ...source }));
    },
    async fetchImportSnapshot({ churchId, selection, signal } = {}) {
      return resolved.withPlanningCenterSourceToken(churchId, (accessToken) => {
        if (selection?.kind === 'all') return resolved.fetchAllSnapshot({ accessToken, signal });
        return resolved.fetchSourceSnapshot({
          accessToken,
          sourceKind: selection?.kind,
          sourceExternalId: selection?.externalId,
          signal,
        });
      });
    },
    isLifecycleEligible(person) {
      return !!person && (person.state === 'active' || person.status === 'active');
    },
  };
}

module.exports = { createPcoAdapter };
