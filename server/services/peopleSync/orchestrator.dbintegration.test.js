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
      orchestrator.applyReviewed({ churchId, provider: 'elvanto', batchId: pending.id, reviewToken: review.reviewToken }),
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
      orchestrator.applyReviewed({ churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken }),
      { code: 'SYNC_PLAN_STALE' }
    );
    assert.equal(await countPeople(churchId), 0);
  });
});

test('context people corroborate matching but are excluded from durable full-fetch presence', async () => {
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
    assert.deepEqual(await missingCounts(churchId), { context: 1, member: 0 });
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
    });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'elvanto', pending: null });
    assert.equal(await countPeople(churchId), 1);
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
