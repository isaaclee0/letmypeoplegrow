'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const connectionStore = require('./connectionStore');
const orchestrator = require('./orchestrator');
const { applyPeopleSyncPlan } = require('./apply');

process.env.SYNC_REVIEW_SECRET ||= 'linked-sync-disposable-test';
process.env.INTEGRATION_CREDENTIALS_KEY ||= Buffer.alloc(32, 8).toString('base64');
const provider = 'planning_center';
const fetchedAt = '2026-11-25T01:00:00Z';
const selections = { decisionContractVersion: 2, identityDecisions: {} };

async function fixture(churchId) {
  const query = (sql, ...params) => Database.query(sql, [churchId, ...params]);
  await connectionStore.upsertConnection({ churchId, provider, authType: 'oauth', credentials: { accessToken: 'offline' } });
  await query("UPDATE people_sync_settings SET authority_provider = 'planning_center' WHERE church_id = ?");
  for (const id of [10, 20, 30]) await query('INSERT INTO families(church_id,id,family_name) VALUES(?,?,?)', id, 'Local ' + id);
  const directory = new Map();
  async function person(id, external, state, familyId, householdIds) {
    const first = external || 'Unlinked';
    await query("INSERT INTO individuals(church_id,id,first_name,last_name,family_id,planning_center_id) VALUES(?,?,?,'Example',?,?)", id, first, familyId, external);
    if (external) {
      await query("INSERT INTO external_person_links(church_id,provider,external_person_id,individual_id,link_source) VALUES(?,'planning_center',?,?,'manual')", external, id);
      directory.set(external, { id: external, firstName: first, lastName: 'Example', child: false, state, familyId: householdIds?.[0] || null, householdIds });
    }
  }
  const lists = { am: [], pm: [] };
  const families = [];
  const linkedRequests = [];
  const notifications = [];
  for (const [id, name] of [[1, 'am'], [2, 'pm']]) {
    await query('INSERT INTO gathering_types(church_id,id,name) VALUES(?,?,?)', id, name);
    await query("INSERT INTO people_sync_batches(church_id,id,provider,name,gathering_type_id,source_kind,source_external_id,source_name,gathering_auto_remove_enabled) VALUES(?,?,'planning_center',?,?,'planning_center_list',?,?,1)", id, name, id, name, name);
  }
  const adapter = {
    fetchSourceSnapshot: async ({ sourceExternalId }) => ({
      provider, fetchedAt, complete: true, source: { kind: 'planning_center_list', externalId: sourceExternalId, name: sourceExternalId },
      memberExternalIds: lists[sourceExternalId], people: lists[sourceExternalId].map(id => directory.get(id)), contextPeople: [], families,
    }),
    fetchLinkedSnapshot: async ({ externalPersonIds }) => {
      linkedRequests.push([...externalPersonIds].sort());
      return { provider, fetchedAt, complete: true, people: externalPersonIds.map(id => directory.get(id)), contextPeople: [], families };
    },
    isLifecycleEligible: person => person.state === 'active',
  };
  const deps = { getProvider: () => adapter, getUnattendedProviderEnabled: async () => true,
    notifyReviewRequired: async input => notifications.push(input.counts),
    refreshBackgroundCheckStatuses: async () => ({}), refreshMedicalNoteStatuses: async () => ({}) };
  const input = { churchId, provider, batchId: 1 };
  const scheduled = (overrides = {}) => orchestrator.runUnattended(input, { ...deps, ...overrides });
  const review = () => orchestrator.buildReview({ ...input, trigger: 'manual' }, deps);
  const apply = (reviewToken, overrides = {}) => orchestrator.applyReviewed({ ...input, trigger: 'manual', reviewToken, selections }, { ...deps, ...overrides });
  return { query, directory, person, lists, families, adapter, scheduled, review, apply, notifications, linkedRequests };
}

for (const trigger of ['scheduled', 'reviewed']) {
  test(trigger + ' sync applies only clear linked changes across both lists and keeps attendance', async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    await f.person(1, 'alexa', 'archived', 10, []);
    await f.person(2, 'bea', 'archived', 10, []);
    await f.person(3, null, 'archived', 10, []);
    f.directory.set('unlinked', { id: 'unlinked', firstName: 'Unlinked', lastName: 'Example', state: 'archived', householdIds: [] });
    await f.person(4, 'cam', 'active', 10, ['hh']);
    await f.person(5, 'dev', 'active', 20, ['hh']);
    await f.person(6, 'eli', 'active', 20, []);
    await f.person(7, 'fin', 'active', 30, []);
    f.directory.get('fin').firstName = 'Finn';
    f.families.push({ id: 'hh', name: 'Example Household', memberExternalIds: ['cam','dev'], householdMemberExternalIds: ['cam','dev'] });
    f.lists.am = ['cam','unlinked'];
    await f.query('INSERT INTO gathering_lists(church_id,gathering_type_id,individual_id) VALUES(?,2,4)');
    await f.query("INSERT INTO users(church_id,id,email,role) VALUES(?,1,'someone@example.test','admin')");
    await f.query("INSERT INTO attendance_sessions(church_id,id,gathering_type_id,session_date,created_by) VALUES(?,1,2,'2026-11-22',1)");
    await f.query('INSERT INTO attendance_records(church_id,session_id,individual_id,present) VALUES(?,1,4,1)');
    if (trigger === 'scheduled') {
      const run = await f.scheduled();
      assert.equal(run.counts.archive, 2);
      assert.equal(run.status, 'applied');
      assert.deepEqual(f.notifications, []);
    } else {
      const r = await f.review();
      assert.deepEqual(r.plan.archive.filter(a => a.automatic).map(a => a.individualId).sort(), [1,2]);
      assert.equal(r.plan.familyConflicts.filter(a => a.automatic).length, 2);
      assert.equal(r.plan.removeFromGathering.filter(a => a.automatic).length, 1);
      await f.apply(r.reviewToken);
    }
    assert.deepEqual(f.linkedRequests[0], ['alexa','bea','dev','eli','fin']);
    const rows = await f.query('SELECT first_name,is_active,family_id FROM individuals WHERE church_id=? ORDER BY id');
    assert.deepEqual(rows.map(p => p.is_active), [0,0,1,1,1,1,1]);
    assert.equal(rows[3].family_id, rows[4].family_id);
    assert.ok(![10,20,null].includes(rows[3].family_id));
    assert.ok(![10,20,null,rows[3].family_id].includes(rows[5].family_id));
    assert.equal(rows[6].first_name, 'Finn');
    assert.deepEqual(await f.query('SELECT gathering_type_id,individual_id FROM gathering_lists WHERE church_id=?'), [{ gathering_type_id:1, individual_id:4 }]);
    assert.deepEqual(await f.query('SELECT individual_id,present FROM attendance_records WHERE church_id=?'), [{ individual_id:4, present:1 }]);
  }));
}

for (const trigger of ['scheduled', 'reviewed']) {
  test(trigger + ' sync leaves a matching linked household alone when an outside-list relative has unknown membership', async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    for (const [index, name] of ['april', 'chloe', 'julia', 'lara', 'matt'].entries()) {
      await f.person(index + 1, name, 'active', 10, ['king']);
      f.lists.am.push(name);
    }
    await f.query("INSERT INTO external_family_links(church_id,provider,external_family_id,family_id,link_source) VALUES(?,'planning_center','king',10,'manual')");
    f.families.push({ id:'king', name:'King Household', memberExternalIds:[...f.lists.am], householdMemberExternalIds:[...f.lists.am, 'relative'] });
    const original = f.adapter.fetchSourceSnapshot;
    f.adapter.fetchSourceSnapshot = async args => ({ ...await original(args), contextPeople:[{
      id:'relative', firstName:'Outside', lastName:'Relative', state:'active', familyId:null, householdIds:null,
    }] });
    if (trigger === 'reviewed') {
      const review = await f.review();
      for (const bucket of ['familyConflicts','renameFamily','moveFamily','addFamilies','linkFamilies','addPeople']) assert.deepEqual(review.plan[bucket], [], bucket);
      await f.apply(review.reviewToken);
    } else {
      assert.equal((await f.scheduled()).status, 'applied');
      assert.deepEqual(f.notifications, []);
    }
    assert.equal((await f.query('SELECT id FROM individuals WHERE church_id=?')).length, 5);
    assert.deepEqual((await f.query('SELECT family_id FROM individuals WHERE church_id=?')).map(p => p.family_id), [10,10,10,10,10]);
    assert.equal((await f.query('SELECT family_name FROM families WHERE church_id=? AND id=10'))[0].family_name, 'Local 10');
  }));
}

test('a proposed household move stays held and shows the outside-list relative with unknown membership', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,['hh']);
  await f.person(2,'bob','active',20,['hh']);
  f.lists.am.push('amy','bob');
  await f.query("INSERT INTO external_family_links(church_id,provider,external_family_id,family_id,link_source) VALUES(?,'planning_center','hh',10,'manual')");
  f.families.push({id:'hh', name:'Example Household', memberExternalIds:['amy','bob'], householdMemberExternalIds:['amy','bob','relative']});
  const original = f.adapter.fetchSourceSnapshot;
  f.adapter.fetchSourceSnapshot = async args => ({...await original(args), contextPeople:[{
    id:'relative',firstName:'Outside',lastName:'Relative',state:'active',familyId:null,householdIds:null,
  }]});
  const review = await f.review();
  assert.equal(review.plan.familyConflicts[0].reason,'unknown_household_membership');
  assert.equal(review.plan.familyConflicts[0].resolution,undefined);
  assert.deepEqual(review.plan.familyConflicts[0].contextMemberExternalIds,['relative']);
  assert.equal(review.plan.people.external.relative.firstName,'Outside');
  await f.apply(review.reviewToken);
  assert.deepEqual((await f.query('SELECT family_id FROM individuals WHERE church_id=? ORDER BY id')).map(p=>p.family_id),[10,20]);
  assert.equal((await f.query('SELECT id FROM individuals WHERE church_id=?')).length,2);
}));

for (const change of ['incomplete', 'identity', 'authority']) {
  test('scheduled sync fails closed on ' + change + ' and preserves the linked person', async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    await f.person(1,'alexa','archived',10,[]);
    if (change === 'incomplete') f.adapter.fetchLinkedSnapshot = async () => ({ provider, fetchedAt, complete:true, people:[], contextPeople:[], families:[] });
    const overrides = change === 'incomplete' ? {} : { applyPeopleSyncPlan: async args => {
      if (change === 'identity') await f.query("UPDATE individuals SET planning_center_id='other' WHERE church_id=? AND id=1");
      else await f.query("UPDATE people_sync_settings SET authority_provider='none' WHERE church_id=?");
      return applyPeopleSyncPlan(args);
    } };
    await assert.rejects(() => f.scheduled(overrides), error => ['SYNC_SOURCE_INCOMPLETE','SYNC_PLAN_STALE'].includes(error.code));
    assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=?'), [{ is_active:1 }]);
  }));
}

test('an exact linked family takes the provider name while a household with unrelated residents keeps its local name', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  for (const [id, name, familyId, hh] of [[1,'amy',10,'h1'],[2,'bob',20,'h2']]) {
    await f.person(id,name,'active',familyId,[hh]);
    await f.query("INSERT INTO external_family_links(church_id,provider,external_family_id,family_id,link_source) VALUES(?,'planning_center',?,?,'manual')",hh,familyId);
    f.families.push({ id:hh, name:'Provider '+familyId, memberExternalIds:[name], householdMemberExternalIds:[name] });
    f.lists.am.push(name);
  }
  await f.person(3,null,'active',20,[]);
  const r = await f.review();
  assert.deepEqual(r.plan.renameFamily.map(a => [a.familyId,a.automatic]),[[10,true]]);
  await f.apply(r.reviewToken);
  assert.deepEqual(await f.query('SELECT family_name FROM families WHERE church_id=? ORDER BY id'),[{family_name:'Provider 10'},{family_name:'Local 20'},{family_name:'Local 30'}]);
}));

test('unknown and multiple households remain visible to review while routine archives still apply', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'lucy','active',10,null);
  await f.person(2,'lou','active',20,['h1','h2']);
  await f.person(3,'lara','archived',30,[]);
  f.families.push(...['h1','h2'].map(id => ({ id, name:id, memberExternalIds:['lou'] })));
  const run = await f.scheduled();
  assert.equal(run.status,'review_required');
  assert.equal(f.notifications[0].familyConflicts,2);
  assert.equal(f.notifications[0].archive,0);
  assert.deepEqual(await f.query('SELECT family_id,is_active FROM individuals WHERE church_id=? ORDER BY id'),
    [{family_id:10,is_active:1},{family_id:20,is_active:1},{family_id:30,is_active:0}]);
}));

test('a multiply-housed relative prevents automatically moving their family even with incomplete household display data', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'anne','active',10,['hh']);
  await f.person(2,'beth','active',20,['hh','hh2']);
  await f.person(3,'cate','active',30,['hh']);
  f.lists.am = ['anne','beth','cate'];
  f.families.push({id:'hh',name:'Example',memberExternalIds:['anne','beth','cate']},{id:'hh2',name:'Other',memberExternalIds:['beth']});
  await f.scheduled();
  assert.deepEqual((await f.query('SELECT family_id FROM individuals WHERE church_id=? ORDER BY id')).map(p => p.family_id),[10,20,30]);
}));

test('an unlinked duplicate remains a distinct person with its own attendance and an identity ambiguity is held', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,null,'active',10,[]);
  await f.person(2,null,'active',20,[]);
  f.directory.set('same', {id:'same', firstName:'Unlinked', lastName:'Example',state:'active',householdIds:[],familyId:null});
  f.lists.am = ['same'];
  await f.query("INSERT INTO users(church_id,id,email,role) VALUES(?,1,'audit@example.test','admin')");
  await f.query("INSERT INTO attendance_sessions(church_id,id,gathering_type_id,session_date,created_by) VALUES(?,1,1,'2026-11-22',1)");
  for (const id of [1,2]) await f.query('INSERT INTO attendance_records(church_id,session_id,individual_id,present) VALUES(?,1,?,1)',id);
  const run = await f.scheduled();
  assert.equal(run.status,'review_required');
  assert.equal(f.notifications[0].ambiguousPeople,1);
  assert.equal((await f.query('SELECT id FROM individuals WHERE church_id=?')).length,2);
  assert.equal((await f.query('SELECT individual_id FROM attendance_records WHERE church_id=?')).length,2);
  assert.deepEqual(await f.query('SELECT individual_id FROM external_person_links WHERE church_id=?'),[]);
}));

test('supplementary records never reactivate an archived local person or acquire a foreign church link', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,[]);
  await f.person(2,'bob','archived',20,[]);
  await f.query('UPDATE individuals SET is_active=0 WHERE church_id=? AND id=1');
  await f.query("UPDATE external_person_links SET church_id='foreign' WHERE church_id=? AND individual_id=2");
  await f.scheduled();
  assert.deepEqual(f.linkedRequests,[['amy']]);
  assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=? ORDER BY id'),[{is_active:0},{is_active:1}]);
}));

test('review apply rejects a changed provider status and can retry the original unconsumed review', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','archived',10,[]);
  const r = await f.review();
  f.directory.get('amy').state = 'active';
  await assert.rejects(() => f.apply(r.reviewToken), {code:'SYNC_PLAN_STALE'});
  assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=?'),[{is_active:1}]);
  f.directory.get('amy').state = 'archived';
  await f.apply(r.reviewToken);
  assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=?'),[{is_active:0}]);
}));

test('a new enabled source during a scheduled run invalidates its complete-list inputs', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','archived',10,[]);
  await assert.rejects(() => f.scheduled({ applyPeopleSyncPlan: async args => {
    await f.query("INSERT INTO people_sync_batches(church_id,id,provider,name,source_kind,source_external_id,source_name) VALUES(?,3,'planning_center','third','planning_center_list','extra','extra')");
    return applyPeopleSyncPlan(args);
  } }), {code:'SYNC_PLAN_STALE'});
  assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=?'),[{is_active:1}]);
}));

test('a linked destination containing an unrelated person holds the move for a reviewer', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,['h']);
  await f.person(2,'bob','active',20,['h']);
  await f.person(3,null,'active',20,[]);
  await f.query("INSERT INTO external_family_links(church_id,provider,external_family_id,family_id,link_source) VALUES(?,'planning_center','h',20,'manual')");
  f.families.push({id:'h',name:'Example household',memberExternalIds:['amy','bob'], householdMemberExternalIds:['amy','bob']});
  const run = await f.scheduled();
  assert.equal(run.status,'review_required');
  assert.deepEqual((await f.query('SELECT family_id FROM individuals WHERE church_id=? ORDER BY id')).map(row => row.family_id),[10,20,20]);
}));

test('a conflicting compatibility ID in a source holds the durable person without changing their managed fields', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,[]);
  f.directory.get('amy').firstName = 'Incoming';
  f.lists.am.push('amy');
  await f.query("UPDATE individuals SET planning_center_id='other' WHERE church_id=?");
  const run = await f.scheduled();
  assert.equal(run.status,'review_required');
  assert.deepEqual(await f.query('SELECT first_name FROM individuals WHERE church_id=?'), [{first_name:'amy'}]);
  assert.deepEqual(await f.query('SELECT individual_id FROM gathering_lists WHERE church_id=?'), []);
}));

test('a saved household preference and an existing keep survive linked maintenance', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,[]);
  await f.person(2,'bob','active',10,[]);
  await f.query('INSERT INTO gathering_lists(church_id,gathering_type_id,individual_id) VALUES(?,2,1)');
  const r = await f.review();
  const { reconciliationKeepFor } = require('./reconciliation');
  const key = reconciliationKeepFor('removeFromGathering',r.plan.removeFromGathering[0]);
  await f.query("INSERT INTO people_sync_reconciliation_keeps(church_id,provider,kind,subject_key,fingerprint) VALUES(?,'planning_center',?,?,?)",key.kind,key.subjectKey,key.fingerprint);
  await f.query("INSERT INTO people_sync_local_households(church_id,provider,external_person_id,individual_id,family_id,group_id,source_fingerprint) VALUES(?,'planning_center','amy',1,10,'local',?)", 'a'.repeat(64));
  await f.scheduled();
  assert.deepEqual(await f.query('SELECT family_id FROM individuals WHERE church_id=? AND id=1'),[{family_id:10}]);
  assert.deepEqual(await f.query('SELECT individual_id FROM gathering_lists WHERE church_id=?'),[{individual_id:1}]);
}));

test('a failed gathering removal rolls back routine archives and family moves', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','archived',10,[]);
  await f.person(2,'bob','active',10,[]);
  await f.query('INSERT INTO gathering_lists(church_id,gathering_type_id,individual_id) VALUES(?,2,2)');
  Database.getChurchDb(churchId).exec("CREATE TRIGGER fail_removal BEFORE DELETE ON gathering_lists BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  await assert.rejects(() => f.scheduled(),/fixture rollback/);
  assert.deepEqual(await f.query('SELECT family_id,is_active FROM individuals WHERE church_id=? ORDER BY id'),[{family_id:10,is_active:1},{family_id:10,is_active:1}]);
  assert.deepEqual(await f.query('SELECT individual_id FROM gathering_lists WHERE church_id=?'),[{individual_id:2}]);
}));

test('a compatibility household ID owned by a third family leaves the split household for review', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,['h']);
  await f.person(2,'bob','active',20,['h']);
  await f.query("UPDATE families SET planning_center_id='h' WHERE church_id=? AND id=30");
  f.families.push({id:'h',name:'Example household',memberExternalIds:['amy','bob'], householdMemberExternalIds:['amy','bob']});
  const run = await f.scheduled();
  assert.equal(run.status,'review_required');
  assert.deepEqual((await f.query('SELECT family_id FROM individuals WHERE church_id=? ORDER BY id')).map(row => row.family_id),[10,20]);
}));

test('a competing compatibility household owner added between planning and apply invalidates the move', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,['h']);
  await f.person(2,'bob','active',20,['h']);
  f.families.push({id:'h',name:'Example household',memberExternalIds:['amy','bob'], householdMemberExternalIds:['amy','bob']});
  await assert.rejects(() => f.scheduled({ applyPeopleSyncPlan: async args => {
    await f.query("UPDATE families SET planning_center_id='h' WHERE church_id=? AND id=30");
    return applyPeopleSyncPlan(args);
  } }),{code:'SYNC_PLAN_STALE'});
  assert.deepEqual((await f.query('SELECT family_id FROM individuals WHERE church_id=? ORDER BY id')).map(row => row.family_id),[10,20]);
}));

for (const trigger of ['scheduled', 'reviewed']) {
  test(trigger + ' sync makes the linked Si family AM-only despite manually added PM assignments', async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    await f.query("INSERT INTO users(church_id,id,email,role) VALUES(?,1,'owner@example.test','admin')");
    for (const [id, external] of [[1,'si-parent'], [2,'si-spouse'], [3,'si-child']]) {
      await f.person(id, external, 'active', 10, []);
      f.lists.am.push(external);
      for (const gathering of [1, 2]) await f.query(
        'INSERT INTO gathering_lists(church_id,gathering_type_id,individual_id,added_by) VALUES(?,?,?,1)', gathering, id);
    }
    // Neither an unlinked person nor membership in another source for PM
    // may be removed merely because the first PM source omits them.
    await f.person(4, null, 'active', 20, []);
    await f.person(5, 'other-pm-member', 'active', 30, []);
    f.lists.otherPm = ['other-pm-member'];
    await f.query("INSERT INTO people_sync_batches(church_id,id,provider,name,gathering_type_id,source_kind,source_external_id,source_name,gathering_auto_remove_enabled) VALUES(?,3,'planning_center','Other PM',2,'planning_center_list','otherPm','otherPm',1)");
    for (const id of [4,5]) await f.query(
      'INSERT INTO gathering_lists(church_id,gathering_type_id,individual_id,added_by) VALUES(?,2,?,1)', id);
    await f.query("INSERT INTO attendance_sessions(church_id,id,gathering_type_id,session_date,created_by) VALUES(?,1,2,'2026-11-22',1)");
    for (const id of [1,2,3]) await f.query(
      'INSERT INTO attendance_records(church_id,session_id,individual_id,present) VALUES(?,1,?,1)', id);
    const beforeAttendance = await f.query('SELECT * FROM attendance_records WHERE church_id=? ORDER BY individual_id');
    const review = await f.review();
    assert.deepEqual(review.plan.removeFromGathering.map(action => ({
      individualId: action.individualId, gatheringTypeId: action.gatheringTypeId,
      addedBy: action.addedBy, automatic: action.automatic,
    })), [1,2,3].map(individualId => ({ individualId, gatheringTypeId: 2, addedBy: 1, automatic: true })));
    const result = trigger === 'scheduled' ? await f.scheduled() : await f.apply(review.reviewToken);
    assert.equal((result.counts || result.applied).removeFromGathering, 3);
    assert.deepEqual(await f.query('SELECT gathering_type_id,individual_id FROM gathering_lists WHERE church_id=? ORDER BY gathering_type_id,individual_id'), [
      { gathering_type_id:1, individual_id:1 }, { gathering_type_id:1, individual_id:2 }, { gathering_type_id:1, individual_id:3 },
      { gathering_type_id:2, individual_id:4 }, { gathering_type_id:2, individual_id:5 },
    ]);
    assert.deepEqual(await f.query('SELECT * FROM attendance_records WHERE church_id=? ORDER BY individual_id'), beforeAttendance);
    assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=? ORDER BY id'), Array.from({ length:5 }, () => ({ is_active:1 })));
  }));
}

for (const guard of ['disabled', 'concurrent manual', 'concurrent manual reassignment']) {
  test('legacy gathering assignment is protected when ' + guard, async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    await f.person(1, 'amy', 'active', 10, []);
    await f.query("INSERT INTO users(church_id,id,email,role) VALUES(?,1,'owner@example.test','admin')");
    await f.query("INSERT INTO users(church_id,id,email,role) VALUES(?,2,'another@example.test','admin')");
    await f.query('INSERT INTO gathering_lists(church_id,gathering_type_id,individual_id,added_by) VALUES(?,2,1,?)', guard === 'concurrent manual reassignment' ? 1 : null);
    if (guard === 'disabled') await f.query('UPDATE people_sync_batches SET gathering_auto_remove_enabled=0 WHERE church_id=? AND id=2');
    if (guard.startsWith('concurrent manual')) {
      await assert.rejects(() => f.scheduled({ applyPeopleSyncPlan: async args => {
        await f.query('UPDATE gathering_lists SET added_by=CASE WHEN added_by IS NULL THEN 1 ELSE 2 END WHERE church_id=? AND gathering_type_id=2');
        return applyPeopleSyncPlan(args);
      } }), { code:'SYNC_PLAN_STALE' });
    } else {
      const r = await f.review();
      assert.equal(r.plan.removeFromGathering.length, 1);
      assert.notEqual(r.plan.removeFromGathering[0].automatic, true);
      assert.equal((await f.scheduled()).status, 'review_required');
    }
    assert.equal((await f.query('SELECT individual_id FROM gathering_lists WHERE church_id=?')).length,1);
  }));
}

for (const issue of ['other household','missing roster','malformed roster','member absent','changed roster']) {
  test('split household holds when a reciprocal roster has ' + issue, async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    await f.person(1,'amy','active',10,['h']);
    await f.person(2,'bob','active',20,['h']);
    f.lists.am.push('amy','bob');
    const family = { id:'h', name:'Example household', memberExternalIds:['amy','bob'], householdMemberExternalIds:['amy','bob'] };
    f.families.push(family);
    if (issue === 'other household') f.families.push({id:'other', name:'Other', memberExternalIds:[], householdMemberExternalIds:['amy']});
    if (issue === 'missing roster') delete family.householdMemberExternalIds;
    if (issue === 'malformed roster') family.householdMemberExternalIds = 'amy,bob';
    if (issue === 'member absent') family.householdMemberExternalIds = ['bob'];
    if (issue === 'changed roster') {
      const original = f.adapter.fetchSourceSnapshot;
      f.adapter.fetchSourceSnapshot = async args => {
        const s = structuredClone(await original(args));
        if (args.sourceExternalId === 'pm') s.families[0].householdMemberExternalIds = ['bob'];
        return s;
      };
    }
    assert.equal((await f.scheduled()).status, 'review_required');
    assert.deepEqual((await f.query('SELECT family_id FROM individuals WHERE church_id=? ORDER BY id')).map(row => row.family_id), [10,20]);
  }));
}

for (const observedIn of ['list context','other list','review directory']) {
  test('contradictory explicit lifecycle observations in ' + observedIn + ' cannot archive', async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    await f.person(1,'amy','archived',10,[]);
    const active = { ...f.directory.get('amy'), state:'active' };
    const original = f.adapter.fetchSourceSnapshot;
    if (observedIn === 'review directory') {
      f.adapter.fetchReconciliationSnapshot = async () => ({provider,fetchedAt,complete:true,source:{kind:'all',externalId:'all',name:'Directory'},
        people:[active],contextPeople:[],memberExternalIds:['amy'],families:[]});
    } else {
      if (observedIn === 'other list') f.lists.am = ['amy'];
      f.adapter.fetchSourceSnapshot = async args => {
        const snapshot = await original(args);
        if (args.sourceExternalId !== 'pm') return snapshot;
        return observedIn === 'list context' ? { ...snapshot, contextPeople:[active] } :
          { ...snapshot, memberExternalIds:['amy'],people:[active] };
      };
    }
    await assert.rejects(observedIn === 'review directory' ? f.review : f.scheduled,{code:'SYNC_SOURCE_INCOMPLETE'});
    assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=?'), [{is_active:1}]);
  }));
}

test('an inconsistent durable identity outside Lists stays held without a provider lookup or an offered addition', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','archived',10,[]);
  await f.query("UPDATE individuals SET planning_center_id='other' WHERE church_id=?");
  const run = await f.scheduled();
  assert.equal(run.status,'review_required');
  assert.equal(f.notifications[0].ambiguousPeople,1);
  const r = await f.review();
  assert.deepEqual(r.plan.addPeople,[]);
  assert.deepEqual(r.plan.reviewContext.identities,{});
  assert.equal(r.plan.ambiguousPeople[0].reason,'stale_link');
  assert.deepEqual(f.linkedRequests,[]);
  assert.deepEqual(await f.query('SELECT planning_center_id,is_active FROM individuals WHERE church_id=?'),[{planning_center_id:'other',is_active:1}]);
}));

for (const race of ['compatibility','resident','external owner','member link']) {
  test('outside-List exact-family linking rolls back a changed ' + race, async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    await f.person(1,'amy','active',10,['h']);
    f.families.push({id:'h', name:'Resolved',memberExternalIds:['amy'],householdMemberExternalIds:['amy']});
    const r = await f.review();
    assert.equal(r.plan.linkFamilies.length,1);
    await assert.rejects(() => f.scheduled({ applyPeopleSyncPlan: async args => {
      if (race === 'compatibility') await f.query("UPDATE families SET planning_center_id='other' WHERE church_id=? AND id=10");
      if (race === 'resident') await f.person(2,null,'active',10,[]);
      if (race === 'external owner') await f.query("INSERT INTO external_family_links(church_id,provider,external_family_id,family_id,link_source) VALUES(?,'planning_center','h',30,'manual')");
      if (race === 'member link') await f.query("UPDATE individuals SET planning_center_id='other' WHERE church_id=? AND id=1");
      return applyPeopleSyncPlan(args);
    } }), {code:'SYNC_PLAN_STALE'});
    assert.deepEqual(await f.query('SELECT external_family_id FROM external_family_links WHERE church_id=? AND family_id=10'),[]);
  }));
}

test('a contradictory review-directory household prevents automatic placement from a List', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,['h']);
  await f.person(2,'bob','active',20,['h']);
  f.lists.am = ['amy','bob'];
  f.families.push({id:'h',name:'Example',memberExternalIds:['amy','bob'],householdMemberExternalIds:['amy','bob']});
  f.adapter.fetchReconciliationSnapshot = async () => ({
    provider,fetchedAt,complete:true,source:{kind:'all',externalId:'all',name:'Directory'},memberExternalIds:['amy','bob'],
    people:[...f.directory.values()],contextPeople:[],families:[
      ...f.families,{id:'other',name:'Other',memberExternalIds:[],householdMemberExternalIds:['amy']},
    ],
  });
  const r = await f.review();
  assert.ok(r.plan.familyConflicts.length);
  assert.ok(r.plan.familyConflicts.every(action => !action.automatic && !action.resolution));
  await f.apply(r.reviewToken);
  assert.deepEqual((await f.query('SELECT family_id FROM individuals WHERE church_id=? ORDER BY id')).map(row => row.family_id),[10,20]);
}));

test('a directory observation of unknown lifecycle leaves an explicit terminal observation usable', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','archived',10,[]);
  f.adapter.fetchReconciliationSnapshot = async () => ({provider,fetchedAt,complete:true,source:{kind:'all',externalId:'all',name:'Directory'},
    memberExternalIds:['amy'],people:[{...f.directory.get('amy'),state:'unknown'}],contextPeople:[],families:[]});
  const r = await f.review();
  assert.equal(r.plan.archive[0].automatic,true);
  await f.apply(r.reviewToken);
  assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=?'),[{is_active:0}]);
}));

test('an unchanged exact family can acquire its only durable household link when all members are outside Lists', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  await f.person(1,'amy','active',10,['h']);
  f.families.push({id:'h', name:'Example',memberExternalIds:['amy'],householdMemberExternalIds:['amy']});
  const run = await f.scheduled();
  assert.equal(run.counts.linkFamilies,1);
  assert.deepEqual(await f.query('SELECT external_family_id,family_id FROM external_family_links WHERE church_id=?'),[{external_family_id:'h',family_id:10}]);
}));

test('an exact family checks every existing resident without reactivating an outside-List local person', async () => withTestChurchDb(async churchId => {
  const f = await fixture(churchId);
  for (const [id,name] of [[1,'amy'],[2,'bob']]) await f.person(id,name,'active',10,['h']);
  await f.query('UPDATE individuals SET is_active=0 WHERE church_id=? AND id=2');
  f.families.push({id:'h',name:'Example',memberExternalIds:['amy','bob'],householdMemberExternalIds:['amy','bob']});
  assert.equal((await f.scheduled()).counts.linkFamilies,1);
  assert.deepEqual(await f.query('SELECT is_active FROM individuals WHERE church_id=? ORDER BY id'),[{is_active:1},{is_active:0}]);
}));

for (const change of ['rename', 'create']) {
  test('a conflicting directory name holds household ' + change + ' and invalidates the earlier review', async () => withTestChurchDb(async churchId => {
    const f = await fixture(churchId);
    await f.person(1, 'amy', 'active', 10, ['hh']);
    await f.person(2, 'bob', 'active', change === 'rename' ? 10 : 20, ['hh']);
    if (change === 'rename') {
      await f.query("INSERT INTO external_family_links(church_id,provider,external_family_id,family_id,link_source) VALUES(?,'planning_center','hh',10,'manual')");
    }
    f.lists.am = ['amy','bob'];
    const sourceFamily = { id:'hh', name:'List household', memberExternalIds:['amy','bob'], householdMemberExternalIds:['amy','bob'] };
    f.families.push(sourceFamily);
    let directoryName = sourceFamily.name;
    f.adapter.fetchReconciliationSnapshot = async () => ({
      provider, fetchedAt, complete:true, source:{kind:'all',externalId:'all',name:'Directory'},
      memberExternalIds:['amy','bob'], people:[...f.directory.values()], contextPeople:[], families:[{ ...sourceFamily, name:directoryName }],
    });
    const initial = await f.review();
    const bucket = change === 'rename' ? 'renameFamily' : 'familyConflicts';
    assert.equal(initial.plan[bucket].filter(action => action.automatic).length,1);
    directoryName = 'Directory household';
    await assert.rejects(() => f.apply(initial.reviewToken), { code:'SYNC_PLAN_STALE' });
    const held = await f.review();
    assert.ok(held.plan.familyConflicts.length);
    assert.equal(held.plan[bucket].filter(action => action.automatic).length,0);
    await f.apply(held.reviewToken);
    assert.deepEqual((await f.query('SELECT family_name FROM families WHERE church_id=? ORDER BY id')).map(row => row.family_name), ['Local 10','Local 20','Local 30']);
  }));
}
