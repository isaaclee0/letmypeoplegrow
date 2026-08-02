const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { applyPeopleSyncPlan } = require('./apply');
const { BUCKETS } = require('./plan');
const batchRepository = require('./batchRepository');
const matchReviewRepository = require('./matchReviewRepository');
const { buildReviewContext } = require('./reviewContext');
const { createReviewToken, digestPlan, verifyReviewToken } = require('./planDigest');
const { digestSourceIdentity } = require('./sourceModel');

process.env.SYNC_REVIEW_SECRET = process.env.SYNC_REVIEW_SECRET || 'apply-db-integration-test-secret';

// Minimal, self-documenting empty plan shape — every bucket applyPeopleSyncPlan
// reads, so tests only need to override the buckets that matter for that
// scenario. Mirrors computePeopleSyncPlan's own output shape (see plan.js).
function emptyPlan(overrides = {}) {
  const plan = { provider: overrides.provider || 'elvanto', authoritative: overrides.authoritative !== false };
  for (const bucket of BUCKETS) plan[bucket] = [];
  return { ...plan, ...overrides };
}

function reviewIdentity(overrides = {}) {
  return {
    suggestedIndividualId: null,
    candidateIndividualIds: [],
    excludedIndividualIds: [],
    held: false,
    canCreate: true,
    createPerson: {
      firstName: 'Alex', lastName: 'Smith', isChild: false,
      externalFamilyId: null, peopleType: 'regular',
    },
    ...overrides,
  };
}

function v2Plan(identities, overrides = {}) {
  const manualCandidateIndividualIds = overrides.manualCandidateIndividualIds || [];
  return emptyPlan({
    ...overrides,
    reviewContext: { version: 2, manualCandidateIndividualIds, identities },
  });
}

function v2Selections(identityDecisions) {
  return { decisionContractVersion: 2, identityDecisions };
}

function reviewedApply(churchId, provider, plan, batchId = null) {
  const planDigest = digestPlan(plan);
  const reviewToken = createReviewToken({
    churchId, provider, batchId, planDigest, expiresInSeconds: 1800,
  });
  return {
    reviewToken,
    planDigest,
    batchId,
    verifyReviewToken,
  };
}

async function seedIndividual(churchId, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO individuals (church_id, first_name, last_name, family_id, people_type, is_active, planning_center_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      churchId, overrides.firstName || 'Ada', overrides.lastName || 'Lovelace', overrides.familyId || null,
      overrides.peopleType || 'regular', overrides.isActive === false ? 0 : 1, overrides.planningCenterId || null,
    ]
  );
  return Number(result.insertId);
}

async function seedFamily(churchId, familyName = 'Lovelace') {
  const result = await Database.query(
    `INSERT INTO families (church_id, family_name) VALUES (?, ?)`, [churchId, familyName]
  );
  return Number(result.insertId);
}

async function seedGatheringType(churchId, name = 'Sunday Service') {
  const result = await Database.query(
    `INSERT INTO gathering_types (name, church_id) VALUES (?, ?)`, [name, churchId]
  );
  return Number(result.insertId);
}

async function seedSyncBatch(churchId, provider, name = 'Members') {
  const result = await Database.query(
    `INSERT INTO people_sync_batches (church_id, provider, name) VALUES (?, ?, ?)`,
    [churchId, provider, name]
  );
  return Number(result.insertId);
}

async function seedGatheringListRow(churchId, gatheringTypeId, individualId, addedBySyncBatchId) {
  await Database.query(
    `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id, added_by_sync_batch_id)
     VALUES (?, ?, ?, ?)`,
    [gatheringTypeId, individualId, churchId, addedBySyncBatchId]
  );
}

async function setAuthority(churchId, provider) {
  await Database.query(
    `INSERT INTO people_sync_settings (church_id, authority_provider) VALUES (?, ?)
     ON CONFLICT(church_id) DO UPDATE SET authority_provider = excluded.authority_provider`,
    [churchId, provider]
  );
}

async function seedConnectionRow(churchId, provider) {
  await Database.query(
    `INSERT INTO integration_connections
       (church_id, provider, auth_type, credential_ciphertext, credential_nonce, credential_auth_tag)
     VALUES (?, ?, 'api_key', 'test-ciphertext', 'test-nonce', 'test-tag')`,
    [churchId, provider]
  );
}

async function counts(churchId) {
  const [individuals] = await Database.query('SELECT COUNT(*) AS n FROM individuals WHERE church_id = ?', [churchId]);
  const [families] = await Database.query('SELECT COUNT(*) AS n FROM families WHERE church_id = ?', [churchId]);
  const [links] = await Database.query('SELECT COUNT(*) AS n FROM external_person_links WHERE church_id = ?', [churchId]);
  return { individuals: Number(individuals.n), families: Number(families.n), links: Number(links.n) };
}

test('link creation writes external_person_links and dual-writes the legacy PCO id only for planning_center', async () => {
  await withTestChurchDb(async (churchId) => {
    const pcoIndividualId = await seedIndividual(churchId, { firstName: 'PCO' });
    const elvantoIndividualId = await seedIndividual(churchId, { firstName: 'Elvanto' });

    await applyPeopleSyncPlan({
      churchId, provider: 'planning_center',
      plan: emptyPlan({ provider: 'planning_center', linkPeople: [
        { id: 'linkPeople:pco-1', externalPersonId: 'pco-1', individualId: pcoIndividualId, reviewRequired: false },
      ] }),
    });
    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ provider: 'elvanto', linkPeople: [
        { id: 'linkPeople:elvanto-1', externalPersonId: 'elvanto-1', individualId: elvantoIndividualId, reviewRequired: false },
      ] }),
    });

    const [pcoRow] = await Database.query('SELECT planning_center_id FROM individuals WHERE id = ?', [pcoIndividualId]);
    const [elvantoRow] = await Database.query('SELECT planning_center_id FROM individuals WHERE id = ?', [elvantoIndividualId]);
    assert.equal(pcoRow.planning_center_id, 'pco-1');
    assert.equal(elvantoRow.planning_center_id, null);

    const links = await Database.query(
      'SELECT provider, external_person_id, individual_id FROM external_person_links WHERE church_id = ? ORDER BY provider',
      [churchId]
    );
    assert.deepEqual(links, [
      { provider: 'elvanto', external_person_id: 'elvanto-1', individual_id: elvantoIndividualId },
      { provider: 'planning_center', external_person_id: 'pco-1', individual_id: pcoIndividualId },
    ]);
  });
});

test('person, family, and link creation commit together', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', userId: null,
      plan: emptyPlan({
        addFamilies: [{ id: 'addFamilies:fam-x', familyName: 'Ada Lovelace Household', externalFamilyId: 'fam-x' }],
        addPeople: [{
          id: 'addPeople:ext-1', externalPersonId: 'ext-1', firstName: 'Ada', lastName: 'Lovelace',
          isChild: false, familyId: null, peopleType: 'regular',
        }],
      }),
    });

    assert.equal(result.addFamilies, 1);
    assert.equal(result.addPeople, 1);
    const { individuals, families } = await counts(churchId);
    assert.equal(individuals, 1);
    assert.equal(families, 1);
    const [familyLink] = await Database.query(
      'SELECT external_family_id, family_id FROM external_family_links WHERE church_id = ?', [churchId]
    );
    assert.equal(familyLink.external_family_id, 'fam-x');
    const [personLink] = await Database.query(
      'SELECT external_person_id FROM external_person_links WHERE church_id = ?', [churchId]
    );
    assert.equal(personLink.external_person_id, 'ext-1');
  });
});

test('reviewed corrections atomically retarget managed effects while preserving old local history', async () => {
  await withTestChurchDb(async (churchId) => {
    const provider = 'planning_center';
    const oldFamilyId = await seedFamily(churchId, 'Old Household');
    const targetFamilyId = await seedFamily(churchId, 'Target Household');
    await Database.query(
      `UPDATE families SET family_notes = 'Keep this pastoral note' WHERE church_id = ? AND id = ?`,
      [churchId, oldFamilyId]
    );
    const oldId = await seedIndividual(churchId, {
      firstName: 'Old', lastName: 'Person', familyId: oldFamilyId, planningCenterId: 'pco-a',
    });
    const newId = await seedIndividual(churchId, {
      firstName: 'Known', lastName: 'Surname', peopleType: 'local_visitor',
    });
    const unlinkId = await seedIndividual(churchId, {
      firstName: 'Unlink', lastName: 'Person', planningCenterId: 'pco-unlink',
    });
    await Database.query('UPDATE individuals SET is_child = 0 WHERE church_id = ? AND id = ?', [churchId, newId]);
    await Database.query(
      `INSERT INTO external_person_links
         (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, ?, 'pco-a', ?, 'matched'), (?, ?, 'pco-unlink', ?, 'matched')`,
      [churchId, provider, oldId, churchId, provider, unlinkId]
    );
    await matchReviewRepository.upsertHold({
      churchId, provider, externalPersonId: 'pco-a', reason: 'pair_rejected',
    });
    await matchReviewRepository.upsertHold({
      churchId, provider, externalPersonId: 'pco-unlink', reason: 'deferred',
    });

    const historyGatheringId = await seedGatheringType(churchId, 'History');
    const managedGatheringId = await seedGatheringType(churchId, 'Managed');
    const userId = Number((await Database.query(
      `INSERT INTO users (church_id, email, role) VALUES (?, ?, 'admin')`,
      [churchId, `${churchId}@example.test`]
    )).insertId);
    const sessionId = Number((await Database.query(
      `INSERT INTO attendance_sessions
         (gathering_type_id, session_date, created_by, notes, church_id)
       VALUES (?, '2026-07-01', ?, 'Keep this attendance note', ?)`,
      [historyGatheringId, userId, churchId]
    )).insertId);
    await Database.query(
      `INSERT INTO attendance_records
         (session_id, individual_id, present, people_type_at_time, church_id)
       VALUES (?, ?, 1, 'regular', ?)`,
      [sessionId, oldId, churchId]
    );

    const draft = { kind: 'planning_center_list', externalId: 'list-1', name: 'Members' };
    const batch = await batchRepository.createBatch({
      churchId, provider, name: 'Reviewed corrections', initialDraftSource: draft,
    });
    await setAuthority(churchId, 'none');

    const corrections = [
      { externalPersonId: 'pco-a', fromIndividualId: oldId, outcome: 'relink', individualId: newId },
      { externalPersonId: 'pco-unlink', fromIndividualId: unlinkId, outcome: 'unlink' },
    ];
    const basePersonLinks = [
      { externalPersonId: 'pco-a', individualId: oldId, missingFullSyncCount: 0 },
      { externalPersonId: 'pco-unlink', individualId: unlinkId, missingFullSyncCount: 0 },
    ];
    const projectedPersonLinks = [
      { externalPersonId: 'pco-a', individualId: newId, missingFullSyncCount: 0, linkSource: 'manual' },
    ];
    const localPeople = [
      { id: oldId, firstName: 'Old', lastName: 'Person', familyId: oldFamilyId, peopleType: 'regular', isChild: false, isActive: true },
      { id: newId, firstName: 'Known', lastName: 'Surname', familyId: null, peopleType: 'local_visitor', isChild: false, isActive: true },
      { id: unlinkId, firstName: 'Unlink', lastName: 'Person', familyId: null, peopleType: 'regular', isChild: false, isActive: true },
    ];
    const plan = emptyPlan({
      provider,
      linkPeople: [{
        id: `linkPeople:pco-new:${oldId}`, externalPersonId: 'pco-new',
        individualId: oldId, reviewRequired: false,
      }],
      updateManagedFields: [{
        id: `updateManagedFields:pco-a:${newId}`, externalPersonId: 'pco-a', individualId: newId,
        changes: [
          { field: 'firstName', localValue: 'Known', externalValue: 'Provider' },
          { field: 'lastName', localValue: 'Surname', externalValue: null },
          { field: 'isChild', localValue: false, externalValue: true },
        ],
      }],
      promoteToRegular: [{ id: `promote:pco-a:${newId}`, externalPersonId: 'pco-a', individualId: newId }],
      moveFamily: [{ id: `move:pco-a:${newId}`, externalPersonId: 'pco-a', individualId: newId, familyId: targetFamilyId }],
      addToGathering: [{
        id: `gathering:pco-a:${newId}`, externalPersonId: 'pco-a', individualId: newId,
        gatheringTypeId: managedGatheringId, batchId: batch.id,
      }],
    });
    plan.reviewContext = buildReviewContext({
      plan,
      externalPeople: [{ id: 'pco-new', firstName: 'New', lastName: 'Identity', child: false, familyId: null }],
      localPeople,
      localFamilies: [
        { id: oldFamilyId, familyName: 'Old Household' },
        { id: targetFamilyId, familyName: 'Target Household' },
      ],
      basePersonLinks,
      projectedPersonLinks,
      baseExclusions: [],
      projectedExclusions: corrections.map(({ externalPersonId, fromIndividualId }) => ({
        externalPersonId, individualId: fromIndividualId,
      })),
      baseHolds: [
        { externalPersonId: 'pco-a', reason: 'pair_rejected' },
        { externalPersonId: 'pco-unlink', reason: 'deferred' },
      ],
      projectedHolds: [{ externalPersonId: 'pco-unlink', reason: 'pair_rejected' }],
      sourceExternalIds: new Set(['pco-a', 'pco-unlink']),
      linkCorrections: corrections,
    });

    await applyPeopleSyncPlan({
      churchId,
      provider,
      plan,
      selections: {
        ...v2Selections({ 'pco-new': { outcome: 'accept' } }),
        linkCorrections: {
          'pco-unlink': { fromIndividualId: unlinkId, outcome: 'unlink' },
          'pco-a': { fromIndividualId: oldId, outcome: 'relink', individualId: newId },
        },
      },
      userId,
      reviewedApply: reviewedApply(churchId, provider, plan, batch.id),
      authorityExpectation: { active: 'none', pending: null },
      sourcePromotion: {
        batchId: batch.id,
        expectedBaseRevision: batch.draftSourceBaseRevision,
        expectedDraftDigest: digestSourceIdentity(draft),
      },
    });

    const links = await Database.query(
      `SELECT external_person_id, individual_id FROM external_person_links
        WHERE church_id = ? AND provider = ? ORDER BY external_person_id`,
      [churchId, provider]
    );
    assert.deepEqual(links, [
      { external_person_id: 'pco-a', individual_id: newId },
      { external_person_id: 'pco-new', individual_id: oldId },
    ]);
    const people = await Database.query(
      `SELECT id, first_name, last_name, people_type, is_child, family_id, planning_center_id
         FROM individuals WHERE church_id = ? ORDER BY id`,
      [churchId]
    );
    assert.deepEqual(people, [
      { id: oldId, first_name: 'Old', last_name: 'Person', people_type: 'regular', is_child: 0, family_id: oldFamilyId, planning_center_id: 'pco-new' },
      { id: newId, first_name: 'Provider', last_name: 'Surname', people_type: 'regular', is_child: 1, family_id: targetFamilyId, planning_center_id: 'pco-a' },
      { id: unlinkId, first_name: 'Unlink', last_name: 'Person', people_type: 'regular', is_child: 0, family_id: null, planning_center_id: null },
    ]);
    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, provider), {
      exclusions: [
        { externalPersonId: 'pco-a', individualId: oldId },
        { externalPersonId: 'pco-unlink', individualId: unlinkId },
      ],
      holds: [{ externalPersonId: 'pco-unlink', reason: 'pair_rejected' }],
    });
    assert.deepEqual(await Database.query(
      `SELECT ar.individual_id, ar.present, s.notes
         FROM attendance_records ar JOIN attendance_sessions s ON s.id = ar.session_id
        WHERE ar.church_id = ?`,
      [churchId]
    ), [{ individual_id: oldId, present: 1, notes: 'Keep this attendance note' }]);
    assert.equal((await Database.query(
      'SELECT family_notes FROM families WHERE church_id = ? AND id = ?', [churchId, oldFamilyId]
    ))[0].family_notes, 'Keep this pastoral note');
    assert.equal((await Database.query(
      `SELECT COUNT(*) AS count FROM gathering_lists
        WHERE church_id = ? AND gathering_type_id = ? AND individual_id = ?`,
      [churchId, managedGatheringId, newId]
    ))[0].count, 1);
    const promoted = await batchRepository.getBatch(churchId, provider, batch.id);
    assert.deepEqual(promoted.source, draft);
    assert.equal(promoted.draftSource, null);
  });
});

test('a later apply failure rolls back corrections, review state, managed fields, and PCO IDs', async () => {
  await withTestChurchDb(async (churchId) => {
    const provider = 'planning_center';
    const oldId = await seedIndividual(churchId, { firstName: 'Old', planningCenterId: 'pco-a' });
    const newId = await seedIndividual(churchId, { firstName: 'Target' });
    const unlinkId = await seedIndividual(churchId, { firstName: 'Unlink', planningCenterId: 'pco-unlink' });
    await Database.query(
      `INSERT INTO external_person_links
         (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, ?, 'pco-a', ?, 'matched'), (?, ?, 'pco-unlink', ?, 'matched')`,
      [churchId, provider, oldId, churchId, provider, unlinkId]
    );
    await matchReviewRepository.upsertHold({
      churchId, provider, externalPersonId: 'pco-a', reason: 'pair_rejected',
    });
    const corrections = [
      { externalPersonId: 'pco-a', fromIndividualId: oldId, outcome: 'relink', individualId: newId },
      { externalPersonId: 'pco-unlink', fromIndividualId: unlinkId, outcome: 'unlink' },
    ];
    const plan = v2Plan({}, {
      provider,
      updateManagedFields: [{
        id: `update:pco-a:${newId}`, externalPersonId: 'pco-a', individualId: newId,
        changes: [{ field: 'firstName', localValue: 'Target', externalValue: 'Changed' }],
      }],
    });
    plan.reviewContext.correctionContractVersion = 1;
    plan.reviewContext.projectedEstablishedLinks = { 'pco-a': { individualId: newId } };
    plan.reviewContext.linkCorrections = corrections;
    await Database.query(`CREATE TRIGGER abort_managed_update_after_correction
      BEFORE UPDATE OF first_name ON individuals
      WHEN NEW.id = ${newId} AND NEW.first_name = 'Changed'
        AND EXISTS (
          SELECT 1 FROM external_person_links
           WHERE church_id = '${churchId}' AND provider = 'planning_center'
             AND external_person_id = 'pco-a' AND individual_id = ${newId}
        )
      BEGIN SELECT RAISE(ABORT, 'forced later apply failure'); END`);

    await assert.rejects(() => applyPeopleSyncPlan({
      churchId,
      provider,
      plan,
      selections: {
        ...v2Selections({}),
        linkCorrections: {
          'pco-a': { fromIndividualId: oldId, outcome: 'relink', individualId: newId },
          'pco-unlink': { fromIndividualId: unlinkId, outcome: 'unlink' },
        },
      },
    }), /forced later apply failure/i);

    assert.deepEqual(await Database.query(
      `SELECT external_person_id, individual_id FROM external_person_links
        WHERE church_id = ? AND provider = ? ORDER BY external_person_id`,
      [churchId, provider]
    ), [
      { external_person_id: 'pco-a', individual_id: oldId },
      { external_person_id: 'pco-unlink', individual_id: unlinkId },
    ]);
    assert.deepEqual(await Database.query(
      `SELECT id, first_name, planning_center_id FROM individuals WHERE church_id = ? ORDER BY id`,
      [churchId]
    ), [
      { id: oldId, first_name: 'Old', planning_center_id: 'pco-a' },
      { id: newId, first_name: 'Target', planning_center_id: null },
      { id: unlinkId, first_name: 'Unlink', planning_center_id: 'pco-unlink' },
    ]);
    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, provider), {
      exclusions: [],
      holds: [{ externalPersonId: 'pco-a', reason: 'pair_rejected' }],
    });
  });
});

test('reviewed people mutations and source-draft promotion commit atomically', async () => {
  await withTestChurchDb(async (churchId) => {
    const draft = { kind: 'elvanto_group', externalId: 'group-1', name: 'Members' };
    const batch = await batchRepository.createBatch({
      churchId, provider: 'elvanto', name: 'Reviewed', initialDraftSource: draft,
    });

    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ addPeople: [{ id: 'add:one', externalPersonId: 'one', firstName: 'Ada', lastName: 'Lovelace', isChild: false, familyId: null, peopleType: 'regular' }] }),
      sourcePromotion: { batchId: batch.id, expectedBaseRevision: batch.draftSourceBaseRevision, expectedDraftDigest: digestSourceIdentity(draft) },
    });

    assert.equal((await counts(churchId)).individuals, 1);
    const promoted = await batchRepository.getBatch(churchId, 'elvanto', batch.id);
    assert.deepEqual(promoted.source, draft);
    assert.equal(promoted.draftSource, null);
    assert.equal(promoted.sourceRevision, 2);
  });
});

test('a stale source promotion rolls back preceding people mutations and retains the draft', async () => {
  await withTestChurchDb(async (churchId) => {
    const draft = { kind: 'elvanto_group', externalId: 'group-1', name: 'Members' };
    const batch = await batchRepository.createBatch({
      churchId, provider: 'elvanto', name: 'Reviewed', initialDraftSource: draft,
    });

    await assert.rejects(() => applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ addPeople: [{ id: 'add:one', externalPersonId: 'one', firstName: 'Ada', lastName: 'Lovelace', isChild: false, familyId: null, peopleType: 'regular' }] }),
      sourcePromotion: { batchId: batch.id, expectedBaseRevision: batch.draftSourceBaseRevision, expectedDraftDigest: '0'.repeat(64) },
    }), (error) => error.code === 'SYNC_SOURCE_DRAFT_STALE');

    assert.equal((await counts(churchId)).individuals, 0);
    const retained = await batchRepository.getBatch(churchId, 'elvanto', batch.id);
    assert.deepEqual(retained.draftSource, draft);
    assert.equal(retained.sourceRevision, 1);
  });
});

test('a forced link collision rolls back every newly created person and family from this call', async () => {
  await withTestChurchDb(async (churchId) => {
    const before = await counts(churchId);
    assert.deepEqual(before, { individuals: 0, families: 0, links: 0 });

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addFamilies: [{ id: 'addFamilies:fam-x', familyName: 'New Family' }],
        // Two additions that collide on the SAME externalPersonId: the first
        // creates its individual and link successfully; the second creates
        // its individual but then fails to link (external_person_id already
        // claimed by a different individual_id) — forcing the whole
        // transaction, including everything above, to roll back.
        addPeople: [
          { id: 'addPeople:1', externalPersonId: 'ext-dup', firstName: 'First', lastName: 'Person', isChild: false, familyId: null, peopleType: 'regular' },
          { id: 'addPeople:2', externalPersonId: 'ext-dup', firstName: 'Second', lastName: 'Person', isChild: false, familyId: null, peopleType: 'regular' },
        ],
      }),
    }), /link collision/i);

    const after = await counts(churchId);
    assert.deepEqual(after, { individuals: 0, families: 0, links: 0 });
  });
});

test('authority activation and reconciliation share one transaction', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnectionRow(churchId, 'elvanto');
    await Database.query(
      `INSERT INTO people_sync_settings (church_id, authority_provider, pending_authority_provider)
       VALUES (?, 'none', 'planning_center')
       ON CONFLICT(church_id) DO UPDATE SET
         authority_provider = 'none', pending_authority_provider = 'planning_center'`,
      [churchId]
    );
    const plan = emptyPlan({
      addPeople: [{
        id: 'addPeople:ext-atomic', externalPersonId: 'ext-atomic', firstName: 'Atomic', lastName: 'Person',
        isChild: false, familyId: null, peopleType: 'regular',
      }],
    });

    await assert.rejects(
      applyPeopleSyncPlan({ churchId, provider: 'elvanto', plan, activateAuthority: true }),
      /pending authority switch/i
    );
    assert.deepEqual(await counts(churchId), { individuals: 0, families: 0, links: 0 });

    await Database.query(
      `UPDATE people_sync_settings SET pending_authority_provider = 'elvanto' WHERE church_id = ?`,
      [churchId]
    );
    await applyPeopleSyncPlan({ churchId, provider: 'elvanto', plan, activateAuthority: true });

    assert.deepEqual(await counts(churchId), { individuals: 1, families: 0, links: 1 });
    const [settings] = await Database.query(
      `SELECT authority_provider, pending_authority_provider FROM people_sync_settings WHERE church_id = ?`,
      [churchId]
    );
    assert.deepEqual(settings, { authority_provider: 'elvanto', pending_authority_provider: null });
  });
});

test('Planning Center authority activation requires a connection in the reconciliation transaction', async () => {
  // Catches a reviewed authority apply committing people mutations and PCO
  // authority after the church connection was disconnected.
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO people_sync_settings (church_id, authority_provider, pending_authority_provider)
       VALUES (?, 'none', 'planning_center')
       ON CONFLICT(church_id) DO UPDATE SET
         authority_provider = 'none', pending_authority_provider = 'planning_center'`,
      [churchId]
    );
    const plan = emptyPlan({
      provider: 'planning_center',
      addPeople: [{
        id: 'addPeople:pco-atomic', externalPersonId: 'pco-atomic', firstName: 'Atomic', lastName: 'PCO',
        isChild: false, familyId: null, peopleType: 'regular',
      }],
    });

    await assert.rejects(
      applyPeopleSyncPlan({ churchId, provider: 'planning_center', plan, activateAuthority: true }),
      /Planning Center connection/i
    );

    assert.deepEqual(await counts(churchId), { individuals: 0, families: 0, links: 0 });
    const [settings] = await Database.query(
      `SELECT authority_provider, pending_authority_provider FROM people_sync_settings WHERE church_id = ?`,
      [churchId]
    );
    assert.deepEqual(settings, { authority_provider: 'none', pending_authority_provider: 'planning_center' });
  });
});

test('an apply transaction rejects an authoritative plan after its authority stance was disabled', async () => {
  // Catches a long provider fetch retaining the old authoritative stance and
  // committing an archive after the church disabled that authority.
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await setAuthority(churchId, 'elvanto');
    const plan = emptyPlan({
      archive: [{ id: 'archive:stale-authority', externalPersonId: 'ext-1', individualId, reason: 'provider_state_archived' }],
    });

    await setAuthority(churchId, 'none');
    await assert.rejects(
      applyPeopleSyncPlan({
        churchId, provider: 'elvanto', plan,
        authorityExpectation: { active: 'elvanto', pending: null },
      }),
      (error) => error?.code === 'SYNC_PLAN_STALE' && error?.status === 409
    );

    const [individual] = await Database.query(
      'SELECT is_active FROM individuals WHERE church_id = ? AND id = ?', [churchId, individualId]
    );
    assert.equal(individual.is_active, 1);
  });
});

test('an apply transaction rejects an old active-source generation after concurrent promotion', async () => {
  // Catches the no-original-draft path applying archive/presence decisions
  // from a source generation that another reviewed apply already superseded.
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const batchId = await seedSyncBatch(churchId, 'elvanto');
    await Database.query(
      `UPDATE people_sync_batches
          SET source_kind = 'elvanto_group', source_external_id = 'old-source', source_name = 'Old source',
              source_revision = 4, enabled = 1
        WHERE church_id = ? AND id = ?`,
      [churchId, batchId]
    );
    const expected = [{
      batchId,
      sourceRevision: 4,
      activeSourceDigest: digestSourceIdentity({ kind: 'elvanto_group', externalId: 'old-source' }),
      draftSourceDigest: null,
      draftSourceBaseRevision: null,
      selectedSource: 'active',
    }];
    const plan = emptyPlan({
      archive: [{ id: 'archive:old-source', externalPersonId: 'ext-1', individualId, reason: 'missing_confirmed' }],
    });

    await Database.query(
      `UPDATE people_sync_batches
          SET source_external_id = 'new-source', source_name = 'New source', source_revision = 5
        WHERE church_id = ? AND id = ?`,
      [churchId, batchId]
    );
    await assert.rejects(
      applyPeopleSyncPlan({ churchId, provider: 'elvanto', plan, sourceExpectations: expected }),
      (error) => error?.code === 'SYNC_PLAN_STALE' && error?.status === 409
    );

    const [individual] = await Database.query(
      'SELECT is_active FROM individuals WHERE church_id = ? AND id = ?', [churchId, individualId]
    );
    assert.equal(individual.is_active, 1);
  });
});

test('an apply transaction rejects an Elvanto credential generation replaced during provider fetch', async () => {
  // Catches an old-account roster being applied merely because a different,
  // newly connected Elvanto account is usable by commit time.
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await seedConnectionRow(churchId, 'elvanto');
    await Database.query(
      `INSERT INTO integration_connection_generations (church_id, provider, generation)
       VALUES (?, 'elvanto', 8)`,
      [churchId]
    );
    const plan = emptyPlan({
      archive: [{ id: 'archive:old-account', externalPersonId: 'ext-1', individualId, reason: 'provider_state_archived' }],
    });

    await Database.query(
      `UPDATE integration_connection_generations
          SET generation = 9
        WHERE church_id = ? AND provider = 'elvanto'`,
      [churchId]
    );
    await assert.rejects(
      applyPeopleSyncPlan({
        churchId,
        provider: 'elvanto',
        plan,
        connectionExpectation: { generation: 8 },
        requireConnection: true,
      }),
      (error) => error?.code === 'SYNC_PLAN_STALE' && error?.status === 409
    );

    const [individual] = await Database.query(
      'SELECT is_active FROM individuals WHERE church_id = ? AND id = ?', [churchId, individualId]
    );
    assert.equal(individual.is_active, 1);
  });
});

test('an apply rejects a connection expectation that diverges from the signed plan context', async () => {
  // The apply-time CAS must consume the same generation that the reviewer
  // signed, not a parallel caller-supplied value that could drift from it.
  await withTestChurchDb(async (churchId) => {
    await seedConnectionRow(churchId, 'elvanto');
    await Database.query(
      `INSERT INTO integration_connection_generations (church_id, provider, generation)
       VALUES (?, 'elvanto', 9)`,
      [churchId]
    );

    await assert.rejects(
      applyPeopleSyncPlan({
        churchId,
        provider: 'elvanto',
        plan: emptyPlan({ sourceContext: { connectionGeneration: 8 } }),
        connectionExpectation: { generation: 9 },
        requireConnection: true,
      }),
      (error) => error?.code === 'SYNC_PLAN_STALE' && error?.status === 409
    );
  });
});

test('managed field updates ignore an isChild change whose externalValue is null', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, { firstName: 'Old' });
    await Database.query('UPDATE individuals SET is_child = 1 WHERE id = ?', [individualId]);

    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        updateManagedFields: [{
          id: 'updateManagedFields:x', externalPersonId: 'ext-1', individualId,
          changes: [
            { field: 'firstName', localValue: 'Old', externalValue: 'New' },
            { field: 'isChild', localValue: true, externalValue: null },
          ],
        }],
      }),
    });

    const [row] = await Database.query('SELECT first_name, is_child FROM individuals WHERE id = ?', [individualId]);
    assert.equal(row.first_name, 'New');
    assert.equal(row.is_child, 1);
  });
});

test('type alignment and archive/reactivate transitions apply as instructed', async () => {
  await withTestChurchDb(async (churchId) => {
    const toPromote = await seedIndividual(churchId, { peopleType: 'local_visitor' });
    const toDemote = await seedIndividual(churchId, { peopleType: 'regular' });
    const toArchive = await seedIndividual(churchId);
    const toReactivate = await seedIndividual(churchId, { isActive: false });

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        promoteToRegular: [{ id: 'p', externalPersonId: 'e1', individualId: toPromote }],
        demoteToLocalVisitor: [{ id: 'd', externalPersonId: 'e2', individualId: toDemote }],
        archive: [{ id: 'a', externalPersonId: 'e3', individualId: toArchive, reason: 'provider_state_archived' }],
        reactivate: [{ id: 'r', externalPersonId: 'e4', individualId: toReactivate }],
      }),
    });

    assert.equal(result.promoteToRegular, 1);
    assert.equal(result.demoteToLocalVisitor, 1);
    assert.equal(result.archive, 1);
    assert.equal(result.reactivate, 1);

    const rows = await Database.query(
      'SELECT id, people_type, is_active FROM individuals WHERE church_id = ? ORDER BY id', [churchId]
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.equal(byId.get(toPromote).people_type, 'regular');
    assert.equal(byId.get(toDemote).people_type, 'local_visitor');
    assert.equal(byId.get(toArchive).is_active, 0);
    assert.equal(byId.get(toReactivate).is_active, 1);
  });
});

test('a non-authoritative plan cannot modify a record locked by the active authority', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, { firstName: 'Locked' });
    await Database.query(
      `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, 'planning_center', 'pco-1', ?, 'matched')`,
      [churchId, individualId]
    );
    await setAuthority(churchId, 'planning_center');

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        authoritative: false,
        updateManagedFields: [{
          id: 'u', externalPersonId: 'elvanto-1', individualId,
          changes: [{ field: 'firstName', localValue: 'Locked', externalValue: 'Renamed' }],
        }],
      }),
    }), /managed by the active people-sync authority/i);

    const [row] = await Database.query('SELECT first_name FROM individuals WHERE id = ?', [individualId]);
    assert.equal(row.first_name, 'Locked');
  });
});

test('an authoritative plan for the SAME provider may still modify its own linked record', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, { firstName: 'Old' });
    await Database.query(
      `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, 'elvanto', 'elvanto-1', ?, 'matched')`,
      [churchId, individualId]
    );
    await setAuthority(churchId, 'elvanto');

    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        authoritative: true,
        updateManagedFields: [{
          id: 'u', externalPersonId: 'elvanto-1', individualId,
          changes: [{ field: 'firstName', localValue: 'Old', externalValue: 'New' }],
        }],
      }),
    });

    const [row] = await Database.query('SELECT first_name FROM individuals WHERE id = ?', [individualId]);
    assert.equal(row.first_name, 'New');
  });
});

test('gathering roster insert uses added_by_sync_batch_id, not the legacy PCO batch column', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const gatheringTypeId = await seedGatheringType(churchId);
    const batchId = await seedSyncBatch(churchId, 'elvanto');

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addToGathering: [{
          id: 'addToGathering:x', batchId, gatheringTypeId, externalPersonId: 'ext-1', individualId,
        }],
      }),
    });

    assert.equal(result.addToGathering, 1);
    assert.equal(result.gatheringAssigned, 1);
    const [row] = await Database.query(
      'SELECT added_by_sync_batch_id, added_by_pco_batch_id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
      [gatheringTypeId, individualId]
    );
    assert.equal(row.added_by_sync_batch_id, batchId);
    assert.equal(row.added_by_pco_batch_id, null);
  });
});

test('a manual gathering row and another batch\'s row are never removed by this batch\'s removal', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGatheringType(churchId);
    const ownerBatchId = await seedSyncBatch(churchId, 'elvanto', 'Owner');
    const otherBatchId = await seedSyncBatch(churchId, 'elvanto', 'Other');
    const manualIndividualId = await seedIndividual(churchId, { firstName: 'Manual' });
    const otherBatchIndividualId = await seedIndividual(churchId, { firstName: 'OtherBatch' });
    await seedGatheringListRow(churchId, gatheringTypeId, manualIndividualId, null);
    await seedGatheringListRow(churchId, gatheringTypeId, otherBatchIndividualId, otherBatchId);

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        // This batch's removal action names individuals it does NOT actually
        // own on the roster (manual, and another batch's) — the DELETE's own
        // WHERE clause (added_by_sync_batch_id = ownerBatchId) must leave both untouched.
        removeFromGathering: [
          { id: 'removeFromGathering:manual', batchId: ownerBatchId, gatheringTypeId, individualId: manualIndividualId },
          { id: 'removeFromGathering:other', batchId: ownerBatchId, gatheringTypeId, individualId: otherBatchIndividualId },
        ],
      }),
    });

    assert.equal(result.gatheringRemoved, 0);
    const rows = await Database.query(
      'SELECT individual_id FROM gathering_lists WHERE gathering_type_id = ? ORDER BY individual_id', [gatheringTypeId]
    );
    assert.deepEqual(rows.map((r) => r.individual_id).sort((a, b) => a - b),
      [manualIndividualId, otherBatchIndividualId].sort((a, b) => a - b));
  });
});

test('an owner batch removes its own row when no longer eligible', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGatheringType(churchId);
    const ownerBatchId = await seedSyncBatch(churchId, 'elvanto', 'Owner');
    const individualId = await seedIndividual(churchId);
    await seedGatheringListRow(churchId, gatheringTypeId, individualId, ownerBatchId);

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        removeFromGathering: [{ id: 'removeFromGathering:x', batchId: ownerBatchId, gatheringTypeId, individualId }],
      }),
    });

    assert.equal(result.removeFromGathering, 1);
    assert.equal(result.gatheringRemoved, 1);
    const rows = await Database.query('SELECT * FROM gathering_lists WHERE gathering_type_id = ?', [gatheringTypeId]);
    assert.deepEqual(rows, []);
  });
});

test('an owner batch does not remove a row while this same plan still adds that person to the gathering', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringTypeId = await seedGatheringType(churchId);
    const ownerBatchId = await seedSyncBatch(churchId, 'elvanto', 'Owner');
    const otherBatchId = await seedSyncBatch(churchId, 'elvanto', 'StillQualifies');
    const individualId = await seedIndividual(churchId);
    await seedGatheringListRow(churchId, gatheringTypeId, individualId, ownerBatchId);

    // A hand-built plan standing in for the scenario where a second enabled
    // batch still qualifies this same person for this same gathering: the
    // plan simultaneously proposes keeping them (addToGathering, sourced from
    // the other batch) and the owner batch removing its own row. Apply's own
    // internal consistency guard (on top of plan.js already never producing
    // this combination for a real plan) must prefer "stays" over "removed".
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addToGathering: [{
          id: 'addToGathering:x', batchId: otherBatchId, gatheringTypeId, externalPersonId: 'ext-1', individualId,
        }],
        removeFromGathering: [{ id: 'removeFromGathering:x', batchId: ownerBatchId, gatheringTypeId, individualId }],
      }),
    });

    assert.equal(result.removeFromGathering, 0);
    assert.equal(result.gatheringRemoved, 0);
    const rows = await Database.query('SELECT individual_id FROM gathering_lists WHERE gathering_type_id = ?', [gatheringTypeId]);
    assert.deepEqual(rows, [{ individual_id: individualId }]);
  });
});

test('an accepted ambiguous selection is applied as a manual link', async () => {
  await withTestChurchDb(async (churchId) => {
    const candidateA = await seedIndividual(churchId, { firstName: 'A' });
    const candidateB = await seedIndividual(churchId, { firstName: 'B' });

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        ambiguousPeople: [{
          id: 'ambiguousPeople:ext-1:x', externalPersonId: 'ext-1',
          candidateIndividualIds: [candidateA, candidateB], reason: 'duplicate_name',
        }],
      }),
      selections: { ambiguous: { 'ext-1': candidateB } },
    });

    assert.equal(result.linkPeople, 1);
    const [link] = await Database.query('SELECT individual_id, link_source FROM external_person_links WHERE church_id = ?', [churchId]);
    assert.equal(link.individual_id, candidateB);
    assert.equal(link.link_source, 'manual');
  });
});

test('a legacy ambiguous resolution clears the durable hold in the link transaction', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await matchReviewRepository.upsertHold({
      churchId, provider: 'elvanto', externalPersonId: 'ext-legacy', reason: 'deferred',
    });

    await applyPeopleSyncPlan({
      churchId,
      provider: 'elvanto',
      plan: emptyPlan({
        ambiguousPeople: [{
          id: 'ambiguousPeople:ext-legacy:x',
          externalPersonId: 'ext-legacy',
          candidateIndividualIds: [individualId],
          reason: 'review_deferred',
        }],
      }),
      selections: { ambiguous: { 'ext-legacy': individualId } },
    });

    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [], holds: [],
    });
  });
});

test('a planned v2 archive can be explicitly accepted without applying or counting it twice', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const plan = v2Plan({}, {
      archive: [{
        id: `archive:ext-1:${individualId}`,
        externalPersonId: 'ext-1',
        individualId,
        reason: 'confirmed_missing_full_sync',
      }],
    });

    const result = await applyPeopleSyncPlan({
      churchId,
      provider: 'elvanto',
      plan,
      selections: {
        ...v2Selections({}),
        acceptArchiveIndividualIds: [individualId],
      },
    });

    assert.equal(result.archive, 1);
    const [person] = await Database.query(
      'SELECT is_active FROM individuals WHERE church_id = ? AND id = ?',
      [churchId, individualId]
    );
    assert.equal(person.is_active, 0);
  });
});

test('a planned v2 archive is not applied unless the reviewer explicitly accepts it', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const plan = v2Plan({}, {
      archive: [{
        id: `archive:ext-1:${individualId}`,
        externalPersonId: 'ext-1',
        individualId,
        reason: 'confirmed_missing_full_sync',
      }],
    });

    const result = await applyPeopleSyncPlan({
      churchId,
      provider: 'elvanto',
      plan,
      selections: v2Selections({}),
    });

    assert.equal(result.archive, 0);
    const [person] = await Database.query(
      'SELECT is_active FROM individuals WHERE church_id = ? AND id = ?',
      [churchId, individualId]
    );
    assert.equal(person.is_active, 1);
  });
});

test('a reviewed legacy payload also requires explicit acceptance for a planned archive', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const plan = emptyPlan({
      archive: [{
        id: `archive:ext-legacy:${individualId}`,
        externalPersonId: 'ext-legacy',
        individualId,
        reason: 'confirmed_missing_full_sync',
      }],
    });
    plan.reviewContext = buildReviewContext({
      plan,
      localPeople: [{
        id: individualId,
        firstName: 'Ada',
        lastName: 'Lovelace',
        familyId: null,
        peopleType: 'regular',
        isChild: false,
        isActive: true,
      }],
      localFamilies: [],
      personLinks: [],
    });

    const result = await applyPeopleSyncPlan({
      churchId,
      provider: 'elvanto',
      plan,
      selections: {},
      reviewedApply: reviewedApply(churchId, 'elvanto', plan),
    });

    assert.equal(result.archive, 0);
    const [person] = await Database.query(
      'SELECT is_active FROM individuals WHERE church_id = ? AND id = ?',
      [churchId, individualId]
    );
    assert.equal(person.is_active, 1);
  });
});

test('accepting a planned archive cannot bypass v2 rejected-suggestion suppression', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const plan = v2Plan({
      'ext-1': reviewIdentity({
        suggestedIndividualId: individualId,
        candidateIndividualIds: [individualId],
      }),
    }, {
      linkPeople: [{
        id: 'linkPeople:ext-1', externalPersonId: 'ext-1', individualId, reviewRequired: false,
      }],
      archive: [{
        id: `archive:ext-1:${individualId}`,
        externalPersonId: 'ext-1',
        individualId,
        reason: 'confirmed_missing_full_sync',
      }],
    });

    const result = await applyPeopleSyncPlan({
      churchId,
      provider: 'elvanto',
      plan,
      selections: {
        ...v2Selections({
          'ext-1': { outcome: 'defer', excludeIndividualId: individualId },
        }),
        acceptArchiveIndividualIds: [individualId],
      },
    });

    assert.equal(result.archive, 0);
    const [person] = await Database.query(
      'SELECT is_active FROM individuals WHERE church_id = ? AND id = ?',
      [churchId, individualId]
    );
    assert.equal(person.is_active, 1);
  });
});

test('one review token cannot concurrently apply conflicting identity decisions', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstIndividualId = await seedIndividual(churchId, { firstName: 'First' });
    const secondIndividualId = await seedIndividual(churchId, { firstName: 'Second' });
    const localPeople = [
      { id: firstIndividualId, firstName: 'First', lastName: 'Lovelace', familyId: null, peopleType: 'regular', isChild: false, isActive: true },
      { id: secondIndividualId, firstName: 'Second', lastName: 'Lovelace', familyId: null, peopleType: 'regular', isChild: false, isActive: true },
    ];
    const plan = emptyPlan({
      ambiguousPeople: [{
        id: 'ambiguousPeople:ext-race:duplicate_name',
        externalPersonId: 'ext-race',
        candidateIndividualIds: [firstIndividualId, secondIndividualId],
        reason: 'duplicate_name',
      }],
    });
    plan.reviewContext = buildReviewContext({
      plan,
      externalPeople: [{ id: 'ext-race', firstName: 'External', lastName: 'Person', child: false, familyId: null }],
      localPeople,
      localFamilies: [],
      personLinks: [],
    });
    const review = reviewedApply(churchId, 'elvanto', plan);

    const results = await Promise.allSettled([
      applyPeopleSyncPlan({
        churchId, provider: 'elvanto', plan, reviewedApply: review,
        selections: v2Selections({ 'ext-race': { outcome: 'link', individualId: firstIndividualId } }),
      }),
      applyPeopleSyncPlan({
        churchId, provider: 'elvanto', plan, reviewedApply: review,
        selections: v2Selections({ 'ext-race': { outcome: 'link', individualId: secondIndividualId } }),
      }),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected?.reason?.code, 'SYNC_REVIEW_ALREADY_APPLIED');
    const links = await Database.query(
      `SELECT external_person_id, individual_id FROM external_person_links
        WHERE church_id = ? AND provider = 'elvanto'`,
      [churchId]
    );
    assert.equal(links.length, 1);
    assert.equal(['ext-race'].includes(links[0].external_person_id), true);
    assert.equal([firstIndividualId, secondIndividualId].includes(Number(links[0].individual_id)), true);
  });
});

test('distinct concurrent reviews cannot overwrite a newly committed hold or exclusion', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const localPeople = [{
      id: individualId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      familyId: null,
      peopleType: 'regular',
      isChild: false,
      isActive: true,
    }];
    const plan = emptyPlan({
      ambiguousPeople: [{
        id: 'ambiguousPeople:ext-review-race:single_candidate',
        externalPersonId: 'ext-review-race',
        candidateIndividualIds: [individualId],
        reason: 'single_candidate',
      }],
    });
    plan.reviewContext = buildReviewContext({
      plan,
      externalPeople: [{
        id: 'ext-review-race', firstName: 'External', lastName: 'Person', child: false, familyId: null,
      }],
      localPeople,
      localFamilies: [],
      personLinks: [],
      exclusions: [],
      holds: [],
    });
    const rejectingReview = reviewedApply(churchId, 'elvanto', plan);
    const acceptingReview = reviewedApply(churchId, 'elvanto', plan);
    assert.notEqual(rejectingReview.reviewToken, acceptingReview.reviewToken);

    const results = await Promise.allSettled([
      applyPeopleSyncPlan({
        churchId,
        provider: 'elvanto',
        plan,
        reviewedApply: rejectingReview,
        selections: v2Selections({
          'ext-review-race': { outcome: 'defer', excludeIndividualId: individualId },
        }),
      }),
      applyPeopleSyncPlan({
        churchId,
        provider: 'elvanto',
        plan,
        reviewedApply: acceptingReview,
        selections: v2Selections({ 'ext-review-race': { outcome: 'accept' } }),
      }),
    ]);

    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'SYNC_PLAN_STALE');
    assert.equal((await counts(churchId)).links, 0);
    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [{ externalPersonId: 'ext-review-race', individualId }],
      holds: [{ externalPersonId: 'ext-review-race', reason: 'pair_rejected' }],
    });
    const claims = await Database.query(
      'SELECT id FROM people_sync_review_applications WHERE church_id = ?',
      [churchId]
    );
    assert.equal(claims.length, 1);
  });
});

test('a reviewed apply fails stale after a local rename or family move and rolls back its token claim', async () => {
  await withTestChurchDb(async (churchId) => {
    const reviewedFamilyId = await seedFamily(churchId, 'Reviewed Household');
    const otherFamilyId = await seedFamily(churchId, 'Other Household');
    const individualId = await seedIndividual(churchId, {
      firstName: 'Reviewed', lastName: 'Person', familyId: reviewedFamilyId,
    });
    const localPeople = [{
      id: individualId,
      firstName: 'Reviewed',
      lastName: 'Person',
      familyId: reviewedFamilyId,
      peopleType: 'regular',
      isChild: false,
      isActive: true,
    }];
    const plan = emptyPlan();
    plan.reviewContext = buildReviewContext({
      plan,
      localPeople,
      localFamilies: [
        { id: reviewedFamilyId, familyName: 'Reviewed Household' },
        { id: otherFamilyId, familyName: 'Other Household' },
      ],
      personLinks: [],
    });
    const review = reviewedApply(churchId, 'elvanto', plan);

    await Database.query(
      `UPDATE individuals SET first_name = 'Renamed' WHERE church_id = ? AND id = ?`,
      [churchId, individualId]
    );
    await assert.rejects(
      applyPeopleSyncPlan({
        churchId, provider: 'elvanto', plan, selections: v2Selections({}), reviewedApply: review,
      }),
      (error) => error.code === 'SYNC_PLAN_STALE'
    );

    await Database.query(
      `UPDATE individuals SET first_name = 'Reviewed', family_id = ? WHERE church_id = ? AND id = ?`,
      [otherFamilyId, churchId, individualId]
    );
    await assert.rejects(
      applyPeopleSyncPlan({
        churchId, provider: 'elvanto', plan, selections: v2Selections({}), reviewedApply: review,
      }),
      (error) => error.code === 'SYNC_PLAN_STALE'
    );

    const claimsAfterFailures = await Database.query(
      'SELECT id FROM people_sync_review_applications WHERE church_id = ?',
      [churchId]
    );
    assert.deepEqual(claimsAfterFailures, []);

    await Database.query(
      'UPDATE individuals SET family_id = ? WHERE church_id = ? AND id = ?',
      [reviewedFamilyId, churchId, individualId]
    );
    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan, selections: v2Selections({}), reviewedApply: review,
    });
    const claimsAfterSuccess = await Database.query(
      'SELECT id FROM people_sync_review_applications WHERE church_id = ?',
      [churchId]
    );
    assert.equal(claimsAfterSuccess.length, 1);
  });
});

test('a reviewed apply fails stale when a durable link missing counter changes', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId, {
      firstName: 'Reviewed', lastName: 'Person',
    });
    await Database.query(
      `INSERT INTO external_person_links
         (church_id, provider, external_person_id, individual_id, link_source, missing_full_sync_count)
       VALUES (?, 'elvanto', 'ext-missing', ?, 'matched', 1)`,
      [churchId, individualId]
    );
    const plan = emptyPlan();
    plan.reviewContext = buildReviewContext({
      plan,
      localPeople: [{
        id: individualId,
        firstName: 'Reviewed',
        lastName: 'Person',
        familyId: null,
        peopleType: 'regular',
        isChild: false,
        isActive: true,
      }],
      localFamilies: [],
      personLinks: [{
        externalPersonId: 'ext-missing',
        individualId,
        missingFullSyncCount: 1,
      }],
    });
    const review = reviewedApply(churchId, 'elvanto', plan);

    await Database.query(
      `UPDATE external_person_links
          SET missing_full_sync_count = 0
        WHERE church_id = ? AND provider = 'elvanto' AND external_person_id = 'ext-missing'`,
      [churchId]
    );

    await assert.rejects(
      applyPeopleSyncPlan({
        churchId, provider: 'elvanto', plan, selections: v2Selections({}), reviewedApply: review,
      }),
      (error) => error.code === 'SYNC_PLAN_STALE'
    );
    const claims = await Database.query(
      'SELECT id FROM people_sync_review_applications WHERE church_id = ?',
      [churchId]
    );
    assert.deepEqual(claims, []);
  });
});

test('a failed reviewed apply rolls back its one-time token claim', async () => {
  await withTestChurchDb(async (churchId) => {
    await Database.query(
      `INSERT INTO people_sync_settings (church_id, authority_provider, pending_authority_provider)
       VALUES (?, 'none', 'planning_center')
       ON CONFLICT(church_id) DO UPDATE SET pending_authority_provider = 'planning_center'`,
      [churchId]
    );
    const plan = v2Plan({}, { provider: 'planning_center' });
    plan.reviewContext.localIdentityDigest = buildReviewContext({
      plan,
      localPeople: [],
      localFamilies: [],
      personLinks: [],
    }).localIdentityDigest;
    const review = reviewedApply(churchId, 'planning_center', plan);

    await assert.rejects(
      applyPeopleSyncPlan({
        churchId,
        provider: 'planning_center',
        plan,
        selections: v2Selections({}),
        reviewedApply: review,
        activateAuthority: true,
      }),
      /connection is required/i
    );

    const claims = await Database.query(
      'SELECT id FROM people_sync_review_applications WHERE church_id = ?',
      [churchId]
    );
    assert.deepEqual(claims, []);
  });
});

test('skipping an addPeople selection leaves that person uncreated', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addPeople: [
          { id: 'addPeople:keep', externalPersonId: 'keep-1', firstName: 'Keep', lastName: 'Me', isChild: false, familyId: null, peopleType: 'regular' },
          { id: 'addPeople:skip', externalPersonId: 'skip-1', firstName: 'Skip', lastName: 'Me', isChild: false, familyId: null, peopleType: 'regular' },
        ],
      }),
      selections: { skipExternalPersonIds: ['skip-1'] },
    });

    assert.equal(result.addPeople, 1);
    const rows = await Database.query('SELECT first_name FROM individuals WHERE church_id = ?', [churchId]);
    assert.deepEqual(rows.map((r) => r.first_name), ['Keep']);
  });
});

test('a v2 accepted deterministic suggestion links the person and clears its hold', async () => {
  // Catches v2 apply falling back to implicit plan links or forgetting that a
  // successful reviewed link resolves the durable hold for this identity.
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await matchReviewRepository.upsertHold({
      churchId, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'deferred',
    });
    const plan = v2Plan({
      'ext-1': reviewIdentity({ suggestedIndividualId: individualId, candidateIndividualIds: [individualId], held: true }),
    }, {
      linkPeople: [{ id: 'linkPeople:ext-1', externalPersonId: 'ext-1', individualId, reviewRequired: false }],
    });

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan,
      selections: v2Selections({ 'ext-1': { outcome: 'accept' } }),
    });

    assert.equal(result.linkPeople, 1);
    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [], holds: [],
    });
    const [link] = await Database.query(
      'SELECT external_person_id, individual_id FROM external_person_links WHERE church_id = ?', [churchId]
    );
    assert.deepEqual(link, { external_person_id: 'ext-1', individual_id: individualId });
  });
});

test('a v2 replacement link excludes the rejected suggestion and clears its hold', async () => {
  // Catches the legacy implicit auto-link path racing the explicit replacement
  // and catches either durable decision being written outside the apply transaction.
  await withTestChurchDb(async (churchId) => {
    const suggestedIndividualId = await seedIndividual(churchId, { firstName: 'Suggested' });
    const replacementIndividualId = await seedIndividual(churchId, { firstName: 'Replacement' });
    await matchReviewRepository.upsertHold({
      churchId, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'deferred',
    });
    const plan = v2Plan({
      'ext-1': reviewIdentity({
        suggestedIndividualId,
        candidateIndividualIds: [suggestedIndividualId, replacementIndividualId],
        held: true,
      }),
    }, {
      manualCandidateIndividualIds: [suggestedIndividualId, replacementIndividualId],
      linkPeople: [{ id: 'linkPeople:ext-1', externalPersonId: 'ext-1', individualId: suggestedIndividualId, reviewRequired: false }],
    });

    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan,
      selections: v2Selections({
        'ext-1': { outcome: 'link', individualId: replacementIndividualId, excludeIndividualId: suggestedIndividualId },
      }),
    });

    const [link] = await Database.query(
      'SELECT individual_id, link_source FROM external_person_links WHERE church_id = ? AND external_person_id = ?',
      [churchId, 'ext-1']
    );
    assert.equal(link.individual_id, replacementIndividualId);
    assert.equal(link.link_source, 'manual');
    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [{ externalPersonId: 'ext-1', individualId: suggestedIndividualId }], holds: [],
    });
  });
});

test('a v2 create uses only signed create data, resolves its external family, and clears its hold', async () => {
  // Catches create decisions being ignored when the identity originated as a
  // suggested link, or being synthesized from unsigned plan/provider data.
  await withTestChurchDb(async (churchId) => {
    const suggestedIndividualId = await seedIndividual(churchId, { firstName: 'Not Alex' });
    const familyId = await seedFamily(churchId, 'Smith Household');
    await Database.query(
      `INSERT INTO external_family_links (church_id, provider, external_family_id, family_id, link_source)
       VALUES (?, 'planning_center', 'pco-family-1', ?, 'matched')`,
      [churchId, familyId]
    );
    await matchReviewRepository.upsertHold({
      churchId, provider: 'planning_center', externalPersonId: 'pco-1', reason: 'deferred',
    });
    const plan = v2Plan({
      'pco-1': reviewIdentity({
        suggestedIndividualId,
        candidateIndividualIds: [suggestedIndividualId],
        held: true,
        createPerson: {
          firstName: 'Alex', lastName: 'Smith', isChild: true,
          externalFamilyId: 'pco-family-1', peopleType: 'local_visitor',
        },
      }),
    }, {
      provider: 'planning_center',
      linkPeople: [{ id: 'linkPeople:pco-1', externalPersonId: 'pco-1', individualId: suggestedIndividualId, reviewRequired: false }],
      addPeople: [
        {
          id: 'addPeople:pco-1:first', externalPersonId: 'pco-1', firstName: 'Unsigned', lastName: 'First',
          isChild: false, familyId: null, peopleType: 'regular',
        },
        {
          id: 'addPeople:pco-1:duplicate', externalPersonId: 'pco-1', firstName: 'Unsigned', lastName: 'Duplicate',
          isChild: false, familyId: null, peopleType: 'regular',
        },
      ],
    });

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'planning_center', plan,
      selections: v2Selections({ 'pco-1': { outcome: 'create' } }),
    });

    assert.equal(result.addPeople, 1);
    assert.equal(result.linkPeople, 0);
    const [created] = await Database.query(
      `SELECT family_id, first_name, last_name, people_type, is_child, planning_center_id
         FROM individuals WHERE church_id = ? AND planning_center_id = 'pco-1'`,
      [churchId]
    );
    assert.deepEqual(created, {
      family_id: familyId, first_name: 'Alex', last_name: 'Smith',
      people_type: 'local_visitor', is_child: 1, planning_center_id: 'pco-1',
    });
    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, 'planning_center'), {
      exclusions: [], holds: [],
    });
  });
});

test('a v2 defer upserts a deferred hold without linking or creating the person', async () => {
  // Catches a deferred addPeople identity falling through to the legacy
  // creation path or failing to persist its durable review hold.
  await withTestChurchDb(async (churchId) => {
    const plan = v2Plan({ 'ext-1': reviewIdentity() }, {
      addPeople: [{
        id: 'addPeople:ext-1', externalPersonId: 'ext-1', firstName: 'Unsigned', lastName: 'Value',
        isChild: false, familyId: null, peopleType: 'regular',
      }],
    });

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan,
      selections: v2Selections({ 'ext-1': { outcome: 'defer' } }),
    });

    assert.equal(result.addPeople, 0);
    assert.equal(result.linkPeople, 0);
    assert.deepEqual(await counts(churchId), { individuals: 0, families: 0, links: 0 });
    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [], holds: [{ externalPersonId: 'ext-1', reason: 'deferred' }],
    });
  });
});

test('a v2 rejected pair persists both its exact exclusion and pair-rejected hold', async () => {
  // Catches pair rejection being treated as a transient skip, losing either
  // the exact candidate exclusion or the stronger hold reason.
  await withTestChurchDb(async (churchId) => {
    const suggestedIndividualId = await seedIndividual(churchId);
    const plan = v2Plan({
      'ext-1': reviewIdentity({ suggestedIndividualId, candidateIndividualIds: [suggestedIndividualId] }),
    }, {
      linkPeople: [{ id: 'linkPeople:ext-1', externalPersonId: 'ext-1', individualId: suggestedIndividualId, reviewRequired: false }],
    });

    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan,
      selections: v2Selections({ 'ext-1': { outcome: 'defer', excludeIndividualId: suggestedIndividualId } }),
    });

    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [{ externalPersonId: 'ext-1', individualId: suggestedIndividualId }],
      holds: [{ externalPersonId: 'ext-1', reason: 'pair_rejected' }],
    });
    assert.equal((await counts(churchId)).links, 0);
  });
});

test('a v2 deliberate link to an excluded pair removes that exclusion and clears its hold', async () => {
  // Catches a reviewer override establishing the link while leaving stale
  // durable state that would hide or hold the same pair on the next review.
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await matchReviewRepository.upsertExclusion({
      churchId, provider: 'elvanto', externalPersonId: 'ext-1', individualId,
    });
    await matchReviewRepository.upsertHold({
      churchId, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'pair_rejected',
    });
    const plan = v2Plan({
      'ext-1': reviewIdentity({ excludedIndividualIds: [individualId], held: true }),
    }, { manualCandidateIndividualIds: [individualId] });

    await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan,
      selections: v2Selections({ 'ext-1': { outcome: 'link', individualId } }),
    });

    assert.equal((await counts(churchId)).links, 1);
    const [link] = await Database.query(
      'SELECT link_source FROM external_person_links WHERE church_id = ? AND external_person_id = ?',
      [churchId, 'ext-1']
    );
    assert.equal(link.link_source, 'manual');
    assert.deepEqual(await matchReviewRepository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [], holds: [],
    });
  });
});

test('rejecting a v2 deterministic suggestion suppresses all dependent person, family, lifecycle, and gathering actions', async () => {
  // Catches stale dependent actions calculated for the rejected suggestion
  // mutating that local person before a fresh plan can be computed.
  await withTestChurchDb(async (churchId) => {
    const originalFamilyId = await seedFamily(churchId, 'Original');
    const targetFamilyId = await seedFamily(churchId, 'Target');
    const individualId = await seedIndividual(churchId, {
      firstName: 'Original', familyId: originalFamilyId, peopleType: 'local_visitor',
    });
    const addGatheringId = await seedGatheringType(churchId, 'Add Target');
    const removeGatheringId = await seedGatheringType(churchId, 'Remove Target');
    const batchId = await seedSyncBatch(churchId, 'elvanto');
    await seedGatheringListRow(churchId, removeGatheringId, individualId, batchId);
    const plan = v2Plan({
      'ext-1': reviewIdentity({ suggestedIndividualId: individualId, candidateIndividualIds: [individualId] }),
    }, {
      linkPeople: [{ id: 'linkPeople:ext-1', externalPersonId: 'ext-1', individualId, reviewRequired: false }],
      updateManagedFields: [{
        id: 'updateManagedFields:ext-1', externalPersonId: 'ext-1', individualId,
        changes: [{ field: 'firstName', localValue: 'Original', externalValue: 'Changed' }],
      }],
      promoteToRegular: [{ id: 'promote:ext-1', externalPersonId: 'ext-1', individualId }],
      demoteToLocalVisitor: [{ id: 'demote:ext-1', externalPersonId: 'ext-1', individualId }],
      archive: [{ id: 'archive:ext-1', externalPersonId: 'ext-1', individualId }],
      reactivate: [{ id: 'reactivate:ext-1', externalPersonId: 'ext-1', individualId }],
      moveFamily: [{ id: 'moveFamily:ext-1', externalPersonId: 'ext-1', individualId, familyId: targetFamilyId }],
      addToGathering: [{ id: 'add:ext-1', externalPersonId: 'ext-1', individualId, gatheringTypeId: addGatheringId, batchId }],
      removeFromGathering: [{ id: 'remove:ext-1', individualId, gatheringTypeId: removeGatheringId, batchId }],
    });

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan,
      selections: v2Selections({ 'ext-1': { outcome: 'defer', excludeIndividualId: individualId } }),
    });

    for (const bucket of [
      'linkPeople', 'updateManagedFields', 'promoteToRegular', 'demoteToLocalVisitor',
      'archive', 'reactivate', 'moveFamily', 'addToGathering', 'removeFromGathering',
    ]) assert.equal(result[bucket], 0, `${bucket} must be suppressed`);
    const [person] = await Database.query(
      'SELECT first_name, family_id, people_type, is_active FROM individuals WHERE id = ?', [individualId]
    );
    assert.deepEqual(person, {
      first_name: 'Original', family_id: originalFamilyId, people_type: 'local_visitor', is_active: 1,
    });
    assert.equal((await Database.query(
      'SELECT COUNT(*) AS n FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
      [addGatheringId, individualId]
    ))[0].n, 0);
    assert.equal((await Database.query(
      'SELECT COUNT(*) AS n FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
      [removeGatheringId, individualId]
    ))[0].n, 1);
  });
});

test('a later source-promotion failure rolls back every v2 identity and durable review mutation', async () => {
  // Catches v2 creates, links, exclusions, or holds escaping the transaction
  // when a later source promotion fails.
  await withTestChurchDb(async (churchId) => {
    const rejectedIndividualId = await seedIndividual(churchId, { firstName: 'Suggested' });
    const before = await counts(churchId);
    const plan = v2Plan({
      'ext-create': reviewIdentity(),
      'ext-reject': reviewIdentity({
        suggestedIndividualId: rejectedIndividualId,
        candidateIndividualIds: [rejectedIndividualId],
      }),
    }, {
      addPeople: [{
        id: 'addPeople:ext-create', externalPersonId: 'ext-create', firstName: 'Unsigned', lastName: 'Data',
        isChild: false, familyId: null, peopleType: 'regular',
      }],
      linkPeople: [{
        id: 'linkPeople:ext-reject', externalPersonId: 'ext-reject',
        individualId: rejectedIndividualId, reviewRequired: false,
      }],
    });

    await assert.rejects(() => applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan,
      selections: v2Selections({
        'ext-create': { outcome: 'create' },
        'ext-reject': { outcome: 'defer', excludeIndividualId: rejectedIndividualId },
      }),
      sourcePromotion: {
        batchId: 999999, expectedBaseRevision: 1, expectedDraftDigest: '0'.repeat(64),
      },
    }), (error) => error.code === 'SYNC_SOURCE_DRAFT_STALE');

    assert.deepEqual(await counts(churchId), before);
    assert.deepEqual(await Database.query(
      'SELECT id FROM people_sync_match_holds WHERE church_id = ?', [churchId]
    ), []);
    assert.deepEqual(await Database.query(
      'SELECT id FROM people_sync_match_exclusions WHERE church_id = ?', [churchId]
    ), []);
  });
});

test('a family rename only applies when explicitly accepted, and never invents a name', async () => {
  await withTestChurchDb(async (churchId) => {
    const familyId = await seedFamily(churchId, 'Old Name');

    const notAccepted = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ renameFamily: [{ id: 'renameFamily:x', familyId, familyName: 'New Name' }] }),
    });
    assert.equal(notAccepted.renameFamily, 0);
    assert.equal(notAccepted.familyNamesUpdated, 0);

    const accepted = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ renameFamily: [{ id: 'renameFamily:x', familyId, familyName: 'New Name' }] }),
      selections: { acceptFamilyRenameIds: ['renameFamily:x'] },
    });
    assert.equal(accepted.renameFamily, 1);
    assert.equal(accepted.familyNamesUpdated, 1);

    const [row] = await Database.query('SELECT family_name FROM families WHERE id = ?', [familyId]);
    assert.equal(row.family_name, 'New Name');

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ renameFamily: [{ id: 'renameFamily:y', familyId, familyName: '   ' }] }),
      selections: { acceptFamilyRenameIds: ['renameFamily:y'] },
    }), /missing a reviewed family name/i);
  });
});

test('moveFamily reassigns an individual to an existing family in this church only', async () => {
  await withTestChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    const familyId = await seedFamily(churchId, 'New Family');

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ moveFamily: [{ id: 'moveFamily:x', individualId, familyId }] }),
    });

    assert.equal(result.moveFamily, 1);
    const [row] = await Database.query('SELECT family_id FROM individuals WHERE id = ?', [individualId]);
    assert.equal(row.family_id, familyId);
  });
});

test('moveFamily rejects a family id from another church', async () => {
  await withTestChurchDb(async (churchId) => {
    const otherChurchId = `${churchId}_other`;
    Database.getChurchDb(otherChurchId);
    await Database.queryForChurch(otherChurchId, `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Other')`, [otherChurchId]);
    const otherFamilyId = await Database.queryForChurch(
      otherChurchId, `INSERT INTO families (church_id, family_name) VALUES (?, 'Other Family')`, [otherChurchId]
    ).then((r) => Number(r.insertId));
    const individualId = await seedIndividual(churchId);

    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({ moveFamily: [{ id: 'moveFamily:x', individualId, familyId: otherFamilyId }] }),
    }), /outside this church/i);
  });
});

test('addPeople.familyId is the EXTERNAL household id and resolves through external_family_links when linked', async () => {
  await withTestChurchDb(async (churchId) => {
    const familyId = await seedFamily(churchId, 'Lovelace Household');
    await Database.query(
      `INSERT INTO external_family_links (church_id, provider, external_family_id, family_id, link_source)
       VALUES (?, 'elvanto', 'external-a', ?, 'matched')`,
      [churchId, familyId]
    );

    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addPeople: [{
          // A non-numeric external household id — exactly the shape
          // plan.js/matcher.js produce (externalPerson.familyId), never a
          // local families.id.
          id: 'addPeople:x', externalPersonId: 'ext-1', firstName: 'Ada', lastName: 'Lovelace',
          isChild: false, familyId: 'external-a', peopleType: 'regular',
        }],
      }),
    });

    assert.equal(result.addPeople, 1);
    const [row] = await Database.query('SELECT family_id FROM individuals WHERE church_id = ?', [churchId]);
    assert.equal(row.family_id, familyId);
  });
});

test('addPeople.familyId with no matching external_family_links row leaves the person family-less, not an error', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'elvanto',
      plan: emptyPlan({
        addPeople: [{
          id: 'addPeople:x', externalPersonId: 'ext-1', firstName: 'Ada', lastName: 'Lovelace',
          isChild: false, familyId: 'external-unlinked', peopleType: 'regular',
        }],
      }),
    });

    assert.equal(result.addPeople, 1);
    const [row] = await Database.query('SELECT family_id FROM individuals WHERE church_id = ?', [churchId]);
    assert.equal(row.family_id, null);
    // Apply must never invent a family (or a family name) on this path.
    const { families } = await counts(churchId);
    assert.equal(families, 0);
  });
});

test('applyPeopleSyncPlan rejects a plan computed for a different provider', async () => {
  await withTestChurchDb(async (churchId) => {
    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'elvanto', plan: emptyPlan({ provider: 'planning_center' }),
    }), /computed for provider/i);
  });
});

test('applyPeopleSyncPlan rejects an unsupported provider', async () => {
  await withTestChurchDb(async (churchId) => {
    await assert.rejects(applyPeopleSyncPlan({
      churchId, provider: 'salesforce', plan: emptyPlan({ provider: 'salesforce' }),
    }), /unsupported people-sync provider/i);
  });
});

test('addFamilies dual-writes the legacy PCO family id only for planning_center', async () => {
  await withTestChurchDb(async (churchId) => {
    const result = await applyPeopleSyncPlan({
      churchId, provider: 'planning_center',
      plan: emptyPlan({
        provider: 'planning_center',
        addFamilies: [{ id: 'addFamilies:x', familyName: 'PCO Family', externalFamilyId: 'pco-fam-1' }],
      }),
    });
    assert.equal(result.addFamilies, 1);
    const [row] = await Database.query('SELECT planning_center_id FROM families WHERE church_id = ?', [churchId]);
    assert.equal(row.planning_center_id, 'pco-fam-1');
  });
});

test('result counts reconcile with the plan\'s own bucket sizes for a straightforward plan', async () => {
  await withTestChurchDb(async (churchId) => {
    const linked = await seedIndividual(churchId);
    const plan = emptyPlan({
      linkPeople: [{ id: 'linkPeople:x', externalPersonId: 'ext-1', individualId: linked, reviewRequired: false }],
      addPeople: [{ id: 'addPeople:x', externalPersonId: 'ext-2', firstName: 'New', lastName: 'Person', isChild: false, familyId: null, peopleType: 'regular' }],
    });
    const result = await applyPeopleSyncPlan({ churchId, provider: 'elvanto', plan });

    assert.equal(result.linkPeople, plan.linkPeople.length);
    assert.equal(result.addPeople, plan.addPeople.length);
    // Purely-informational review buckets are never mutated directly by apply.
    assert.equal(result.ambiguousPeople, 0);
    assert.equal(result.familyConflicts, 0);
    assert.equal(result.unmatchedLocalRegulars, 0);
    assert.equal(result.skipped, 0);
  });
});
