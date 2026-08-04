const {
  BUCKETS,
  computePeopleSyncPlan,
  projectAdditiveImportPlan,
} = require('../peopleSync/plan');

const ADDITIVE_IMPORT_BUCKETS = new Set([
  'linkPeople', 'linkFamilies', 'addPeople', 'addFamilies', 'ambiguousPeople',
  'familyConflicts', 'skipped',
]);

const FORBIDDEN_IMPORT_BUCKETS = new Set([
  'updateManagedFields', 'promoteToRegular', 'demoteToLocalVisitor', 'archive',
  'reactivate', 'moveFamily', 'renameFamily', 'addToGathering', 'removeFromGathering',
  'unmatchedLocalRegulars',
]);

const PLAN_METADATA_KEYS = new Set([
  'provider', 'authoritative', 'operationKind', 'snapshot', 'presenceProjection',
]);

function assertAdditiveImportPlan(plan) {
  if (plan?.operationKind !== 'people_import') {
    throw new TypeError('Import plan operationKind must be people_import');
  }
  if (plan.authoritative !== false) {
    throw new TypeError('Import plan authoritative must be false');
  }
  for (const bucket of BUCKETS) {
    if (!Array.isArray(plan[bucket])) throw new TypeError(`Import plan bucket ${bucket} must be an array`);
    if (ADDITIVE_IMPORT_BUCKETS.has(bucket)) continue;
    if (!FORBIDDEN_IMPORT_BUCKETS.has(bucket)) {
      throw new TypeError(`Import plan bucket ${bucket} must be explicitly classified`);
    }
    if (plan[bucket].length > 0) {
      throw new TypeError(`Import plan cannot contain ${bucket} actions`);
    }
  }
  for (const [key, value] of Object.entries(plan)) {
    if (!PLAN_METADATA_KEYS.has(key) && !BUCKETS.includes(key) && value !== null && value !== undefined) {
      throw new TypeError(`Import plan cannot contain ${key} actions`);
    }
  }
}

function computePeopleImportPlan(input = {}) {
  const eligible = new Set((input.memberExternalIds || []).map(String));
  const syncPlan = computePeopleSyncPlan({
    ...input,
    authoritative: true,
    activeAuthority: input.authorityProvider,
    trigger: 'manual',
    batches: [{ id: 1, enabled: true, defaultPeopleType: 'regular', gatheringTypeId: null }],
    eligibleByBatch: new Map([[1, eligible]]),
  });
  const plan = projectAdditiveImportPlan(syncPlan, input.authorityProvider);
  assertAdditiveImportPlan(plan);
  return plan;
}

module.exports = { computePeopleImportPlan, assertAdditiveImportPlan };
