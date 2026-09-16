const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildVisitorFollowUp } = require('./visitorFollowUp');
const end = '2026-09-20';
const person = { id: 1, firstName: 'Alex', lastName: 'Guest', peopleType: 'local_visitor', isActive: 1, familyId: 10, familyName: 'Guest' };
const session = (id, date, extra = {}) => ({ id, date, gatheringId: 1, gatheringName: 'Sunday', attendanceType: 'standard', sessionStatus: 'held', rosterSnapshotted: 1, rosterProvenanceVersion: 1, excludedFromStats: 0, ...extra });
const first = session(1, '2026-09-06');
const next = session(2, '2026-09-13');
const last = session(3, end);
const record = (sessionId, extra = {}) => ({ individualId: 1, sessionId, present: 1, peopleTypeAtTime: 'local_visitor', ...extra });
function run(sessions = [first, next, last], records = [record(1)], extra = {}) {
 return buildVisitorFollowUp({ people: [person], sessions, records, caregivers: [], ...extra }, end);
}
test('two reliable following weeks produce one named priority action', () => {
 const result = run();
 assert.equal(result.groups.length, 1);
 assert.equal(result.groups[0].category, 'priority');
 assert.equal(result.groups[0].members[0].missedOpportunities, 2);
});
test('one missed week, welcome, and second visit have separate meanings', () => {
 assert.equal(run([next, last], [record(2)]).groups[0].category, 'followUp');
 assert.equal(run([last], [record(3)]).groups[0].category, 'welcome');
 assert.equal(run([next, last], [record(2), record(3)]).groups[0].category, 'returned');
});
test('cancelled, open, excluded and unrecorded sessions cannot imply absence', () => {
 for (const extra of [{sessionStatus:'cancelled'}, {sessionStatus:'open'}, {excludedFromStats:1}, {rosterProvenanceVersion:0,rosterSnapshotted:0}]) {
  assert.equal(run([first, {...next,...extra}, {...last,...extra}]).groups.length, 0);
 }
 assert.equal(run([first]).groups.length, 0);
});
test('attendance elsewhere resolves non-return even when display is gathering-filtered', () => {
 const result = buildVisitorFollowUp({people:[person], sessions:[first,next,last,session(4,end,{gatheringId:2,gatheringName:'Youth'})], records:[record(1),record(4)],caregivers:[]},end,[1]);
 assert.equal(result.groups[0].category, 'returned');
 assert.equal(result.groups[0].members[0].latestGatheringName, 'Youth');
});
test('same-day attendance is one visit and multiple gatherings are not multiple missed weeks', () => {
 assert.equal(run([last,session(4,end,{gatheringId:2})],[record(3),record(4)]).groups[0].category,'welcome');
 assert.equal(run([first,next,session(4,next.date)]).groups[0].members[0].missedOpportunities,1);
});
test('historical visitor status survives conversion, travellers are excluded, old alerts expire', () => {
 assert.equal(run(undefined,undefined,{people:[{...person,peopleType:'regular'}]}).groups[0].category,'priority');
 assert.equal(run(undefined,[record(1,{peopleTypeAtTime:'traveller_visitor'})]).groups.length,0);
 assert.equal(run([session(1,'2026-08-30'),next,last]).groups.length,0);
});
test('family members share one group but keep their different attendance evidence', () => {
 const result=run(undefined,[record(1),record(1,{individualId:2}),record(3,{individualId:2})],{people:[person,{...person,id:2,firstName:'Sam'}]});
 assert.equal(result.groups.length,1);
 assert.equal(result.groups[0].category,'priority');
 assert.deepEqual(result.groups[0].members.map(m=>m.category),['priority','returned']);
});
test('older visitors with many visits do not reappear as new or missed visitors', () => {
 assert.equal(run([session(1,'2025-01-01'),next,last],[record(1),record(2)]).groups.length,0);
});
