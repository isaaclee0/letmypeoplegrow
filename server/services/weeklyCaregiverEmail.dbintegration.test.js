const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { generateCaregiverDigests } = require('./weeklyCaregiverEmail');

test('generateCaregiverDigests counts two missed weekly gatherings as one absence period', async () => {
  await withTestChurchDb(async (churchId) => {
    const caregiver = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, 'caregiver@example.com', 'coordinator', 'Care', 'Giver', 1)`, [churchId]
    );
    const admin = await Database.query(
      `INSERT INTO users (church_id, email, role, first_name, last_name, is_active)
       VALUES (?, 'admin@example.com', 'admin', 'Admin', 'Creator', 1)`, [churchId]
    );
    const family = await Database.query(
      `INSERT INTO families (church_id, family_name) VALUES (?, 'EXAMPLE, J')`, [churchId]
    );
    const person = await Database.query(
      `INSERT INTO individuals (church_id, first_name, last_name, family_id, people_type, is_active)
       VALUES (?, 'Jamie', 'Example', ?, 'regular', 1)`, [churchId, family.insertId]
    );
    await Database.query(
      `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, user_id)
       VALUES (?, ?, 'user', ?)`, [churchId, family.insertId, caregiver.insertId]
    );
    await Database.query(
      `UPDATE church_settings SET caregiver_absence_threshold = 3 WHERE church_id = ?`, [churchId]
    );

    const amGathering = await Database.query(
      `INSERT INTO gathering_types (church_id, name, frequency, attendance_type, is_active, created_by)
       VALUES (?, 'Sunday AM', 'weekly', 'standard', 1, ?)`, [churchId, admin.insertId]
    );
    const pmGathering = await Database.query(
      `INSERT INTO gathering_types (church_id, name, frequency, attendance_type, is_active, created_by)
       VALUES (?, 'Sunday PM', 'weekly', 'standard', 1, ?)`, [churchId, admin.insertId]
    );

    for (const date of ['2026-07-12', '2026-07-19', '2026-07-26']) {
      for (const gatheringId of [amGathering.insertId, pmGathering.insertId]) {
        const session = await Database.query(
          `INSERT INTO attendance_sessions (church_id, gathering_type_id, session_date, created_by)
           VALUES (?, ?, ?, ?)`, [churchId, gatheringId, date, admin.insertId]
        );
        await Database.query(
          `INSERT INTO attendance_records (church_id, session_id, individual_id, present)
           VALUES (?, ?, ?, 0)`, [churchId, session.insertId, person.insertId]
        );
      }
    }

    const digests = await generateCaregiverDigests(churchId);

    assert.equal(digests.length, 1);
    assert.equal(digests[0].entries.length, 1);
    assert.equal(digests[0].entries[0].type, 'individual');
    assert.equal(digests[0].entries[0].streak, 3);
  });
});
