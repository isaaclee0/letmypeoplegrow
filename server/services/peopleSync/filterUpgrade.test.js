'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  convertV1Filter,
  evaluateLegacyFacts,
  compareUpgradeSets,
  createUpgradeToken,
  verifyUpgradeToken,
  applyCompatibleUpgrades,
} = require('./filterUpgrade');
const { evaluateFilterV2 } = require('./filterEngine');
const { digestFilterConfig, createReviewToken } = require('./planDigest');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { createBatch, getBatch } = require('./batchRepository');

const pcoConfig = {
  membershipFilterEnabled: true,
  membershipAllowlist: ['Member', '(none)', 'none of these'],
  fieldFilterEnabled: true,
  fieldFilters: [
    { fieldDefinitionId: 'youth', values: ['yes'] },
    { fieldDefinitionId: 'camp', values: ['(none)'] },
  ],
};

const elvantoConfig = {
  statuses: ['active'], categoryIds: ['members'],
  groups: { ids: ['music', 'youth'], operator: 'all' },
  demographics: { values: [], operator: 'any' },
  departments: { values: ['Welcome'], operator: 'any' },
  serviceTypes: { ids: ['sunday'], operator: 'all' },
  locations: { ids: [], operator: 'any' },
  customFields: [{ fieldId: 'role', values: ['leader', 'helper'], operator: 'all' }],
};

async function withSecret(value, callback) {
  const oldReview = process.env.SYNC_REVIEW_SECRET;
  const oldJwt = process.env.JWT_SECRET;
  process.env.SYNC_REVIEW_SECRET = value;
  delete process.env.JWT_SECRET;
  try {
    return await callback();
  } finally {
    if (oldReview === undefined) delete process.env.SYNC_REVIEW_SECRET;
    else process.env.SYNC_REVIEW_SECRET = oldReview;
    if (oldJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwt;
  }
}

function atUnixSecond(second, callback) {
  const oldNow = Date.now;
  Date.now = () => second * 1000;
  try {
    return callback();
  } finally {
    Date.now = oldNow;
  }
}

function upgradeContext(overrides = {}) {
  return {
    churchId: 'church-a', provider: 'elvanto', batchId: 7,
    filterRevision: 4,
    activeConfigDigest: digestFilterConfig(elvantoConfig),
    snapshotId: 'snapshot-1', convertedDigest: digestFilterConfig(convertV1Filter('elvanto', elvantoConfig)),
    compatible: true,
    ...overrides,
  };
}

test('converts PCO sources into their historical OR branches and canonical missing values', () => {
  const converted = convertV1Filter('planning_center', pcoConfig);
  assert.deepEqual(converted, {
    branches: [
      { groups: [{ dimensionId: 'membership', mode: 'any', values: ['$not_set', 'Member', 'none of these'] }] },
      { groups: [
        { dimensionId: 'custom_field:camp', mode: 'any', values: ['$not_set'] },
        { dimensionId: 'custom_field:youth', mode: 'any', values: ['yes'] },
      ] },
    ],
    exclusions: [],
  });
  assert.deepEqual(convertV1Filter('planning_center', {
    membershipFilterEnabled: true, membershipAllowlist: [], fieldFilterEnabled: true, fieldFilters: [],
  }), { branches: [], exclusions: [] });
});

test('merges repeated legacy PCO custom-field rules without producing an invalid duplicate v2 group', () => {
  const converted = convertV1Filter('planning_center', {
    membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: true,
    fieldFilters: [
      { fieldDefinitionId: 'camp', values: ['north', 'south'] },
      { fieldDefinitionId: 'camp', values: ['south', 'west'] },
    ],
  });
  assert.deepEqual(converted, {
    branches: [{ groups: [{ dimensionId: 'custom_field:camp', mode: 'any', values: ['south'] }] }],
    exclusions: [],
  });
});

test('converts Elvanto populated dimensions into one AND branch preserving operators', () => {
  assert.deepEqual(convertV1Filter('elvanto', elvantoConfig), {
    branches: [{ groups: [
      { dimensionId: 'category', mode: 'any', values: ['members'] },
      { dimensionId: 'custom_field:role', mode: 'all', values: ['helper', 'leader'] },
      { dimensionId: 'departments', mode: 'any', values: ['Welcome'] },
      { dimensionId: 'groups', mode: 'all', values: ['music', 'youth'] },
      { dimensionId: 'service_types', mode: 'all', values: ['sunday'] },
      { dimensionId: 'status', mode: 'any', values: ['active'] },
    ] }],
    exclusions: [],
  });
});

test('legacy and converted filters select the identical external-ID set without exposing it', () => {
  const pcoFacts = [
    { externalPersonId: 'a', dimensions: { membership: ['Member'] } },
    { externalPersonId: 'b', dimensions: { 'custom_field:youth': ['yes'], 'custom_field:camp': [] } },
    { externalPersonId: 'c', dimensions: { membership: ['Visitor'] } },
  ];
  const compared = compareUpgradeSets({ provider: 'planning_center', config: pcoConfig, facts: pcoFacts });
  assert.deepEqual(compared, { oldCount: 2, newCount: 2, compatible: true });
  assert.equal(Object.hasOwn(compared, 'oldIds'), false);
  assert.equal(Object.hasOwn(compared, 'newIds'), false);

  const mismatch = compareUpgradeSets({
    provider: 'planning_center', config: {
      membershipFilterEnabled: true, membershipAllowlist: ['Member'], fieldFilterEnabled: false, fieldFilters: [],
    },
    facts: [
      { externalPersonId: 'one', dimensions: { membership: ['Member'] } },
      { externalPersonId: 'two', dimensions: {} },
    ],
    convertedConfig: { branches: [{ groups: [{ dimensionId: 'membership', mode: 'any', values: ['$not_set'] }] }], exclusions: [] },
  });
  assert.deepEqual(mismatch, { oldCount: 1, newCount: 1, compatible: false });
});

test('legacy fact evaluation agrees with the converted Elvanto filter', () => {
  const converted = convertV1Filter('elvanto', elvantoConfig);
  const matches = { externalPersonId: 'yes', dimensions: {
    status: ['active'], category: ['members'], groups: ['music', 'youth'], departments: ['Welcome'],
    service_types: ['sunday'], 'custom_field:role': ['leader', 'helper'],
  } };
  const misses = { ...matches, externalPersonId: 'no', dimensions: { ...matches.dimensions, groups: ['music'] } };
  assert.equal(evaluateLegacyFacts('elvanto', matches, elvantoConfig), evaluateFilterV2(matches, converted));
  assert.equal(evaluateLegacyFacts('elvanto', misses, elvantoConfig), evaluateFilterV2(misses, converted));
});

test('upgrade tokens bind every upgrade review field, expire after 30 minutes, and reject review tokens', () => withSecret('upgrade-secret', () => {
  const context = upgradeContext();
  const token = atUnixSecond(1000, () => createUpgradeToken(context));
  atUnixSecond(1000, () => {
    assert.equal(verifyUpgradeToken(token, context).ok, true);
    assert.equal(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).kind, 'filter_upgrade');
    for (const [key, value] of Object.entries({
      churchId: 'church-b', provider: 'planning_center', batchId: 8, filterRevision: 5,
      activeConfigDigest: 'a'.repeat(64), snapshotId: 'snapshot-2', convertedDigest: 'b'.repeat(64), compatible: false,
    })) {
      assert.deepEqual(verifyUpgradeToken(token, { ...context, [key]: value }), { ok: false, code: 'SYNC_UPGRADE_INVALID' }, key);
    }
  });
  assert.deepEqual(atUnixSecond(2800, () => verifyUpgradeToken(token, context)), { ok: false, code: 'SYNC_UPGRADE_EXPIRED' });
  const reviewToken = atUnixSecond(1000, () => createReviewToken({
    churchId: context.churchId, provider: context.provider, batchId: context.batchId,
    planDigest: 'c'.repeat(64), expiresInSeconds: 900,
  }));
  assert.deepEqual(atUnixSecond(1000, () => verifyUpgradeToken(reviewToken, context)), { ok: false, code: 'SYNC_UPGRADE_INVALID' });
}));

test('compatible upgrades verify every re-read row and cache snapshot before atomically changing any batch', async () => withSecret('upgrade-secret', async () => {
  await withTestChurchDb(async (churchId) => {
    const first = await createBatch({ churchId, provider: 'elvanto', name: 'First', filterConfig: elvantoConfig });
    const second = await createBatch({ churchId, provider: 'elvanto', name: 'Second', filterConfig: { ...elvantoConfig, groups: { ids: ['music'], operator: 'any' } } });
    const facts = [{ externalPersonId: 'person-1', dimensions: {
      status: ['active'], category: ['members'], groups: ['music', 'youth'], departments: ['Welcome'],
      service_types: ['sunday'], 'custom_field:role': ['leader', 'helper'],
    } }];
    const cache = { get(requestChurchId, provider) {
      assert.equal(requestChurchId, churchId);
      assert.equal(provider, 'elvanto');
      return { churchId, provider, snapshotId: 'snapshot-atomic', facts };
    } };
    const tokenFor = (batch) => createUpgradeToken({
      churchId, provider: 'elvanto', batchId: batch.id, filterRevision: batch.filterRevision,
      activeConfigDigest: digestFilterConfig(batch.filterConfig), snapshotId: 'snapshot-atomic',
      convertedDigest: digestFilterConfig(convertV1Filter('elvanto', batch.filterConfig)), compatible: true,
    });
    const firstToken = tokenFor(first);
    const staleSecondToken = tokenFor(second);
    await Database.queryForChurch(churchId, 'UPDATE people_sync_batches SET filter_revision = filter_revision + 1 WHERE id = ?', [second.id]);

    await assert.rejects(applyCompatibleUpgrades({
      churchId, provider: 'elvanto', cache,
      upgrades: [{ batchId: first.id, upgradeToken: firstToken }, { batchId: second.id, upgradeToken: staleSecondToken }],
    }), (error) => error && error.code === 'SYNC_UPGRADE_STALE');
    assert.equal((await getBatch(churchId, 'elvanto', first.id)).filterSchemaVersion, 1);

    const currentSecond = await getBatch(churchId, 'elvanto', second.id);
    const result = await applyCompatibleUpgrades({
      churchId, provider: 'elvanto', cache,
      upgrades: [{ batchId: first.id, upgradeToken: firstToken }, { batchId: second.id, upgradeToken: tokenFor(currentSecond) }],
    });
    assert.deepEqual(result.map((batch) => [batch.id, batch.filterSchemaVersion, batch.filterRevision]), [
      [first.id, 2, 2], [second.id, 2, 3],
    ]);
  });
}));
