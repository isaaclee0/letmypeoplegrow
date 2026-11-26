const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { getChurchDate, loadChurchTimeZone, addDateOnly } = require('../utils/churchTime');
const router = require('./attendance');

test('assigned volunteers can add and correct the same visitor records and family note', async () => {
  await withTestChurchDb(async churchId => {
    const insert = async (sql, params) => Number((await Database.query(sql, params)).insertId);
    Database.getRegistryDb().prepare("INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Test', 1)").run(churchId);
    const gathering = await insert("INSERT INTO gathering_types (name, attendance_type, church_id) VALUES ('Sunday', 'standard', ?)", [churchId]);
    const other = await insert("INSERT INTO gathering_types (name, attendance_type, church_id) VALUES ('Other', 'standard', ?)", [churchId]);
    const secret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'disposable-visitor-test';
    const tokens = [];
    for (const username of ['welcomer', 'recorder']) {
      const id = await insert("INSERT INTO users (email, first_name, last_name, role, is_active, church_id) VALUES (?, ?, 'Test', 'attendance_taker', 1, ?)", [username+'@example.test', username, churchId]);
      await Database.query('INSERT INTO user_gathering_assignments (user_id, gathering_type_id, church_id) VALUES (?, ?, ?)', [id, gathering, churchId]);
      tokens.push(jwt.sign({ userId: id, churchId }, process.env.JWT_SECRET));
    }
    const app = express();
    app.use(express.json(), router);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const request = async (method, path, body, token = tokens[1]) => {
      const res = await fetch('http://127.0.0.1:' + server.address().port + path, {
        method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+token }, body: JSON.stringify(body)
      });
      return { status: res.status, data: res.headers.get('content-type')?.includes('application/json') ? await res.json() : null };
    };
    try {
      const date = getChurchDate(new Date(), await loadChurchTimeZone(churchId));
      const prefix = '/' + gathering + '/' + date;
      const created = await request('POST', prefix+'/visitor-details', {
        familyName: 'John', notes: '', peopleType: 'local_visitor', people: [
          { firstName: 'John', lastName: '', isChild: false },
          { firstName: 'Child 1', lastName: '', isChild: true }
        ]
      }, tokens[0]);
      assert.equal(created.status, 201);
      const path = '/visitors/'+created.data.people[0].id;
      const { data: original, status } = await request('GET', prefix+path);
      assert.equal(status, 200);
      const records = () => Database.query('SELECT id, individual_id, present, people_type_at_time FROM attendance_records WHERE church_id = ? ORDER BY id', [churchId]);
      const before = await records();
      assert.equal(before.length, 2);
      const updated = { ...original, notes: 'Met after the service', people: original.people.map(p =>
        p.isChild ? { ...p, firstName: 'Lucy' } : { ...p, lastName: 'Smith' }).reverse() };
      assert.equal((await request('PUT', prefix+path, updated)).status, 200);
      const saved = (await request('GET', prefix+path)).data;
      assert.equal(saved.notes, updated.notes);
      assert.deepEqual(saved.people.map(p => [p.id, p.firstName, p.lastName]), [
        [original.people[0].id, 'John', 'Smith'], [original.people[1].id, 'Lucy', '']
      ]);
      assert.deepEqual(await records(), before);
      assert.equal((await request('PUT', prefix+path, { ...updated, notes: 'stale' })).status, 409);
      assert.equal((await request('GET', '/'+other+'/'+date+path)).status, 403);
      assert.equal((await request('PUT', '/'+gathering+'/'+addDateOnly(date, { days: -14 })+path, saved)).status, 403);
      const unusedFamily = await insert("INSERT INTO families (family_name, family_type, church_id) VALUES ('Other', 'local_visitor', ?)", [churchId]);
      const outside = await insert("INSERT INTO individuals (first_name, last_name, family_id, people_type, church_id) VALUES ('Other', '', ?, 'local_visitor', ?)", [unusedFamily, churchId]);
      assert.equal((await request('GET', prefix+'/visitors/'+outside)).status, 404);
      assert.equal((await request('PUT', prefix+path, { ...saved, people: [{ ...saved.people[0], id: outside }, saved.people[1]] })).status, 400);
      assert.equal((await request('PUT', prefix+path, { ...saved, peopleType: 'traveller_visitor' })).status, 403);
      const regular = await insert("INSERT INTO individuals (first_name, last_name, family_id, people_type, church_id) VALUES ('Regular', '', ?, 'regular', ?)", [saved.familyId, churchId]);
      const mixed = (await request('GET', prefix+path)).data;
      assert.equal(mixed.people.some(p => p.id === regular), false);
      assert.equal(mixed.notesEditable, false);
      assert.equal((await request('PUT', prefix+path, { ...mixed, notes: 'mixed' })).status, 403);
      const corrected = { ...mixed, people: mixed.people.map(p => p.isChild ? { ...p, firstName: 'Lucie' } : p) };
      assert.equal((await request('PUT', prefix+path, corrected)).status, 200);
      await Database.query("UPDATE people_sync_settings SET authority_provider='planning_center', people_editing_locked=1 WHERE church_id=?", [churchId]);
      await Database.query("UPDATE individuals SET planning_center_id='synced' WHERE church_id=? AND id=?", [churchId, saved.people[0].id]);
      const synced = (await request('GET', prefix+path)).data;
      assert.equal(synced.people[0].locked, true);
      assert.equal((await request('PUT', prefix+path, { ...synced, people: synced.people.map(p => ({ ...p, lastName: 'New' })) })).status, 403);
      const soloId = await insert("INSERT INTO individuals (first_name, last_name, people_type, planning_center_id, church_id) VALUES ('Solo', '', 'local_visitor', 'linked-solo', ?)", [churchId]);
      await Database.query('INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id) VALUES (?, ?, ?)', [gathering, soloId, churchId]);
      const soloPath = prefix+'/visitors/'+soloId;
      const solo = (await request('GET', soloPath)).data;
      assert.equal(solo.familyEditable, false);
      assert.equal((await request('PUT', soloPath, { ...solo, notes: 'new household' })).status, 403);
      assert.equal((await request('PUT', soloPath, solo)).status, 200);
      assert.equal((await Database.query('SELECT family_id FROM individuals WHERE id=? AND church_id=?', [soloId, churchId]))[0].family_id, null);
      await Database.query("UPDATE individuals SET people_type='regular' WHERE church_id=? AND id=?", [churchId, original.people[0].id]);
      assert.equal((await request('PUT', prefix+path, saved)).status, 404);
      assert.deepEqual(await records(), before);

      // Add an existing, ungrouped visitor using the action on the Attendance page.
      assert.equal((await request('POST', prefix+'/individual/'+soloId, {})).status, 200);
      const full = (await request('GET', prefix+'/full')).data;
      for (const list of [full.visitors, full.recentVisitors, (await request('GET', prefix)).data.visitors]) {
        const entry = list.find(p => p.id === soloId);
        assert.ok(entry, 'the checked-in visitor appears on the roster without a family');
        assert.equal(entry.visitorType, 'potential_regular');
        assert.ok(!entry.visitorFamilyGroup);
        assert.equal((await request('GET', prefix+'/visitors/'+entry.id)).status, 200);
      }
      await Database.query('DELETE FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?', [gathering, soloId, churchId]);
      const removedFromRoster = (await request('GET', prefix+'/full')).data.visitors.find(p => p.id === soloId);
      assert.equal(removedFromRoster?.present, true);

      // A former visitor without a current listing is editable only while still recent.
      const oldDate = addDateOnly(date, { days: -8 });
      const insertSession = sessionDate => insert('INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id) VALUES (?, ?, ?, ?)', [gathering, sessionDate, jwt.decode(tokens[0]).userId, churchId]);
      const oldSession = await insertSession(oldDate);
      await Database.query('INSERT INTO attendance_records (session_id, individual_id, present, church_id) VALUES (?, ?, 1, ?)', [oldSession, outside, churchId]);
      assert.equal((await request('GET', prefix+'/visitors/'+outside)).status, 200);
      for (let days = 1; days <= 7; days++) {
        await insertSession(addDateOnly(date, { days: -days }));
      }
      assert.equal((await request('GET', prefix+'/visitors/'+outside)).status, 404);
    } finally {
      await new Promise(resolve => server.close(resolve));
      if (secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = secret;
    }
  });
});
