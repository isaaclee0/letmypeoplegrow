// Provider-owned source adapter for Planning Center People.  Lists are read
// exactly as configured in Planning Center; this module deliberately has no
// local membership or field-rule evaluation surface.
const { listPlanningCenterSources, fetchPlanningCenterSourceSnapshot } = require('../planningCenter/sourceAdapter');
const { PcoSourceError } = require('../planningCenter/readClient');

const defaultDeps = {
  async getAccessTokenForChurch(churchId) {
    return require('../planningCenterSync').getAccessTokenForChurch(churchId);
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

  async function freshAccessToken(churchId) {
    const accessToken = await resolved.getAccessTokenForChurch(churchId);
    if (!accessToken) {
      throw new PcoSourceError('Planning Center source credentials are unavailable', 'SYNC_SOURCE_AUTH', {});
    }
    return accessToken;
  }

  return {
    provider: 'planning_center',
    async validateConnection({ credentials } = {}) {
      return resolved.validateToken(credentials && credentials.accessToken);
    },
    async listSources({ churchId } = {}) {
      return resolved.listSources({ accessToken: await freshAccessToken(churchId) });
    },
    async fetchSourceSnapshot({ churchId, sourceKind, sourceExternalId } = {}) {
      return resolved.fetchSourceSnapshot({
        accessToken: await freshAccessToken(churchId),
        sourceKind,
        sourceExternalId,
      });
    },
    isLifecycleEligible(person) {
      return !!person && (person.state === 'active' || person.status === 'active');
    },
  };
}

module.exports = { createPcoAdapter };
