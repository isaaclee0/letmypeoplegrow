const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sqlite = require('better-sqlite3');
const db = new Sqlite(':memory:');
// Exercise the production SELECTs without opening or migrating any church files.
const databasePath = require.resolve('../config/database');
require.cache[databasePath] = { id: databasePath, filename: databasePath, loaded: true, exports: {
  queryForChurch: async (churchId, sql, params) => {
    assert.ok(params.includes(churchId));
    return db.prepare(sql).all(...params);
  },
} };
const { getVisitorFollowUp, completedWeekEnd } = require('./visitorFollowUp');
db.exec(`
 CREATE TABLE church_settings(church_id TEXT, timezone TEXT);
 CREATE TABLE individuals(id INTEGER,first_name TEXT,last_name TEXT,people_type TEXT,is_active INTEGER,family_id INTEGER,church_id TEXT);
 CREATE TABLE families(id INTEGER,family_name TEXT,church_id TEXT);
 CREATE TABLE gathering_types(id INTEGER,name TEXT,attendance_type TEXT,church_id TEXT);
 CREATE TABLE attendance_sessions(id INTEGER,session_date TEXT,gathering_type_id INTEGER,session_status TEXT,excluded_from_stats INTEGER,roster_snapshotted INTEGER,roster_provenance_version INTEGER,church_id TEXT);
 CREATE TABLE attendance_records(individual_id INTEGER,session_id INTEGER,present INTEGER,people_type_at_time TEXT,church_id TEXT);
 CREATE TABLE family_caregivers(family_id INTEGER,caregiver_type TEXT,user_id INTEGER,contact_id INTEGER,church_id TEXT);
 CREATE TABLE users(id INTEGER,first_name TEXT,last_name TEXT,is_active INTEGER,church_id TEXT);
 CREATE TABLE contacts(id INTEGER,first_name TEXT,last_name TEXT,is_active INTEGER,church_id TEXT);
 INSERT INTO church_settings VALUES('a','Australia/Hobart'),('b','UTC');
 INSERT INTO individuals VALUES(1,'Alex','Guest','regular',1,1,'a'),(1,'Other','Church','local_visitor',1,1,'b');
 INSERT INTO families VALUES(1,'Guest','a'),(1,'Secret','b');
 INSERT INTO gathering_types VALUES(1,'Sunday','standard','a'),(1,'Other service','standard','b');
 INSERT INTO attendance_sessions VALUES(1,'2026-09-06',1,'held',0,1,1,'a'),(2,'2026-09-13',1,'held',0,1,1,'a'),(3,'2026-09-20',1,'held',0,1,1,'a'),(1,'2026-09-20',1,'held',0,1,1,'b');
 INSERT INTO attendance_records VALUES(1,1,1,'local_visitor','a'),(1,1,1,'local_visitor','b');
 INSERT INTO users VALUES(1,'Care','Leader',1,'a'),(1,'Secret','Leader',1,'b');
 INSERT INTO family_caregivers VALUES(1,'user',1,NULL,'a'),(1,'user',1,NULL,'b');
`);
test('loader uses church-local completed week and isolates every joined source', async()=>{
 const result = await getVisitorFollowUp('a',{now:new Date('2026-09-20T21:00:00Z')});
 assert.equal(result.asOf,'2026-09-20');
 assert.equal(result.groups.length,1);
 assert.equal(result.groups[0].category,'priority');
 assert.deepEqual(result.groups[0].caregivers,['Care Leader']);
 assert.doesNotMatch(JSON.stringify(result),/Secret|Other/);
 const other=await getVisitorFollowUp('b',{now:new Date('2026-09-21T01:00:00Z')});
 assert.equal(other.groups[0].category,'welcome');
 assert.equal(other.groups[0].members[0].name,'Other Church');
 assert.equal((await getVisitorFollowUp('a',{now:new Date('2026-09-21T01:00:00Z'),gatheringIds:[999]})).groups.length,0);
});
test('Sunday is still in progress; Monday begins the new reporting window',()=>{
 assert.equal(completedWeekEnd(new Date('2026-09-20T10:00:00Z'),'Australia/Hobart'),'2026-09-13');
 assert.equal(completedWeekEnd(new Date('2026-09-20T14:01:00Z'),'Australia/Hobart'),'2026-09-20');
});
