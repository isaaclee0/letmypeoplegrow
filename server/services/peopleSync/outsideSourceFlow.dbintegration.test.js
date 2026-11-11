'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const connectionStore = require('./connectionStore');
const batchRepository = require('./batchRepository');
const { digestSourceIdentity } = require('./sourceModel');
const orchestrator = require('./orchestrator');
const { applyPeopleSyncPlan } = require('./apply');
process.env.SYNC_REVIEW_SECRET ||= 'outside-source-test-secret';
process.env.INTEGRATION_CREDENTIALS_KEY ||= Buffer.alloc(32, 5).toString('base64');

async function fixture(churchId) {
  await connectionStore.upsertConnection({churchId, provider:'planning_center', authType:'oauth', credentials:{accessToken:'offline'}, connectedBy:null, metadata:{}});
  await Database.query('UPDATE people_sync_settings SET authority_provider = ? WHERE church_id = ?', ['planning_center',churchId]);
  await Database.query("INSERT INTO families(id,church_id,family_name) VALUES(10,?,'Unknown Household')",[churchId]);
  await Database.query("INSERT INTO individuals(id,church_id,first_name,last_name,family_id,people_type) VALUES(1,?,'Nora','Example',10,'regular')",[churchId]);
  await Database.query("INSERT INTO gathering_types(id,church_id,name) VALUES(1,?,'Evening')",[churchId]);
  await Database.query("INSERT INTO users(id,church_id,email,role) VALUES(1,?,'reviewer@example.test','admin')",[churchId]);
  await Database.query("INSERT INTO attendance_sessions(id,church_id,gathering_type_id,session_date,created_by) VALUES(1,?,1,'2026-10-25',1)",[churchId]);
  await Database.query('INSERT INTO attendance_records(church_id,session_id,individual_id,present) VALUES(?,1,1,1)',[churchId]);
  const sources = ['morning','evening'].map(id=>({kind:'planning_center_list',externalId:id,name:id}));
  const batches = [];
  for(const source of sources) {
    const draft=await batchRepository.createBatch({churchId,provider:'planning_center',name:source.name,initialDraftSource:source});
    batches.push(await batchRepository.promoteSourceDraftWithConnection(Database.getChurchDb(churchId),{churchId,provider:'planning_center',batchId:draft.id,expectedBaseRevision:draft.draftSourceBaseRevision,expectedDraftDigest:digestSourceIdentity(draft.draftSource)}));
  }
  const nora={id:'nora',firstName:'Nora',lastName:'Example',state:'active',familyId:'nora-home',householdIds:['nora-home'],child:false};
  const directory={provider:'planning_center',source:{kind:'all',externalId:'all',name:'Everyone'},complete:true,fetchedAt:'2026-11-07T01:00:00Z',people:[nora],memberExternalIds:['nora'],contextPeople:[],families:[{id:'nora-home',name:'Example Household',memberExternalIds:['nora']}]};
  const snapshots=sources.map(source=>({provider:'planning_center',source,complete:true,fetchedAt:'2026-11-07T01:00:00Z',people:[],memberExternalIds:[],contextPeople:[],families:[]}));
  const deps={getProvider:()=>({fetchSourceSnapshot:async ({sourceExternalId})=>structuredClone(snapshots.find(s=>s.source.externalId===sourceExternalId)),fetchReconciliationSnapshot:async()=>structuredClone(directory),isLifecycleEligible:p=>p.state==='active'}),refreshBackgroundCheckStatuses:async()=>({}),refreshMedicalNoteStatuses:async()=>({})};
  const input={churchId,provider:'planning_center',batchId:batches[0].id,trigger:'manual'};
  return {input,deps,directory,snapshots,nora,batches};
}
const selected = {decisionContractVersion:2,identityDecisions:{},acceptArchiveIndividualIds:[1]};
const person = async churchId=>(await Database.query('SELECT is_active,planning_center_id,family_id FROM individuals WHERE church_id = ? AND id = 1',[churchId]))[0];

test('outside-list person is explicitly linked and archived in one review, preserving attendance and future reactivation',async()=>withTestChurchDb(async churchId=>{
  const {input,deps,snapshots,nora}=await fixture(churchId);
  const review=await orchestrator.buildReview(input,deps);
  assert.equal(review.plan.archive.length,1);
  assert.equal(review.plan.archive[0].reason,'outside_all_sync_sources');
  assert.equal(review.plan.archive[0].linkRequired,true);
  assert.deepEqual(review.plan.linkPeople,[]);
  assert.deepEqual(review.plan.reviewContext.identities,{});
  assert.equal((await person(churchId)).is_active,1);
  const result=await orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},deps);
  assert.notEqual(result.refreshRequired,true);
  assert.deepEqual(await person(churchId),{is_active:0,planning_center_id:'nora',family_id:10});
  assert.equal((await Database.query('SELECT * FROM external_person_links WHERE church_id = ?',[churchId])).length,1);
  assert.equal((await Database.query('SELECT * FROM attendance_records WHERE church_id = ?',[churchId])).length,1);
  const repeat=await orchestrator.buildReview(input,deps);
  assert.deepEqual(repeat.plan.archive,[]);
  snapshots[1].people=[nora]; snapshots[1].memberExternalIds=['nora']; snapshots[1].families=[{id:'nora-home',name:'Example Household',memberExternalIds:['nora']}];
  const returned=await orchestrator.buildReview(input,deps);
  assert.deepEqual(returned.plan.archive,[]);
  assert.equal(returned.plan.reactivate[0].individualId,1);
}));

test('deferring and unattended runs neither link nor archive outside-list identities',async()=>withTestChurchDb(async churchId=>{
  const {input,deps}=await fixture(churchId);
  const review=await orchestrator.buildReview(input,deps);
  assert.equal(review.plan.archive.length,1);
  await orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:{decisionContractVersion:2,identityDecisions:{}}},deps);
  await orchestrator.runUnattended({...input,trigger:'scheduled'}, {...deps,getUnattendedProviderEnabled:async()=>true,notifyReviewRequired:async()=>({})});
  assert.deepEqual(await person(churchId),{is_active:1,planning_center_id:null,family_id:10});
}));

test('membership in another enabled source protects a person and invalidates an earlier archive review',async()=>withTestChurchDb(async churchId=>{
  const {input,deps,snapshots,nora}=await fixture(churchId);
  const review=await orchestrator.buildReview(input,deps);
  assert.equal(review.plan.archive.length,1);
  snapshots[1].people=[nora]; snapshots[1].memberExternalIds=['nora'];
  await assert.rejects(()=>orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},deps),{code:'SYNC_PLAN_STALE'});
  assert.deepEqual(await person(churchId),{is_active:1,planning_center_id:null,family_id:10});
}));

test('incomplete directory and a newly duplicated PCO identity cannot authorize archive',async()=>withTestChurchDb(async churchId=>{
  const {input,deps,directory,nora}=await fixture(churchId);
  const review=await orchestrator.buildReview(input,deps);
  assert.equal(review.plan.archive.length,1);
  directory.complete=false;
  await assert.rejects(()=>orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},deps),{code:'SYNC_SOURCE_INCOMPLETE'});
  directory.complete=true; directory.people.push({...nora,id:'duplicate'}); directory.memberExternalIds.push('duplicate');
  await assert.rejects(()=>orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},deps),{code:'SYNC_PLAN_STALE'});
  assert.deepEqual(await person(churchId),{is_active:1,planning_center_id:null,family_id:10});
}));

test('compound outside-list archive cannot be applied unsigned or across churches',async()=>withTestChurchDb(async churchId=>{
  const {input,deps}=await fixture(churchId);
  const review=await orchestrator.buildReview(input,deps);
  assert.equal(review.plan.archive.length,1);
  await assert.rejects(()=>applyPeopleSyncPlan({churchId,provider:'planning_center',plan:review.plan,selections:selected}),/signed/i);
  assert.deepEqual(await person(churchId),{is_active:1,planning_center_id:null,family_id:10});
  const foreign={...selected,acceptArchiveIndividualIds:[99999]};
  await assert.rejects(()=>orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:foreign},deps),/not surfaced|not offered/i);
}));

test('archive failure rolls back the new identity link and leaves the review reusable',async()=>withTestChurchDb(async churchId=>{
  const {input,deps}=await fixture(churchId);
  const review=await orchestrator.buildReview(input,deps);
  Database.getChurchDb(churchId).exec("CREATE TRIGGER fail_test_archive BEFORE UPDATE OF is_active ON individuals WHEN NEW.is_active = 0 BEGIN SELECT RAISE(ABORT, 'test archive failure'); END;");
  await assert.rejects(()=>orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},deps),/test archive failure/);
  assert.deepEqual(await person(churchId),{is_active:1,planning_center_id:null,family_id:10});
  assert.deepEqual(await Database.query('SELECT * FROM external_person_links WHERE church_id = ?',[churchId]),[]);
  Database.getChurchDb(churchId).exec('DROP TRIGGER fail_test_archive');
  await orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},deps);
  assert.equal((await person(churchId)).is_active,0);
}));

test('an enabled batch added during apply invalidates the complete source absence claim',async()=>withTestChurchDb(async churchId=>{
  const {input,deps}=await fixture(churchId);
  const review=await orchestrator.buildReview(input,deps);
  const raced={...deps,applyPeopleSyncPlan:async args=>{
    await batchRepository.createBatch({churchId,provider:'planning_center',name:'New source',initialDraftSource:{kind:'planning_center_list',externalId:'new',name:'New source'}});
    return applyPeopleSyncPlan(args);
  }};
  await assert.rejects(()=>orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},raced),{code:'SYNC_PLAN_STALE'});
  assert.deepEqual(await person(churchId),{is_active:1,planning_center_id:null,family_id:10});
}));

test('pending source drafts suppress outside-list proposals until the full active source set is settled',async()=>withTestChurchDb(async churchId=>{
  const {input,deps}=await fixture(churchId);
  await batchRepository.createBatch({churchId,provider:'planning_center',name:'Unreviewed source',initialDraftSource:{kind:'planning_center_list',externalId:'new',name:'Unreviewed'}});
  const review=await orchestrator.buildReview(input,deps);
  assert.deepEqual(review.plan.archive,[]);
}));

test('an already-linked active person outside every source is archived without replacing the identity',async()=>withTestChurchDb(async churchId=>{
  const {input,deps}=await fixture(churchId);
  await Database.query("INSERT INTO external_person_links(church_id,provider,external_person_id,individual_id,link_source) VALUES(?,'planning_center','nora',1,'manual')",[churchId]);
  await Database.query("UPDATE individuals SET planning_center_id='nora' WHERE church_id = ? AND id=1",[churchId]);
  const review=await orchestrator.buildReview(input,deps);
  assert.equal(review.plan.archive[0].linkRequired,false);
  await orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},deps);
  assert.equal((await person(churchId)).is_active,0);
  assert.equal((await Database.query('SELECT * FROM external_person_links WHERE church_id = ?',[churchId])).length,1);
}));

test('a compatibility identity change during apply blocks an already-linked outside-list archive',async()=>withTestChurchDb(async churchId=>{
  const {input,deps}=await fixture(churchId);
  await Database.query("INSERT INTO external_person_links(church_id,provider,external_person_id,individual_id,link_source) VALUES(?,'planning_center','nora',1,'manual')",[churchId]);
  await Database.query("UPDATE individuals SET planning_center_id='nora' WHERE church_id = ? AND id=1",[churchId]);
  const review=await orchestrator.buildReview(input,deps);
  const raced={...deps,applyPeopleSyncPlan:async args=>{
    await Database.query("UPDATE individuals SET planning_center_id='different-identity' WHERE church_id = ? AND id=1",[churchId]);
    return applyPeopleSyncPlan(args);
  }};
  await assert.rejects(()=>orchestrator.applyReviewed({...input,reviewToken:review.reviewToken,selections:selected},raced),{code:'SYNC_PLAN_STALE'});
  assert.equal((await person(churchId)).is_active,1);
}));
