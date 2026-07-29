// Provider-owned source adapter for Planning Center People.  Lists are read
// exactly as configured in Planning Center; this module deliberately has no
// local membership or field-rule evaluation surface.
const { listPlanningCenterSources, fetchPlanningCenterSourceSnapshot } = require('../planningCenter/sourceAdapter');

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
  async fetchSourceSnapshot({ accessToken, sourceKind, sourceExternalId }) {
    return fetchPlanningCenterSourceSnapshot({ accessToken, sourceKind, sourceExternalId });
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
    async fetchSourceSnapshot({ churchId, sourceKind, sourceExternalId } = {}) {
      return resolved.withPlanningCenterSourceToken(churchId, (accessToken) => resolved.fetchSourceSnapshot({
        accessToken,
        sourceKind,
        sourceExternalId,
      }));
    },
    isLifecycleEligible(person) {
      return !!person && (person.state === 'active' || person.status === 'active');
    },
  };
}

module.exports = { createPcoAdapter };
