const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const logger = require('../config/logger');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const attendanceRouter = require('./attendance');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

test('the attendance roster follows the individual type when a family type is stale', async () => {
  await withTestChurchDb(async (churchId) => {
    const user = await Database.query(
      `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
       VALUES ('roster-admin@example.test', 'admin', 'Roster', 'Admin', 1, ?)`,
      [churchId]
    );
    Database.getRegistryDb().prepare(
      `INSERT INTO churches (church_id, church_name, is_approved)
       VALUES (?, 'Roster Test', 1)`
    ).run(churchId);
    const gathering = await Database.query(
      `INSERT INTO gathering_types (name, attendance_type, church_id)
       VALUES ('Sunday', 'standard', ?)`,
      [churchId]
    );
    const family = await Database.query(
      `INSERT INTO families (family_name, family_type, church_id)
       VALUES ('Changed Family', 'local_visitor', ?)`,
      [churchId]
    );
    const person = await Database.query(
      `INSERT INTO individuals
         (first_name, last_name, family_id, people_type, is_active, church_id)
       VALUES ('Changed', 'Person', ?, 'regular', 1, ?)`,
      [Number(family.insertId), churchId]
    );
    const personWithoutFamily = await Database.query(
      `INSERT INTO individuals
         (first_name, last_name, family_id, people_type, is_active, church_id)
       VALUES ('Solo', 'Person', NULL, 'local_visitor', 1, ?)`,
      [churchId]
    );
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [Number(gathering.insertId), Number(person.insertId), churchId]
    );

    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'attendance-roster-parity-test';
    const token = jwt.sign({ userId: Number(user.insertId), churchId }, process.env.JWT_SECRET);
    const app = express();
    app.use(express.json());
    app.use('/api/attendance', attendanceRouter);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/api/attendance/${gathering.insertId}/2026-09-06/full`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.attendanceList.some((row) => row.id === Number(person.insertId)), true);
      assert.equal(body.allChurchPeople.some((row) => row.id === Number(personWithoutFamily.insertId)), true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    }
  });
});
