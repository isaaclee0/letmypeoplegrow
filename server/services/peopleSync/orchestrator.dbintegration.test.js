'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const providerRegistry = require('./providerRegistry');
const connectionStore = require('./connectionStore');
const batchRepository = require('./batchRepository');
const runRepository = require('./runRepository');
const authority = require('./authority');
const { digestSourceIdentity } = require('./sourceModel');

process.env.SYNC_REVIEW_SECRET = process.env.SYNC_REVIEW_SECRET || 'test-secret-for-source-orchestrator';
process.env.INTEGRATION_CREDENTIALS_KEY = process.env.INTEGRATION_CREDENTIALS_KEY || Buffer.alloc(32, 5).toString('base64');

let scenarios = new Map();
let fetchCount = 0;

function source(externalId, name = externalId) {
  return { kind: 'elvanto_group', externalId, name };
}

function person(id, overrides = {}) {
  return {
    id, firstName: 'Ada', lastName: 'Lovelace', state: 'active', child: false, familyId: null, ...overrides,
  };
}

function snapshot(selectedSource, overrides = {}) {
  const people = overrides.people || [];
  return {
    provider: 'elvanto',
    source: selectedSource,
    complete: true,
    fetchedAt: new Date().toISOString(),
    providerRefreshedAt: null,
    memberExternalIds: people.map((entry) => entry.id),
    people,
    contextPeople: [],
    families: [],
    ...overrides,
  };
}

providerRegistry.registerProvider('elvanto', {
  provider: 'elvanto',
  async validateConnection() { return { ok: true, metadata: {} }; },
  async listSources() { return [...scenarios.keys()].map((externalId) => source(externalId)); },
  async fetchSourceSnapshot({ sourceKind, sourceExternalId }) {
    fetchCount += 1;
    const value = scenarios.get(sourceExternalId);
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value({ sourceKind, sourceExternalId });
    return value || snapshot({ kind: sourceKind, externalId: sourceExternalId, name: sourceExternalId });
  },
  isLifecycleEligible(value, settings = {}) {
    return !!value && value.state !== 'archived' && value.state !== 'deceased' &&
      (value.state !== 'contact' || settings.includeContacts !== false);
  },
});

const orchestrator = require('./orchestrator');

async function seedConnection(churchId) {
  return connectionStore.upsertConnection({
    churchId, provider: 'elvanto', authType: 'api_key', credentials: { apiKey: 'test-key' }, connectedBy: null, metadata: {},
  });
}

async function promoteInitialSource(churchId, batch) {
  return batchRepository.promoteSourceDraftWithConnection(Database.getChurchDb(churchId), {
    churchId,
    provider: 'elvanto',
    batchId: batch.id,
    expectedBaseRevision: batch.draftSourceBaseRevision,
    expectedDraftDigest: digestSourceIdentity(batch.draftSource),
  });
}

async function reviewedBatch(churchId, selectedSource = source('members', 'Members'), overrides = {}) {
  const created = await batchRepository.createBatch({
    churchId, provider: 'elvanto', name: 'Members', initialDraftSource: selectedSource, ...overrides,
  });
  return promoteInitialSource(churchId, created);
}

async function setAuthority(churchId, provider = 'elvanto') {
  await Database.query(`UPDATE people_sync_settings SET authority_provider = ? WHERE church_id = ?`, [provider, churchId]);
}

async function countPeople(churchId) {
  const [row] = await Database.query('SELECT COUNT(*) AS count FROM individuals WHERE church_id = ?', [churchId]);
  return Number(row.count);
}

async function seedIndividual(churchId, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO individuals (church_id, first_name, last_name, family_id, people_type, is_active, is_child)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [churchId, overrides.firstName || 'Ada', overrides.lastName || 'Lovelace', overrides.familyId || null,
      overrides.peopleType || 'regular', overrides.isActive === false ? 0 : 1, overrides.isChild ? 1 : 0]
  );
  return Number(result.insertId);
}

async function linkPerson(churchId, externalPersonId, individualId, missingCount = 0) {
  await Database.query(
    `INSERT INTO external_person_links
      (church_id, provider, external_person_id, individual_id, link_source, missing_full_sync_count)
     VALUES (?, 'elvanto', ?, ?, 'matched', ?)`,
    [churchId, externalPersonId, individualId, missingCount]
  );
}

async function missingCounts(churchId) {
  const rows = await Database.query(
    `SELECT external_person_id, missing_full_sync_count FROM external_person_links
     WHERE church_id = ? AND provider = 'elvanto' ORDER BY external_person_id`, [churchId]
  );
  return Object.fromEntries(rows.map((row) => [row.external_person_id, Number(row.missing_full_sync_count)]));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function selectionsForReview(review) {
  const context = review.plan.reviewContext;
  const additions = new Set((review.plan.addPeople || []).map(({ externalPersonId }) => externalPersonId));
  const identityDecisions = Object.fromEntries(
    Object.entries(context?.identities || {}).map(([externalPersonId, identity]) => {
      if (Number.isSafeInteger(identity.suggestedIndividualId) && identity.suggestedIndividualId > 0) {
        return [externalPersonId, { outcome: 'accept' }];
      }
      if (identity.canCreate === true && additions.has(externalPersonId)) {
        return [externalPersonId, { outcome: 'create' }];
      }
      return [externalPersonId, { outcome: 'defer' }];
    })
  );
  const linkCorrections = Object.fromEntries((context?.linkCorrections || []).map((correction) => {
    const { externalPersonId, ...selection } = correction;
    return [externalPersonId, selection];
  }));
  return {
    decisionContractVersion: 2,
    identityDecisions,
    ...(Object.keys(linkCorrections).length > 0 ? { linkCorrections } : {}),
  };
}

async function replaceElvantoConnectionGeneration(churchId, generation, apiKey) {
  return Database.transactionForChurch(churchId, async (conn) => {
    await connectionStore.upsertConnection({
      churchId,
      provider: 'elvanto',
      authType: 'api_key',
      credentials: { apiKey },
      connectedBy: null,
      metadata: {},
    });
    await conn.query(
      `INSERT INTO integration_connection_generations (church_id, provider, generation)
       VALUES (?, 'elvanto', ?)
       ON CONFLICT(church_id, provider) DO UPDATE SET generation = excluded.generation`,
      [churchId, generation]
    );
  });
}

test('unattended sync requires reviewed source intent before run creation, then accepts a reviewed empty source', async () => {
  await withTestChurchDb(async (churchId) => {
    scenarios = new Map([['members', snapshot(source('members', 'Members'))]]);
    await seedConnection(churchId);
    await setAuthority(churchId);
    const missing = await batchRepository.createBatch({ churchId, provider: 'elvanto', name: 'Missing' });
    const before = fetchCount;
    await assert.rejects(
      orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: missing.id }),
      { code: 'SYNC_SOURCE_SELECTION_REQUIRED' }
    );
    assert.equal(fetchCount, before);
    assert.deepEqual(await runRepository.listRecentRuns(churchId, 'elvanto'), []);
    await batchRepository.deleteBatch(churchId, 'elvanto', missing.id);

    const pending = await batchRepository.createBatch({
      churchId, provider: 'elvanto', name: 'Pending', initialDraftSource: source('members', 'Members'),
    });
    await assert.rejects(
      orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: pending.id }),
      { code: 'SYNC_SOURCE_REVIEW_REQUIRED' }
    );
    const promoted = await promoteInitialSource(churchId, pending);
    const result = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: promoted.id });
    assert.equal(result.status, 'applied');
    assert.equal(result.fetchMode, 'full');
  });
});

test('reviewed apply promotes its draft source with people mutations and records source provenance', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const active = source('old', 'Old');
    const draft = source('new', 'New');
    const initial = await reviewedBatch(churchId, active);
    const pending = await batchRepository.saveSourceDraft({ churchId, provider: 'elvanto', batchId: initial.id, source: draft });
    scenarios = new Map([['new', snapshot(draft, { people: [person('new-person')], memberExternalIds: ['new-person'] })]]);

    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: pending.id, trigger: 'manual' });
    const applied = await orchestrator.applyReviewed({
      churchId, provider: 'elvanto', batchId: pending.id, reviewToken: review.reviewToken,
      selections: selectionsForReview(review),
    });

    assert.equal(applied.status, 'applied');
    assert.equal(await countPeople(churchId), 1);
    const promoted = await batchRepository.getBatch(churchId, 'elvanto', pending.id);
    assert.deepEqual(promoted.source, draft);
    assert.equal(promoted.draftSource, null);
    const [latest] = await runRepository.listRecentRuns(churchId, 'elvanto');
    assert.equal(latest.status, 'applied');
    assert.deepEqual(latest.sourceProvenance.map((entry) => ({ batchId: entry.batchId, sourceExternalId: entry.sourceExternalId })), [
      { batchId: pending.id, sourceExternalId: 'new' },
    ]);
  });
});

test('a changed source base revision makes the review stale before people writes and retains the draft', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const initial = await reviewedBatch(churchId, source('old', 'Old'));
    const pending = await batchRepository.saveSourceDraft({
      churchId, provider: 'elvanto', batchId: initial.id, source: source('new', 'New'),
    });
    scenarios = new Map([['new', snapshot(source('new', 'New'), { people: [person('one')], memberExternalIds: ['one'] })]]);
    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: pending.id, trigger: 'manual' });
    await Database.query(
      `UPDATE people_sync_batches SET source_revision = source_revision + 1 WHERE id = ? AND church_id = ?`, [pending.id, churchId]
    );

    await assert.rejects(
      orchestrator.applyReviewed({
        churchId, provider: 'elvanto', batchId: pending.id, reviewToken: review.reviewToken,
        selections: selectionsForReview(review),
      }),
      (error) => error.code === 'SYNC_PLAN_STALE' && error.status === 409
    );
    assert.equal(await countPeople(churchId), 0);
    assert.deepEqual((await batchRepository.getBatch(churchId, 'elvanto', pending.id)).draftSource, source('new', 'New'));
  });
});

test('changed source membership invalidates the review before apply', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    scenarios = new Map([['members', snapshot(selected, { people: [person('one')], memberExternalIds: ['one'] })]]);
    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });
    scenarios.set('members', snapshot(selected, {
      people: [person('one'), person('two', { firstName: 'Grace', lastName: 'Hopper' })], memberExternalIds: ['one', 'two'],
    }));
    await assert.rejects(
      orchestrator.applyReviewed({
        churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken,
        selections: selectionsForReview(review),
      }),
      { code: 'SYNC_PLAN_STALE' }
    );
    assert.equal(await countPeople(churchId), 0);
  });
});

test('context people corroborate matching without mutating legacy presence counters', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const adaOne = await seedIndividual(churchId, { firstName: 'Ada', lastName: 'Smith', familyId: null });
    const adaTwo = await seedIndividual(churchId, { firstName: 'Ada', lastName: 'Smith', familyId: null });
    const contextLocal = await seedIndividual(churchId, { firstName: 'Bob', lastName: 'Smith', familyId: null });
    await Database.query('INSERT INTO families (church_id, family_name) VALUES (?, ?)', [churchId, 'One']);
    const [familyOne] = await Database.query('SELECT id FROM families WHERE church_id = ? ORDER BY id LIMIT 1', [churchId]);
    await Database.query('INSERT INTO families (church_id, family_name) VALUES (?, ?)', [churchId, 'Two']);
    const families = await Database.query('SELECT id FROM families WHERE church_id = ? ORDER BY id', [churchId]);
    await Database.query('UPDATE individuals SET family_id = ? WHERE id IN (?, ?)', [familyOne.id, adaOne, contextLocal]);
    await Database.query('UPDATE individuals SET family_id = ? WHERE id = ?', [families[1].id, adaTwo]);
    await linkPerson(churchId, 'context', contextLocal);
    scenarios = new Map([['members', snapshot(selected, {
      people: [person('member', { firstName: 'Ada', lastName: 'Smith', familyId: 'external-family' })],
      memberExternalIds: ['member'],
      contextPeople: [person('context', { firstName: 'Bob', lastName: 'Smith', familyId: 'external-family' })],
      families: [{ id: 'external-family', memberExternalIds: ['member', 'context'], primaryContactExternalId: 'context' }],
    })]]);

    const result = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id });
    assert.equal(result.counts.linkPeople, 1);
    assert.deepEqual(await missingCounts(churchId), { context: 0, member: 0 });
  });
});

test('a lifecycle-ineligible linked source member is neither archived nor counted by full-fetch presence', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const individualId = await seedIndividual(churchId, { firstName: 'Grace', lastName: 'Hopper' });
    await linkPerson(churchId, 'terminal', individualId, 1);
    scenarios = new Map([['members', snapshot(selected, {
      people: [person('terminal', { firstName: 'Grace', lastName: 'Hopper', state: 'archived' })],
      memberExternalIds: ['terminal'],
    })]]);

    const result = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id });

    assert.equal(result.status, 'applied');
    const [individual] = await Database.query(
      'SELECT is_active FROM individuals WHERE church_id = ? AND id = ?', [churchId, individualId]
    );
    assert.equal(individual.is_active, 1);
    assert.deepEqual(await missingCounts(churchId), { terminal: 1 });
  });
});

test('a missing active source records health and every later run attempts the stable ID again', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const before = fetchCount;
    scenarios = new Map([['members', Object.assign(new Error('gone'), { code: 'SYNC_SOURCE_UNAVAILABLE' })]]);
    await assert.rejects(orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id }), {
      code: 'SYNC_SOURCE_UNAVAILABLE',
    });
    let current = await batchRepository.getBatch(churchId, 'elvanto', batch.id);
    assert.equal(current.sourceStatus, 'missing');

    scenarios.set('members', snapshot(selected));
    const recovered = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id });
    assert.equal(recovered.status, 'applied');
    current = await batchRepository.getBatch(churchId, 'elvanto', batch.id);
    assert.equal(current.sourceStatus, 'available');
    assert.equal(fetchCount - before, 2);
    assert.deepEqual((await runRepository.listRecentRuns(churchId, 'elvanto')).map((run) => run.status), ['applied', 'failed']);
  });
});

test('transient source transport and rate-limit failures record error health without missing-source notifications', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, ?, 'admin', 'Source', 'Admin', 1)`,
      [churchId, `transient-source-${Math.random().toString(36).slice(2)}@example.com`]
    );

    for (const code of ['SYNC_SOURCE_CHECK_FAILED', 'SYNC_SOURCE_RATE_LIMIT']) {
      scenarios = new Map([['members', Object.assign(new Error('temporary provider failure'), { code })]]);
      await assert.rejects(
        orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' }),
        (error) => error.code === code
      );
      const updated = await batchRepository.getBatch(churchId, 'elvanto', batch.id);
      assert.equal(updated.sourceStatus, 'error');
      assert.equal(updated.sourceStatusErrorCode, code);
    }

    const notices = await Database.query(
      `SELECT id FROM notifications WHERE church_id = ? AND notification_type = 'system'`, [churchId]
    );
    assert.equal(notices.length, 0);
  });
});

test('a mismatched returned stable source is unavailable, marks active health missing, and notifies admins', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const selected = source('secret-members-id', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, ?, 'admin', 'Source', 'Admin', 1)`,
      [churchId, `source-admin-${Math.random().toString(36).slice(2)}@example.com`]
    );
    scenarios = new Map([['secret-members-id', snapshot(source('replacement', 'Replacement'))]]);

    await assert.rejects(
      orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' }),
      (error) => error.code === 'SYNC_SOURCE_UNAVAILABLE'
    );

    const updated = await batchRepository.getBatch(churchId, 'elvanto', batch.id);
    assert.equal(updated.sourceStatus, 'missing');
    assert.equal(updated.sourceStatusErrorCode, 'SYNC_SOURCE_UNAVAILABLE');
    const notices = await Database.query(
      `SELECT title, message FROM notifications WHERE church_id = ? AND notification_type = 'system'`, [churchId]
    );
    assert.equal(notices.length, 1);
    assert.equal(notices[0].message.includes(selected.externalId), false);
    const [latest] = await runRepository.listRecentRuns(churchId, 'elvanto');
    assert.equal(latest.errorCode, 'SYNC_SOURCE_UNAVAILABLE');
  });
});

test('legacy Planning Center batches reject all orchestration paths before fetch or run creation', async () => {
  await withTestChurchDb(async (churchId) => {
    const legacy = await batchRepository.createBatch({
      churchId, provider: 'planning_center', name: 'Retired PCO members', legacyProviderBatchId: 77,
      initialDraftSource: { kind: 'planning_center_list', externalId: '77', name: 'Retired list' },
    });
    let fetches = 0;
    let starts = 0;
    const overrides = {
      getConnection: async () => ({ connectionStatus: 'active' }),
      getCredentials: async () => ({ accessToken: 'test-token' }),
      getProvider: () => ({ fetchSourceSnapshot: async () => { fetches += 1; return null; } }),
      startRun: async () => { starts += 1; return { id: 1 }; },
    };
    const expected = { code: 'PCO_LEGACY_BATCH_RETIRED', status: 409 };

    await assert.rejects(
      orchestrator.buildReview({ churchId, provider: 'planning_center', batchId: legacy.id, trigger: 'manual' }, overrides),
      expected,
    );
    await assert.rejects(
      orchestrator.applyReviewed({ churchId, provider: 'planning_center', batchId: legacy.id, reviewToken: 'retired' }, overrides),
      expected,
    );
    await assert.rejects(
      orchestrator.runUnattended({ churchId, provider: 'planning_center', batchId: legacy.id }, overrides),
      expected,
    );
    assert.equal(fetches, 0);
    assert.equal(starts, 0);
  });
});

test('legacy Planning Center retirement wins before connection and credential setup', async () => {
  await withTestChurchDb(async (churchId) => {
    const legacy = await batchRepository.createBatch({
      churchId, provider: 'planning_center', name: 'Retired PCO members', legacyProviderBatchId: 78,
      initialDraftSource: { kind: 'planning_center_list', externalId: '78', name: 'Retired list' },
    });
    let connectionLoads = 0;
    let credentialLoads = 0;
    let providerLoads = 0;
    const overrides = {
      getConnection: async () => { connectionLoads += 1; return null; },
      getCredentials: async () => { credentialLoads += 1; return null; },
      getProvider: () => { providerLoads += 1; throw new Error('provider setup must not run'); },
    };
    const expected = { code: 'PCO_LEGACY_BATCH_RETIRED', status: 409 };

    await assert.rejects(
      orchestrator.buildReview({ churchId, provider: 'planning_center', batchId: legacy.id, trigger: 'manual' }, overrides),
      expected,
    );
    await assert.rejects(
      orchestrator.runUnattended({ churchId, provider: 'planning_center', batchId: legacy.id }, overrides),
      expected,
    );
    assert.deepEqual({ connectionLoads, credentialLoads, providerLoads }, {
      connectionLoads: 0, credentialLoads: 0, providerLoads: 0,
    });
  });
});

test('source runs ignore a legacy watermark and remain full snapshot reconciliations', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    await Database.query(
      `UPDATE people_sync_batches SET last_external_watermark = 'legacy-watermark' WHERE id = ? AND church_id = ?`, [batch.id, churchId]
    );
    scenarios = new Map([['members', snapshot(selected)]]);
    const result = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id, forceFull: false });
    assert.equal(result.fetchMode, 'full');
    assert.equal(result.externalWatermark, null);
    assert.equal((await runRepository.listRecentRuns(churchId, 'elvanto'))[0].fetchMode, 'full');
  });
});

test('authority preview remains pending until its source reconciliation applies', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const selected = source('members', 'Members');
    await reviewedBatch(churchId, selected);
    scenarios = new Map([['members', snapshot(selected, { people: [person('one')], memberExternalIds: ['one'] })]]);
    const preview = await orchestrator.previewAuthoritySwitch({ churchId, provider: 'elvanto' });
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'none', pending: 'elvanto' });
    const applied = await orchestrator.applyReviewed({
      churchId, provider: 'elvanto', batchId: null, reviewToken: preview.reviewToken,
      selections: selectionsForReview(preview),
    });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'elvanto', pending: null });
    assert.equal(await countPeople(churchId), 1);
  });
});

test('reviewed apply rejects a fetched plan when authority is disabled during the provider read', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const current = snapshot(selected, { people: [person('late-person')], memberExternalIds: ['late-person'] });
    scenarios = new Map([['members', current]]);
    const review = await orchestrator.buildReview({
      churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual',
    });

    const fetchEntered = deferred();
    const releaseFetch = deferred();
    scenarios.set('members', async () => {
      fetchEntered.resolve();
      await releaseFetch.promise;
      return current;
    });
    const applying = orchestrator.applyReviewed({
      churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken,
      selections: selectionsForReview(review),
    });
    await fetchEntered.promise;
    await authority.disableAuthority(churchId);
    releaseFetch.resolve();

    await assert.rejects(applying, (error) => error.code === 'SYNC_PLAN_STALE' && error.status === 409);
    assert.equal(await countPeople(churchId), 0);
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'none', pending: null });
  });
});

test('unattended apply rejects a fetched plan when authority is disabled during the provider read', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const current = snapshot(selected, { people: [person('late-person')], memberExternalIds: ['late-person'] });
    const fetchEntered = deferred();
    const releaseFetch = deferred();
    scenarios = new Map([['members', async () => {
      fetchEntered.resolve();
      await releaseFetch.promise;
      return current;
    }]]);

    const applying = orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id });
    await fetchEntered.promise;
    await authority.disableAuthority(churchId);
    releaseFetch.resolve();

    await assert.rejects(applying, (error) => error.code === 'SYNC_PLAN_STALE' && error.status === 409);
    assert.equal(await countPeople(churchId), 0);
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'none', pending: null });
  });
});

test('reviewed apply rejects an active-source generation promoted during the provider read', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const oldSource = source('members-old', 'Old members');
    const batch = await reviewedBatch(churchId, oldSource);
    const current = snapshot(oldSource, { people: [person('late-person')], memberExternalIds: ['late-person'] });
    scenarios = new Map([['members-old', current]]);
    const review = await orchestrator.buildReview({
      churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual',
    });

    const fetchEntered = deferred();
    const releaseFetch = deferred();
    scenarios.set('members-old', async () => {
      fetchEntered.resolve();
      await releaseFetch.promise;
      return current;
    });
    const applying = orchestrator.applyReviewed({
      churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken,
      selections: selectionsForReview(review),
    });
    await fetchEntered.promise;
    const changed = await batchRepository.saveSourceDraft({
      churchId, provider: 'elvanto', batchId: batch.id, source: source('members-new', 'New members'),
    });
    await promoteInitialSource(churchId, changed);
    releaseFetch.resolve();

    await assert.rejects(applying, (error) => error.code === 'SYNC_PLAN_STALE' && error.status === 409);
    assert.equal(await countPeople(churchId), 0);
    const reloaded = await batchRepository.getBatch(churchId, 'elvanto', batch.id);
    assert.equal(reloaded.source.externalId, 'members-new');
  });
});

test('reviewed apply rejects an Elvanto account replacement during its provider read', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await replaceElvantoConnectionGeneration(churchId, 4, 'old-account-key');
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const current = snapshot(selected, { people: [person('late-person')], memberExternalIds: ['late-person'] });
    scenarios = new Map([['members', current]]);
    const review = await orchestrator.buildReview({
      churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual',
    });
    await Database.query(
      `UPDATE people_sync_batches
          SET source_status = 'error', source_status_error_code = 'SYNC_SOURCE_INCOMPLETE'
        WHERE id = ? AND church_id = ?`,
      [batch.id, churchId]
    );

    const fetchEntered = deferred();
    const releaseFetch = deferred();
    scenarios.set('members', async () => {
      fetchEntered.resolve();
      await releaseFetch.promise;
      return current;
    });
    const applying = orchestrator.applyReviewed({
      churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken,
      selections: selectionsForReview(review),
    });
    await fetchEntered.promise;
    await replaceElvantoConnectionGeneration(churchId, 5, 'replacement-account-key');
    releaseFetch.resolve();

    await assert.rejects(
      applying,
      (error) => error instanceof orchestrator.OrchestratorError &&
        error.code === 'SYNC_PLAN_STALE' && error.status === 409
    );
    assert.equal(await countPeople(churchId), 0);
    const health = await batchRepository.getBatch(churchId, 'elvanto', batch.id);
    assert.equal(health.sourceStatus, 'error');
    assert.equal(health.sourceStatusErrorCode, 'SYNC_SOURCE_INCOMPLETE');
  });
});

test('unattended apply rejects an Elvanto account replacement during its provider read', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await replaceElvantoConnectionGeneration(churchId, 11, 'old-account-key');
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const current = snapshot(selected, { people: [person('late-person')], memberExternalIds: ['late-person'] });
    const fetchEntered = deferred();
    const releaseFetch = deferred();
    scenarios = new Map([['members', async () => {
      fetchEntered.resolve();
      await releaseFetch.promise;
      return current;
    }]]);

    const applying = orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id });
    await fetchEntered.promise;
    await replaceElvantoConnectionGeneration(churchId, 12, 'replacement-account-key');
    releaseFetch.resolve();

    await assert.rejects(applying, (error) => error.code === 'SYNC_PLAN_STALE' && error.status === 409);
    assert.equal(await countPeople(churchId), 0);
    assert.equal((await batchRepository.getBatch(churchId, 'elvanto', batch.id)).sourceStatus, 'unknown');
  });
});

test('a failed old-account fetch cannot publish missing source health or notifications after reconnect', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await replaceElvantoConnectionGeneration(churchId, 21, 'old-account-key');
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, ?, 'admin', 'Stale', 'Health', 1)`,
      [churchId, `stale-health-${Math.random().toString(36).slice(2)}@example.com`]
    );
    const fetchEntered = deferred();
    const releaseFetch = deferred();
    scenarios = new Map([['members', async () => {
      fetchEntered.resolve();
      await releaseFetch.promise;
      throw Object.assign(new Error('old account no longer sees source'), { code: 'SYNC_SOURCE_UNAVAILABLE' });
    }]]);

    const review = orchestrator.buildReview({
      churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual',
    });
    await fetchEntered.promise;
    await replaceElvantoConnectionGeneration(churchId, 22, 'replacement-account-key');
    releaseFetch.resolve();

    await assert.rejects(review, (error) => error.code === 'SYNC_SOURCE_UNAVAILABLE');
    assert.equal((await batchRepository.getBatch(churchId, 'elvanto', batch.id)).sourceStatus, 'unknown');
    const notices = await Database.query(
      `SELECT id FROM notifications WHERE church_id = ? AND notification_type = 'system'`,
      [churchId]
    );
    assert.equal(notices.length, 0);
  });
});

test('reviewed apply does not invoke the legacy post-apply presence boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await replaceElvantoConnectionGeneration(churchId, 31, 'old-account-key');
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const individualId = await seedIndividual(churchId, { firstName: 'Existing' });
    await linkPerson(churchId, 'missing-person', individualId);
    scenarios = new Map([['members', snapshot(selected, { people: [], memberExternalIds: [] })]]);
    const review = await orchestrator.buildReview({
      churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual',
    });

    const result = await orchestrator.applyReviewed({
      churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken,
      selections: selectionsForReview(review),
    }, {
      recordFullFetchPresence: async () => {
        await replaceElvantoConnectionGeneration(churchId, 32, 'replacement-account-key');
      },
    });

    assert.equal(result.status, 'applied');
    assert.equal(await connectionStore.getConnectionGeneration(churchId, 'elvanto'), 31);
    assert.deepEqual(await missingCounts(churchId), { 'missing-person': 0 });
  });
});

test('unattended apply does not invoke the legacy post-apply presence boundary', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await replaceElvantoConnectionGeneration(churchId, 41, 'old-account-key');
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    const individualId = await seedIndividual(churchId, { firstName: 'Existing' });
    await linkPerson(churchId, 'missing-person', individualId);
    scenarios = new Map([['members', snapshot(selected, { people: [], memberExternalIds: [] })]]);

    const result = await orchestrator.runUnattended({
      churchId, provider: 'elvanto', batchId: batch.id,
    }, {
      recordFullFetchPresence: async () => {
        await replaceElvantoConnectionGeneration(churchId, 42, 'replacement-account-key');
      },
    });

    assert.equal(result.status, 'applied');
    assert.equal(await connectionStore.getConnectionGeneration(churchId, 'elvanto'), 41);
    assert.deepEqual(await missingCounts(churchId), { 'missing-person': 0 });
  });
});

test('a transient finish failure after source apply retries and reaches a terminal run', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await setAuthority(churchId);
    const selected = source('members', 'Members');
    const batch = await reviewedBatch(churchId, selected);
    scenarios = new Map([['members', snapshot(selected, { people: [person('one')], memberExternalIds: ['one'] })]]);
    let finishCalls = 0;
    const result = await orchestrator.runUnattended(
      { churchId, provider: 'elvanto', batchId: batch.id },
      { finishRun: async (input) => {
        finishCalls += 1;
        if (finishCalls === 1) throw new Error('transient lock');
        return runRepository.finishRun(input);
      } }
    );
    assert.equal(result.status, 'applied');
    assert.equal(finishCalls, 2);
    const [latest] = await runRepository.listRecentRuns(churchId, 'elvanto');
    assert.equal(latest.status, 'applied');
    assert.equal(latest.sourceProvenance.length, 1, 'terminal-write retries must preserve source audit provenance');
  });
});
