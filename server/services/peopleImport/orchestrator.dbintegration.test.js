'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.SYNC_REVIEW_SECRET = process.env.SYNC_REVIEW_SECRET || 'people-import-orchestrator-db-secret';
process.env.INTEGRATION_CREDENTIALS_KEY = process.env.INTEGRATION_CREDENTIALS_KEY || Buffer.alloc(32, 13).toString('base64');

const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const providerRegistry = require('../peopleSync/providerRegistry');
const connectionStore = require('../peopleSync/connectionStore');
const { previewImport, applyImport } = require('./orchestrator');

let currentSnapshot;
let fetchHook = null;

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function person(id, overrides = {}) {
  return {
    id, firstName: 'Ada', lastName: 'Lovelace', state: 'active', child: false,
    familyId: null, attributes: {}, ...overrides,
  };
}

function importSnapshot(overrides = {}) {
  const people = overrides.people || [person('ext-1')];
  return {
    provider: 'elvanto',
    source: { kind: 'all', externalId: 'all', name: 'Everyone', providerRefreshedAt: null },
    complete: true,
    fetchedAt: new Date().toISOString(),
    providerRefreshedAt: null,
    memberExternalIds: people.map(({ id }) => id),
    people,
    contextPeople: [],
    families: [],
    ...overrides,
  };
}

providerRegistry.registerProvider('elvanto', {
  provider: 'elvanto',
  async validateConnection() { return { ok: true, metadata: {} }; },
  async listSources() { return []; },
  async fetchSourceSnapshot() { throw new Error('people import must not use sync source reads'); },
  async fetchImportSnapshot(input) {
    if (fetchHook) await fetchHook(input);
    return structuredClone(currentSnapshot);
  },
  isLifecycleEligible(value) { return value?.state !== 'archived' && value?.state !== 'deceased'; },
});

async function seedChurch(churchId) {
  if (!(await Database.queryForChurch(churchId, 'SELECT 1 FROM church_settings WHERE church_id = ?', [churchId])).length) {
    await Database.queryForChurch(
      churchId,
      'INSERT INTO church_settings (church_id, church_name) VALUES (?, ?)',
      [churchId, 'Import Test Church']
    );
  }
  await connectionStore.upsertConnection({
    churchId, provider: 'elvanto', authType: 'api_key', credentials: { apiKey: 'test-key' }, metadata: {},
  });
}

function selectionsFor(review) {
  const additions = new Set(review.plan.addPeople.map(({ externalPersonId }) => externalPersonId));
  return {
    decisionContractVersion: 2,
    identityDecisions: Object.fromEntries(
      Object.entries(review.plan.reviewContext.identities).map(([externalPersonId, identity]) => {
        if (Number.isSafeInteger(identity.suggestedIndividualId)) return [externalPersonId, { outcome: 'accept' }];
        if (additions.has(externalPersonId)) return [externalPersonId, { outcome: 'create' }];
        return [externalPersonId, { outcome: 'defer' }];
      })
    ),
  };
}

const selection = { kind: 'all' };

test('one transaction creates families, people, and dormant links and a repeat does not duplicate them', async () => {
  await withTestChurchDb(async (churchId) => {
    fetchHook = null;
    await seedChurch(churchId);
    const ada = person('ada', { familyId: 'house-1' });
    const charles = person('charles', { firstName: 'Charles', familyId: 'house-1' });
    currentSnapshot = importSnapshot({
      people: [ada, charles],
      memberExternalIds: ['ada', 'charles'],
      families: [{
        id: 'house-1', name: 'Lovelace, Ada and Charles',
        memberExternalIds: ['ada', 'charles'], primaryContactExternalId: 'ada',
      }],
    });

    const review = await previewImport({ churchId, provider: 'elvanto', selection });
    const first = await applyImport({
      churchId, provider: 'elvanto', selection, reviewToken: review.reviewToken,
      selections: selectionsFor(review), userId: null,
    });
    assert.equal(first.applied.addFamilies, 1);
    assert.equal(first.applied.addPeople, 2);

    const people = await Database.queryForChurch(
      churchId,
      'SELECT id, family_id, first_name, last_name, people_type FROM individuals WHERE church_id = ? ORDER BY id',
      [churchId]
    );
    const families = await Database.queryForChurch(
      churchId, 'SELECT id, family_name FROM families WHERE church_id = ? ORDER BY id', [churchId]
    );
    const personLinks = await Database.queryForChurch(
      churchId,
      `SELECT external_person_id, individual_id, last_seen_at, missing_full_sync_count
         FROM external_person_links WHERE church_id = ? AND provider = 'elvanto' ORDER BY external_person_id`,
      [churchId]
    );
    const familyLinks = await Database.queryForChurch(
      churchId,
      `SELECT external_family_id, family_id, last_seen_at
         FROM external_family_links WHERE church_id = ? AND provider = 'elvanto'`,
      [churchId]
    );
    assert.equal(people.length, 2);
    assert.equal(families.length, 1);
    assert.ok(people.every((row) => Number(row.family_id) === Number(families[0].id)));
    assert.deepEqual(personLinks.map((row) => ({
      externalId: row.external_person_id,
      individualId: Number(row.individual_id),
      lastSeenAt: row.last_seen_at,
      missingCount: Number(row.missing_full_sync_count),
    })), [
      { externalId: 'ada', individualId: Number(people[0].id), lastSeenAt: null, missingCount: 0 },
      { externalId: 'charles', individualId: Number(people[1].id), lastSeenAt: null, missingCount: 0 },
    ]);
    assert.deepEqual(familyLinks, [{
      external_family_id: 'house-1', family_id: families[0].id, last_seen_at: null,
    }]);

    const repeatReview = await previewImport({ churchId, provider: 'elvanto', selection });
    const repeat = await applyImport({
      churchId, provider: 'elvanto', selection, reviewToken: repeatReview.reviewToken,
      selections: selectionsFor(repeatReview), userId: null,
    });
    assert.equal(repeat.applied.addPeople, 0);
    assert.equal(repeat.applied.addFamilies, 0);
    for (const table of ['individuals', 'families', 'external_person_links', 'external_family_links']) {
      const [row] = await Database.queryForChurch(
        churchId, `SELECT COUNT(*) AS count FROM ${table} WHERE church_id = ?`, [churchId]
      );
      assert.equal(Number(row.count), table.includes('person') || table === 'individuals' ? 2 : 1);
    }

    for (const table of ['people_sync_batches', 'gathering_types', 'gathering_lists', 'people_sync_authority_preview_intents']) {
      const [row] = await Database.queryForChurch(
        churchId, `SELECT COUNT(*) AS count FROM ${table} WHERE church_id = ?`, [churchId]
      );
      assert.equal(Number(row.count), 0, `${table} must remain empty`);
    }
    const runs = await Database.queryForChurch(
      churchId,
      `SELECT batch_id, trigger, status, source_provenance
         FROM people_sync_runs WHERE church_id = ? ORDER BY id`,
      [churchId]
    );
    assert.deepEqual(runs.map((row) => ({
      batchId: row.batch_id,
      trigger: row.trigger,
      status: row.status,
      sourceKind: JSON.parse(row.source_provenance)[0]?.sourceKind,
    })), [
      { batchId: null, trigger: 'people_import', status: 'review_required', sourceKind: 'all' },
      { batchId: null, trigger: 'people_import', status: 'applied', sourceKind: 'all' },
      { batchId: null, trigger: 'people_import', status: 'review_required', sourceKind: 'all' },
      { batchId: null, trigger: 'people_import', status: 'applied', sourceKind: 'all' },
    ]);
    const [claims] = await Database.queryForChurch(
      churchId,
      'SELECT COUNT(*) AS count FROM people_sync_review_applications WHERE church_id = ? AND provider = ?',
      [churchId, 'elvanto']
    );
    assert.equal(Number(claims.count), 2);
  });
});

test('an active authority forces imported people to visitors', async () => {
  await withTestChurchDb(async (churchId) => {
    fetchHook = null;
    await seedChurch(churchId);
    await Database.queryForChurch(
      churchId,
      `UPDATE people_sync_settings SET authority_provider = 'planning_center' WHERE church_id = ?`,
      [churchId]
    );
    currentSnapshot = importSnapshot();
    const review = await previewImport({ churchId, provider: 'elvanto', selection });
    await applyImport({
      churchId, provider: 'elvanto', selection, reviewToken: review.reviewToken,
      selections: selectionsFor(review), userId: null,
    });
    const [created] = await Database.queryForChurch(
      churchId, 'SELECT people_type FROM individuals WHERE church_id = ?', [churchId]
    );
    assert.equal(created.people_type, 'local_visitor');
  });
});

for (const authorityChange of [
  {
    name: 'pending authority',
    beforePreview: null,
    afterPreview: `UPDATE people_sync_settings
      SET pending_authority_provider = 'planning_center' WHERE church_id = ?`,
  },
  {
    name: 'active authority with otherwise identical import actions',
    beforePreview: `UPDATE people_sync_settings
      SET authority_provider = 'planning_center' WHERE church_id = ?`,
    afterPreview: `UPDATE people_sync_settings
      SET authority_provider = 'elvanto' WHERE church_id = ?`,
  },
]) {
  test(`a changed ${authorityChange.name} rejects the reviewed import without writes`, async () => {
    await withTestChurchDb(async (churchId) => {
      fetchHook = null;
      await seedChurch(churchId);
      if (authorityChange.beforePreview) {
        await Database.queryForChurch(churchId, authorityChange.beforePreview, [churchId]);
      }
      currentSnapshot = importSnapshot();
      const review = await previewImport({ churchId, provider: 'elvanto', selection });
      await Database.queryForChurch(churchId, authorityChange.afterPreview, [churchId]);

      await assert.rejects(
        applyImport({
          churchId, provider: 'elvanto', selection, reviewToken: review.reviewToken,
          selections: selectionsFor(review), userId: null,
        }),
        { code: 'SYNC_PLAN_STALE' }
      );

      const [people] = await Database.queryForChurch(
        churchId, 'SELECT COUNT(*) AS count FROM individuals WHERE church_id = ?', [churchId]
      );
      const [claims] = await Database.queryForChurch(
        churchId, 'SELECT COUNT(*) AS count FROM people_sync_review_applications WHERE church_id = ?', [churchId]
      );
      assert.equal(Number(people.count), 0);
      assert.equal(Number(claims.count), 0);
    });
  });
}

test('selected-source preview and apply runs retain batchless provider provenance', async () => {
  await withTestChurchDb(async (churchId) => {
    fetchHook = null;
    await seedChurch(churchId);
    currentSnapshot = importSnapshot({
      source: {
        kind: 'elvanto_group', externalId: 'group-42', name: 'Youth Group', providerRefreshedAt: null,
      },
    });
    const selected = { kind: 'elvanto_group', externalId: 'group-42' };
    const review = await previewImport({ churchId, provider: 'elvanto', selection: selected });
    await applyImport({
      churchId, provider: 'elvanto', selection: selected, reviewToken: review.reviewToken,
      selections: selectionsFor(review), userId: null,
    });

    const runs = await Database.queryForChurch(
      churchId,
      `SELECT trigger, source_provenance
         FROM people_sync_runs WHERE church_id = ? ORDER BY id`,
      [churchId]
    );
    assert.deepEqual(runs.map((row) => {
      const [source] = JSON.parse(row.source_provenance);
      return {
        trigger: row.trigger,
        batchId: source?.batchId,
        sourceKind: source?.sourceKind,
        sourceExternalId: source?.sourceExternalId,
        sourceName: source?.sourceName,
      };
    }), [
      {
        trigger: 'people_import', batchId: null, sourceKind: 'elvanto_group',
        sourceExternalId: 'group-42', sourceName: 'Youth Group',
      },
      {
        trigger: 'people_import', batchId: null, sourceKind: 'elvanto_group',
        sourceExternalId: 'group-42', sourceName: 'Youth Group',
      },
    ]);
  });
});

test('a review token cannot cross churches and its rejection leaves no writes', async () => {
  await withTestChurchDb(async (churchId) => {
    fetchHook = null;
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    await seedChurch(churchId);
    await seedChurch(otherChurchId);
    currentSnapshot = importSnapshot();
    const review = await previewImport({ churchId, provider: 'elvanto', selection });

    await assert.rejects(
      applyImport({
        churchId: otherChurchId, provider: 'elvanto', selection, reviewToken: review.reviewToken,
        selections: selectionsFor(review), userId: null,
      }),
      { code: 'SYNC_REVIEW_INVALID' }
    );
    const [people] = await Database.queryForChurch(
      otherChurchId, 'SELECT COUNT(*) AS count FROM individuals WHERE church_id = ?', [otherChurchId]
    );
    const [claims] = await Database.queryForChurch(
      otherChurchId, 'SELECT COUNT(*) AS count FROM people_sync_review_applications WHERE church_id = ?', [otherChurchId]
    );
    assert.equal(Number(people.count), 0);
    assert.equal(Number(claims.count), 0);
  });
});

test('a stale local identity rejects before import writes and token claim', async () => {
  await withTestChurchDb(async (churchId) => {
    fetchHook = null;
    await seedChurch(churchId);
    currentSnapshot = importSnapshot();
    const review = await previewImport({ churchId, provider: 'elvanto', selection });
    await Database.queryForChurch(
      churchId,
      `INSERT INTO individuals (church_id, first_name, last_name, people_type, is_active, is_child)
       VALUES (?, 'Local', 'Change', 'regular', 1, 0)`,
      [churchId]
    );

    await assert.rejects(
      applyImport({
        churchId, provider: 'elvanto', selection, reviewToken: review.reviewToken,
        selections: selectionsFor(review), userId: null,
      }),
      { code: 'SYNC_PLAN_STALE' }
    );
    const people = await Database.queryForChurch(
      churchId, 'SELECT first_name FROM individuals WHERE church_id = ? ORDER BY id', [churchId]
    );
    const [claims] = await Database.queryForChurch(
      churchId, 'SELECT COUNT(*) AS count FROM people_sync_review_applications WHERE church_id = ?', [churchId]
    );
    assert.deepEqual(people, [{ first_name: 'Local' }]);
    assert.equal(Number(claims.count), 0);
  });
});

test('authority changed during the fresh provider read rolls back the reviewed transaction', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedChurch(churchId);
    currentSnapshot = importSnapshot();
    fetchHook = null;
    const review = await previewImport({ churchId, provider: 'elvanto', selection });
    let changed = false;
    fetchHook = async () => {
      if (changed) return;
      changed = true;
      await Database.queryForChurch(
        churchId,
        `UPDATE people_sync_settings SET pending_authority_provider = 'planning_center' WHERE church_id = ?`,
        [churchId]
      );
    };

    await assert.rejects(
      applyImport({
        churchId, provider: 'elvanto', selection, reviewToken: review.reviewToken,
        selections: selectionsFor(review), userId: null,
      }),
      { code: 'SYNC_PLAN_STALE' }
    );
    const [people] = await Database.queryForChurch(
      churchId, 'SELECT COUNT(*) AS count FROM individuals WHERE church_id = ?', [churchId]
    );
    const [claims] = await Database.queryForChurch(
      churchId, 'SELECT COUNT(*) AS count FROM people_sync_review_applications WHERE church_id = ?', [churchId]
    );
    assert.equal(Number(people.count), 0);
    assert.equal(Number(claims.count), 0);
    fetchHook = null;
  });
});

test('a route cancellation while the apply provider read is in flight leaves no import writes or token claim', async () => {
  await withTestChurchDb(async (churchId) => {
    fetchHook = null;
    await seedChurch(churchId);
    currentSnapshot = importSnapshot();
    const review = await previewImport({ churchId, provider: 'elvanto', selection });
    const providerReadStarted = deferred();
    const releaseProviderRead = deferred();
    let applySignal;
    fetchHook = async ({ signal }) => {
      applySignal = signal;
      providerReadStarted.resolve();
      await releaseProviderRead.promise;
    };
    const controller = new AbortController();
    const applying = applyImport({
      churchId,
      provider: 'elvanto',
      selection,
      reviewToken: review.reviewToken,
      selections: selectionsFor(review),
      userId: null,
      signal: controller.signal,
    });
    await providerReadStarted.promise;
    controller.abort();
    releaseProviderRead.resolve();

    try {
      await assert.rejects(applying, { code: 'SYNC_ROUTE_TIMEOUT', status: 503 });
      assert.equal(applySignal, controller.signal);
      for (const table of [
        'individuals',
        'families',
        'external_person_links',
        'external_family_links',
        'people_sync_review_applications',
      ]) {
        const [row] = await Database.queryForChurch(
          churchId, `SELECT COUNT(*) AS count FROM ${table} WHERE church_id = ?`, [churchId]
        );
        assert.equal(Number(row.count), 0, `${table} must remain empty after cancellation`);
      }
      const runs = await Database.queryForChurch(
        churchId,
        `SELECT status, error_code
           FROM people_sync_runs
          WHERE church_id = ? AND trigger = 'people_import'
          ORDER BY id`,
        [churchId]
      );
      assert.deepEqual(runs, [
        { status: 'review_required', error_code: null },
        { status: 'failed', error_code: 'SYNC_ROUTE_TIMEOUT' },
      ]);
      assert.equal(runs.some(({ status }) => status === 'applied'), false);
    } finally {
      fetchHook = null;
    }
  });
});
