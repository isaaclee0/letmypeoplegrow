const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const DB = require('better-sqlite3');
const { CHURCH_SCHEMA, REGISTRY_SCHEMA } = require('../config/schema');
const { run } = require('./split-pilgrim-hill');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilgrim-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'churches'));
  const db = new DB(path.join(root, 'churches/redeemer.sqlite'));
  db.exec(CHURCH_SCHEMA);
  db.exec(`INSERT INTO church_settings (church_id,church_name) VALUES ('redeemer','Redeemer Christian Church');
    INSERT INTO users (id,church_id,first_name,last_name,email,role) VALUES
    (101,'redeemer','Isaac','Lee','isaac@example.test','admin'),
    (102,'redeemer','Peirce','Baehr','peirce@example.test','attendance_taker'),
    (103,'redeemer','Miriam','Kewley','miriam@example.test','attendance_taker'),
    (104,'redeemer','Naomi','Kewley','naomi@example.test','attendance_taker');
    INSERT INTO gathering_types (id,church_id,name,attendance_type,created_by) VALUES
    (21,'redeemer','2025 Pilgrim Artists Festivall - Hub','headcount',101),
    (22,'redeemer','2025 Pilgrim Artists Festival - Hall','headcount',101),
    (23,'redeemer','Sunday Service','standard',101);
    INSERT INTO attendance_sessions (id,church_id,gathering_type_id,session_date,created_by) VALUES
    (31,'redeemer',21,'2025-09-12',102),(32,'redeemer',22,'2025-09-12',101),(33,'redeemer',23,'2025-09-14',101);
    INSERT INTO headcount_records (session_id,church_id,headcount,updated_by) VALUES (31,'redeemer',78,102),(32,'redeemer',9,104);
    INSERT INTO user_gathering_assignments (user_id,gathering_type_id,church_id,assigned_by) VALUES
    (102,21,'redeemer',101),(103,21,'redeemer',101),(104,22,'redeemer',101),(101,23,'redeemer',101);
    INSERT INTO audit_log (user_id,action,new_values,church_id) VALUES (102,'UPDATE_HEADCOUNT','{"serviceName":"2025 Pilgrim Artists Festivall - Hub","headcount":78}','redeemer');`);
  const registry = new DB(path.join(root, 'registry.sqlite'));
  registry.exec(REGISTRY_SCHEMA);
  registry.exec("INSERT INTO churches (church_id,church_name,is_approved) VALUES ('redeemer','Redeemer Christian Church',1)");
  for (const u of db.prepare('SELECT * FROM users').all()) registry.prepare('INSERT INTO user_lookup (user_id,email,church_id) VALUES (?,?,?)').run(u.id,u.email,'redeemer');
  db.close(); registry.close();
  return { dataDir: root, sourceId: 'redeemer', targetId: 'pil_test' };
}
function read(options, church = 'redeemer') { return new DB(path.join(options.dataDir, 'churches', church+'.sqlite')); }

test('dry run rehearses the complete split without changing original files', async t => {
  const opts=fixture(t), before=fs.readFileSync(path.join(opts.dataDir,'churches/redeemer.sqlite'));
  const report=await run(opts);
  assert.equal(report.mode,'dry-run'); assert.equal(report.headcountTotal,87);
  assert.deepEqual(fs.readFileSync(path.join(opts.dataDir,'churches/redeemer.sqlite')),before);
  assert(!fs.existsSync(path.join(opts.dataDir,'churches/pil_test.sqlite')));
});
test('apply preserves history, moves three accounts, links admin, and refuses repeat', async t => {
  const opts=fixture(t);
  const report=await run({...opts,apply:true,maintenanceConfirmed:true});
  const source=read(opts),target=read(opts,'pil_test');
  assert.equal(source.prepare('SELECT count(*) n FROM users').get().n,1);
  assert.equal(source.prepare('SELECT count(*) n FROM attendance_sessions').get().n,1);
  assert.equal(target.prepare('SELECT sum(headcount) n FROM headcount_records').get().n,87);
  assert.deepEqual(target.pragma('foreign_key_check'),[]);
  assert.equal(target.prepare('SELECT role FROM users WHERE id=101').get().role,'admin');
  assert.equal(target.prepare('SELECT count(*) n FROM individuals').get().n,0);
  source.close();target.close();
  const r=new DB(path.join(opts.dataDir,'registry.sqlite'));
  assert.equal(r.prepare("SELECT count(*) n FROM user_lookup WHERE church_id='redeemer'").get().n,1);
  assert.equal(r.prepare("SELECT count(*) n FROM user_lookup WHERE church_id='pil_test'").get().n,4);
  const admin=r.prepare('SELECT person_id FROM user_lookup WHERE user_id=101').all();
  assert(admin[0].person_id); assert.equal(admin[0].person_id,admin[1].person_id);r.close();
  assert(fs.existsSync(path.join(report.backupDirectory,'registry-before.sqlite')));
  await assert.rejects(run({...opts,apply:true,maintenanceConfirmed:true}),/already exists/i);
});
test('apply requires explicit maintenance acknowledgement', async t => {
  await assert.rejects(run({...fixture(t),apply:true}),/maintenance/i);
});
test('unexpected Redeemer dependency blocks the split without deleting anything', async t => {
  const opts=fixture(t),db=read(opts);
  db.exec("INSERT INTO user_gathering_assignments (user_id,gathering_type_id,church_id) VALUES (102,23,'redeemer')");db.close();
  await assert.rejects(run({...opts,apply:true,maintenanceConfirmed:true}),/dependency/i);
  const after=read(opts);assert.equal(after.prepare('SELECT count(*) n FROM users').get().n,4);after.close();
  assert(!fs.existsSync(path.join(opts.dataDir,'churches/pil_test.sqlite')));
});
test('failure during insertion rolls back all databases and removes unpublished target', async t => {
  const opts=fixture(t),db=read(opts);
  db.exec(`CREATE TRIGGER reject_pilgrim BEFORE INSERT ON users WHEN NEW.church_id='pil_test' BEGIN SELECT RAISE(ABORT,'test insertion failure'); END;`);db.close();
  await assert.rejects(run({...opts,apply:true,maintenanceConfirmed:true}),/test insertion failure/);
  const after=read(opts);assert.equal(after.prepare('SELECT count(*) n FROM users').get().n,4);after.close();
  const r=new DB(path.join(opts.dataDir,'registry.sqlite'));assert.equal(r.prepare('SELECT count(*) n FROM churches').get().n,1);r.close();
  assert(!fs.existsSync(path.join(opts.dataDir,'churches/pil_test.sqlite')));
});
test('unexpected identities and path traversal are rejected', async t => {
  const opts=fixture(t),db=read(opts);db.exec("UPDATE users SET first_name='Another' WHERE id=102");db.close();
  await assert.rejects(run(opts),/Peirce/);
  await assert.rejects(run({...opts,targetId:'../outside'}),/church ID/i);
});

test('late deletion failure restores already-moved history and login routes', async t => {
  const opts=fixture(t),db=read(opts);
  db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON users WHEN OLD.id=102 BEGIN SELECT RAISE(ABORT,'late deletion failure'); END");db.close();
  await assert.rejects(run({...opts,apply:true,maintenanceConfirmed:true}),/late deletion failure/);
  const source=read(opts);
  assert.equal(source.prepare('SELECT sum(headcount) n FROM headcount_records').get().n,87);
  assert.equal(source.prepare('SELECT count(*) n FROM attendance_sessions').get().n,3);
  assert.equal(source.prepare('SELECT count(*) n FROM users').get().n,4);source.close();
  const r=new DB(path.join(opts.dataDir,'registry.sqlite'));
  assert.equal(r.prepare("SELECT count(*) n FROM user_lookup WHERE church_id='redeemer'").get().n,4);
  assert.equal(r.prepare("SELECT count(*) n FROM user_lookup WHERE church_id='pil_test'").get().n,0);
  assert.equal(r.prepare('SELECT count(*) n FROM churches').get().n,1);r.close();
  assert(!fs.existsSync(path.join(opts.dataDir,'churches/pil_test.sqlite')));
});
