const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const { applyPeopleSyncPlan } = require('./apply');
const { computePeopleSyncPlan } = require('./plan');
const { loadLocalProjectionState } = require('./localProjectionState');
const { buildReviewContext } = require('./reviewContext');
const { digestPlan, createReviewToken, verifyReviewToken } = require('./planDigest');

process.env.SYNC_REVIEW_SECRET ||= 'reconciliation-disposable-test-secret';
const provider = 'planning_center';

async function fixture(churchId, { destination = 'create', roster = false, newcomer = false } = {}) {
  await Database.query(`INSERT INTO people_sync_settings (church_id, authority_provider) VALUES (?, ?) ON CONFLICT(church_id) DO UPDATE SET authority_provider = excluded.authority_provider`, [churchId, provider]);
  for (const [id, name] of [[10, 'First'], [20, 'Second']]) {
    await Database.query(`INSERT INTO families (id, church_id, family_name) VALUES (?, ?, ?)`, [id, churchId, name]);
  }
  for (const [id, name, familyId] of [[1, 'Bruce', destination === 'aligned' ? 20 : 10], [2, 'Bronwyn', 20], [3, 'Unrelated', 10]]) {
    await Database.query(`INSERT INTO individuals (id, church_id, first_name, last_name, family_id) VALUES (?, ?, ?, 'Smith', ?)`, [id, churchId, name, familyId]);
  }
  for (const [id, external] of [[1, 'bruce'], [2, 'bronwyn']]) {
    await Database.query(`INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source) VALUES (?, ?, ?, ?, 'manual')`, [churchId, provider, external, id]);
  }
  if (destination === 'existing') await Database.query(`INSERT INTO external_family_links (church_id, provider, external_family_id, family_id, link_source) VALUES (?, ?, 'hh', 20, 'manual')`, [churchId, provider]);
  await Database.query(`INSERT INTO gathering_types (id, church_id, name) VALUES (100, ?, 'Sunday')`, [churchId]);
  await Database.query(`INSERT INTO people_sync_batches (id, church_id, provider, name, gathering_type_id, source_kind, source_external_id, source_name) VALUES (7, ?, ?, 'Members', 100, 'planning_center_list', 'list', 'Members')`, [churchId, provider]);
  await Database.query(`INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id) VALUES (?, 100, 1)`, [churchId]);
  const user = await Database.query(`INSERT INTO users (church_id, email, role) VALUES (?, 'test@example.test', 'admin')`, [churchId]);
  const session = await Database.query(`INSERT INTO attendance_sessions (church_id, gathering_type_id, session_date, created_by) VALUES (?, 100, '2026-10-25', ?)`, [churchId, user.insertId]);
  await Database.query(`INSERT INTO attendance_records (church_id, session_id, individual_id, present) VALUES (?, ?, 1, 1)`, [churchId, session.insertId]);
  const state = await loadLocalProjectionState(churchId, provider);
  const externalPeople = roster ? [] : [
    { id: 'bruce', firstName: 'Bruce', lastName: 'Smith', state: 'active', familyId: destination === 'none' ? null : 'hh', householdIds: destination === 'none' ? [] : ['hh'] },
    { id: 'bronwyn', firstName: 'Bronwyn', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] },
  ];
  if (newcomer) externalPeople.push({ id: 'new', firstName: 'New', lastName: 'Smith', state: 'active', familyId: 'hh', householdIds: ['hh'] });
  const plan = computePeopleSyncPlan({
    provider, authoritative: true, snapshot: { mode: 'full', complete: true },
    externalPeople, externalFamilies: destination === 'none' || roster ? [] : [{ id: 'hh', name: 'Smith household', memberExternalIds: ['bruce', 'bronwyn', newcomer ? 'new' : 'excluded'] }],
    localPeople: state.individuals, localFamilies: state.families, personLinks: state.personLinks,
    familyLinks: state.familyLinks, gatheringMemberships: state.gatheringMemberships,
    batches: [{ id: 7, enabled: true, gatheringTypeId: 100, source: { kind: 'planning_center_list', externalId: 'list', name: 'Members' } }],
    eligibleByBatch: new Map([[7, new Set(externalPeople.map(({ id }) => id))]]),
    memberIdsByBatch: new Map([[7, new Set(externalPeople.map(({ id }) => id))]]),
    matcher: { linked: roster ? [] : state.personLinks, unmatchedExternalIds: newcomer ? ['new'] : [] },
  });
  plan.reviewContext = buildReviewContext({
    plan, externalPeople, localPeople: state.individuals, localFamilies: state.families,
    basePersonLinks: state.personLinks, projectedPersonLinks: state.personLinks,
    baseExclusions: [], projectedExclusions: [], baseHolds: [], projectedHolds: [],
    sourceExternalIds: new Set(externalPeople.map(({ id }) => id)),
  });
  const planDigest = digestPlan(plan);
  const reviewToken = createReviewToken({ operationKind: 'people_sync', churchId, provider, batchId: 7, planDigest, expiresInSeconds: 1800 });
  return {
    churchId, provider, plan, selections: { decisionContractVersion: 2, identityDecisions: {} },
    reviewedApply: { operationKind: 'people_sync', reviewToken, planDigest, batchId: 7, verifyReviewToken },
  };
}

async function historyUnchanged(churchId) {
  const rows = await Database.query(`SELECT individual_id, present FROM attendance_records WHERE church_id = ?`, [churchId]);
  assert.deepEqual(rows.map(({ individual_id, present }) => [individual_id, present]), [[1, 1]]);
}

for (const destination of ['create', 'existing', 'none']) {
  test(`selected household resolution ${destination} is transactional and preserves unrelated family members and attendance`, async () => {
    await withTestChurchDb(async (churchId) => {
      const request = await fixture(churchId, { destination });
      assert.equal(request.plan.familyConflicts.filter((action) => action.resolution).length, 1);
      request.selections.acceptFamilyResolutionIds = [request.plan.familyConflicts[0].id];
      const result = await applyPeopleSyncPlan(request);
      const rows = await Database.query(`SELECT id, family_id FROM individuals WHERE church_id = ? ORDER BY id`, [churchId]);
      assert.equal(rows[2].family_id, 10);
      if (destination === 'none') {
        assert.ok(![null, 10, 20].includes(rows[0].family_id));
        const [personal] = await Database.query('SELECT family_name, planning_center_id FROM families WHERE church_id = ? AND id = ?', [churchId, rows[0].family_id]);
        assert.equal(personal.family_name, 'SMITH, Bruce');
        assert.equal(personal.planning_center_id, null);
        assert.equal((await Database.query('SELECT COUNT(*) n FROM external_family_links WHERE church_id = ?', [churchId]))[0].n, 0);
      }
      else {
        assert.equal(rows[0].family_id, rows[1].family_id);
        if (destination === 'existing') assert.equal(rows[0].family_id, 20);
        else assert.ok(![10, 20].includes(rows[0].family_id));
        const links = await Database.query(`SELECT family_id FROM external_family_links WHERE church_id = ? AND provider = ? AND external_family_id = 'hh'`, [churchId, provider]);
        assert.equal(links[0].family_id, rows[0].family_id);
      }
      assert.equal(result.familyConflicts, 1);
      assert.equal(result.moveFamily, destination === 'create' ? 2 : 1);
      assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM individuals WHERE church_id = ?`, [churchId]))[0].n, 3);
      assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM families WHERE church_id = ? AND id IN (10,20)`, [churchId]))[0].n, 2);
      await historyUnchanged(churchId);
    });
  });
}

test('unattended/default selections leave household and legacy membership proposals unchanged', async () => {
  await withTestChurchDb(async (churchId) => {
    const request = await fixture(churchId);
    delete request.reviewedApply;
    const result = await applyPeopleSyncPlan(request);
    assert.equal(result.moveFamily, 0);
    assert.deepEqual((await Database.query(`SELECT family_id FROM individuals WHERE church_id = ? ORDER BY id`, [churchId])).map((row) => row.family_id), [10, 20, 10]);
    await historyUnchanged(churchId);
  });
});

test('selected legacy removal deletes only the unowned attendance-list row, preserving person and attendance', async () => {
  await withTestChurchDb(async (churchId) => {
    const request = await fixture(churchId, { roster: true });
    assert.equal(request.plan.removeFromGathering.length, 1);
    request.selections.acceptGatheringRemovalIds = [request.plan.removeFromGathering[0].id];
    const result = await applyPeopleSyncPlan(request);
    assert.equal(result.gatheringRemoved, 1);
    assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM gathering_lists WHERE church_id = ?`, [churchId]))[0].n, 0);
    assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM individuals WHERE church_id = ?`, [churchId]))[0].n, 3);
    await historyUnchanged(churchId);
  });
});

for (const scenario of ['changed-family-link', 'changed-roster-provenance', 'new-source', 'unsigned']) {
  test(`apply rejects ${scenario} and rolls back reviewed corrections`, async () => {
    await withTestChurchDb(async (churchId) => {
      const roster = scenario === 'changed-roster-provenance' || scenario === 'new-source';
      const request = await fixture(churchId, { roster });
      if (roster) request.selections.acceptGatheringRemovalIds = [request.plan.removeFromGathering[0].id];
      else request.selections.acceptFamilyResolutionIds = [request.plan.familyConflicts[0].id];
      if (scenario === 'changed-family-link') await Database.query(`INSERT INTO external_family_links (church_id, provider, external_family_id, family_id, link_source) VALUES (?, ?, 'hh', 20, 'manual')`, [churchId, provider]);
      if (scenario === 'changed-roster-provenance') await Database.query(`UPDATE gathering_lists SET added_by_sync_batch_id = 7 WHERE church_id = ?`, [churchId]);
      if (scenario === 'new-source') await Database.query(`INSERT INTO people_sync_batches (church_id, provider, name, gathering_type_id) VALUES (?, ?, 'New source', 100)`, [churchId, provider]);
      if (scenario === 'unsigned') delete request.reviewedApply;
      await assert.rejects(applyPeopleSyncPlan(request), /stale|changed|signed|review/i);
      assert.deepEqual((await Database.query(`SELECT family_id FROM individuals WHERE church_id = ? ORDER BY id`, [churchId])).map((row) => row.family_id), [10, 20, 10]);
      assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM people_sync_review_applications WHERE church_id = ?`, [churchId]))[0].n, 0);
      await historyUnchanged(churchId);
    });
  });
}

test('legacy removals remain a no-op without explicit selection, including unattended apply', async () => {
  await withTestChurchDb(async (churchId) => {
    const request = await fixture(churchId, { roster: true });
    delete request.reviewedApply;
    const result = await applyPeopleSyncPlan(request);
    assert.equal(result.gatheringRemoved, 0);
    assert.equal(result.removeFromGathering, 0);
    assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM gathering_lists WHERE church_id = ?`, [churchId]))[0].n, 1);
    await historyUnchanged(churchId);
  });
});

test('a foreign-church household destination is rejected even in a malformed internally signed proposal', async () => {
  await withTestChurchDb(async (churchId) => {
    const request = await fixture(churchId);
    await Database.query(`INSERT INTO families (id, church_id, family_name) VALUES (99, 'other-church', 'Private family')`);
    request.plan.familyConflicts[0].resolution.destination = { kind: 'existing', familyId: 99, familyName: 'Private family' };
    request.selections.acceptFamilyResolutionIds = [request.plan.familyConflicts[0].id];
    request.reviewedApply.planDigest = digestPlan(request.plan);
    request.reviewedApply.reviewToken = createReviewToken({
      operationKind: 'people_sync', churchId, provider, batchId: 7,
      planDigest: request.reviewedApply.planDigest, expiresInSeconds: 1800,
    });
    await assert.rejects(applyPeopleSyncPlan(request), (error) => error.code === 'SYNC_PLAN_STALE');
    assert.deepEqual((await Database.query(`SELECT family_id FROM individuals WHERE church_id = ? ORDER BY id`, [churchId])).map((row) => row.family_id), [10, 20, 10]);
    assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM people_sync_review_applications WHERE church_id = ?`, [churchId]))[0].n, 0);
    await historyUnchanged(churchId);
  });
});

test('a source on another provider protects legacy membership at both planning and apply boundaries', async () => {
  await withTestChurchDb(async (churchId) => {
    const request = await fixture(churchId, { roster: true });
    request.selections.acceptGatheringRemovalIds = [request.plan.removeFromGathering[0].id];
    await Database.query(`INSERT INTO people_sync_batches (church_id, provider, name, gathering_type_id) VALUES (?, 'elvanto', 'Other provider source', 100)`, [churchId]);
    const state = await loadLocalProjectionState(churchId, provider);
    assert.equal(state.gatheringMemberships[0].hasOtherProviderSources, true);
    await assert.rejects(applyPeopleSyncPlan(request), (error) => error.code === 'SYNC_PLAN_STALE');
    assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM gathering_lists WHERE church_id = ?`, [churchId]))[0].n, 1);
    await historyUnchanged(churchId);
  });
});

test('a legacy PCO batch claiming a roster row after review blocks removal and preserves attendance', async () => {
  await withTestChurchDb(async (churchId) => {
    const request = await fixture(churchId, { roster: true });
    request.selections.acceptGatheringRemovalIds = [request.plan.removeFromGathering[0].id];
    await Database.query(`INSERT INTO planning_center_sync_batches (id, church_id, name, gathering_type_id) VALUES (9, ?, 'Legacy Sunday', 100)`, [churchId]);
    await Database.query(`UPDATE gathering_lists SET added_by_pco_batch_id = 9 WHERE church_id = ? AND gathering_type_id = 100 AND individual_id = 1`, [churchId]);
    await assert.rejects(applyPeopleSyncPlan(request), (error) => error.code === 'SYNC_PLAN_STALE');

    const state = await loadLocalProjectionState(churchId, provider);
    assert.deepEqual(state.gatheringMemberships.map(({ addedByPcoBatchId, addedBySyncBatchId }) => [addedByPcoBatchId, addedBySyncBatchId]), [[9, null]]);
    assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM people_sync_review_applications WHERE church_id = ?`, [churchId]))[0].n, 0);
    await historyUnchanged(churchId);
  });
});

test('planner and signed apply link an already-aligned household without importing excluded members or moving anyone', async () => {
  await withTestChurchDb(async (churchId) => {
    const request = await fixture(churchId, { destination: 'aligned' });
    assert.deepEqual(request.plan.familyConflicts, []);
    assert.equal(request.plan.linkFamilies.length, 1);
    assert.deepEqual(request.plan.addPeople, []);
    const result = await applyPeopleSyncPlan(request);
    assert.equal(result.linkFamilies, 1);
    assert.equal(result.moveFamily, 0);
    assert.equal(result.addFamilies, 0);
    assert.equal(result.addPeople, 0);
    assert.deepEqual((await Database.query(`SELECT family_id FROM individuals WHERE church_id = ? ORDER BY id`, [churchId])).map((row) => row.family_id), [20, 20, 10]);
    const links = await Database.query(`SELECT external_family_id, family_id FROM external_family_links WHERE church_id = ? AND provider = ?`, [churchId, provider]);
    assert.deepEqual(links, [{ external_family_id: 'hh', family_id: 20 }]);
    assert.equal((await Database.query(`SELECT COUNT(*) AS n FROM individuals WHERE church_id = ?`, [churchId]))[0].n, 3);
    await historyUnchanged(churchId);
  });
});

for (const outcome of ['create', 'defer']) {
  test(`signed ${outcome} decision for a newcomer in an already-aligned household`, async () => {
    await withTestChurchDb(async (churchId) => {
      const request = await fixture(churchId, { destination: 'aligned', newcomer: true });
      assert.equal(request.plan.reviewContext.identities.new.createPerson.externalFamilyId, 'hh');
      request.selections.identityDecisions.new = { outcome };
      const result = await applyPeopleSyncPlan(request);
      const newcomerRows = await Database.query(
        `SELECT i.family_id FROM individuals i JOIN external_person_links l ON l.individual_id = i.id AND l.church_id = i.church_id
         WHERE i.church_id = ? AND l.provider = ? AND l.external_person_id = 'new'`, [churchId, provider]);
      assert.deepEqual(newcomerRows, outcome === 'create' ? [{ family_id: 20 }] : []);
      assert.equal(result.linkFamilies, 1);
      assert.equal(result.addFamilies, 0);
      assert.equal(result.moveFamily, 0);
      assert.equal(result.addPeople, outcome === 'create' ? 1 : 0);
      assert.deepEqual(request.plan.familyConflicts, []);
      await historyUnchanged(churchId);
    });
  });
}
