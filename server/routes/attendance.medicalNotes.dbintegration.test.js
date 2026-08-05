const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const attendanceRouter = require('./attendance');

test('full attendance response includes medical indicator only on the configured assigned roster', async () => {
  await withTestChurchDb(async (churchId) => {
    const user = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
       VALUES ('medical-attendance@example.test', 'admin', 'Admin', 'User', 1, ?)`, [churchId]);
    Database.getRegistryDb().prepare(
      `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Attendance Test', 1)`
    ).run(churchId);
    const gathering = await Database.query("INSERT INTO gathering_types (name, church_id) VALUES ('Sunday', ?)", [churchId]);
    const family = await Database.query("INSERT INTO families (family_name, church_id) VALUES ('Family', ?)", [churchId]);
    const person = await Database.query(
      `INSERT INTO individuals
       (first_name, last_name, family_id, church_id, planning_center_id, pco_has_medical_notes)
       VALUES ('Medical', 'Person', ?, ?, 'p1', 1)`, [family.insertId, churchId]);
    await Database.query('INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id) VALUES (?, ?, ?)', [gathering.insertId, person.insertId, churchId]);
    await Database.query('INSERT INTO planning_center_medical_note_gatherings (church_id, gathering_type_id) VALUES (?, ?)', [churchId, gathering.insertId]);
    await Database.query(
      `UPDATE church_settings SET planning_center_medical_notes_enabled = 1,
       planning_center_medical_notes_minimum_role = 'admin',
       planning_center_medical_notes_badge_icon = 'heart',
       planning_center_medical_notes_badge_color = '#facc15' WHERE church_id = ?`, [churchId]);

    const oldSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'attendance-medical-test';
    const token = jwt.sign({ userId: user.insertId, churchId }, process.env.JWT_SECRET);
    const app = express();
    app.use(express.json());
    app.use('/api/attendance', attendanceRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/attendance/${gathering.insertId}/2026-08-05/full`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(body.medicalNotesIndicator, { icon: 'heart', color: '#facc15' });
      assert.equal(body.attendanceList.find(({ firstName }) => firstName === 'Medical').hasMedicalNotes, true);
      assert.equal(body.allChurchPeople.some((row) => Object.hasOwn(row, 'hasMedicalNotes')), false);
      assert.equal(JSON.stringify(body).includes('medical_notes'), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (oldSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = oldSecret;
    }
  });
});
