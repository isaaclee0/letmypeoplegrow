/**
 * Seed script: Creates a realistic demo church with families, members,
 * gathering types, and 12 weeks of attendance history.
 *
 * Usage (from server/):
 *   node scripts/seed-demo.js
 */

const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CHURCH_ID = 'devch1';
const REGISTRY_PATH = path.join(DATA_DIR, 'registry.sqlite');
const CHURCH_DB_PATH = path.join(DATA_DIR, 'churches', `${CHURCH_ID}.sqlite`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

/** Return the last N Sundays (most recent first) */
function lastNSundays(n) {
  const sundays = [];
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 7) % 7)); // last Sunday
  for (let i = 0; i < n; i++) {
    sundays.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() - 7);
  }
  return sundays;
}

/** Return the last N Wednesdays */
function lastNWednesdays(n) {
  const results = [];
  const d = new Date();
  const day = d.getDay();
  const diff = (day + 4) % 7; // 3 = Wednesday, but we want last Wednesday
  d.setDate(d.getDate() - diff);
  for (let i = 0; i < n; i++) {
    results.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() - 7);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const FAMILIES = [
  { name: 'Anderson', members: [{ fn: 'David', ln: 'Anderson', child: 0 }, { fn: 'Sarah', ln: 'Anderson', child: 0 }, { fn: 'Lily', ln: 'Anderson', child: 1 }, { fn: 'Noah', ln: 'Anderson', child: 1 }] },
  { name: 'Nguyen', members: [{ fn: 'James', ln: 'Nguyen', child: 0 }, { fn: 'Linda', ln: 'Nguyen', child: 0 }, { fn: 'Ethan', ln: 'Nguyen', child: 1 }] },
  { name: 'Thompson', members: [{ fn: 'Michael', ln: 'Thompson', child: 0 }, { fn: 'Grace', ln: 'Thompson', child: 0 }] },
  { name: 'Patel', members: [{ fn: 'Raj', ln: 'Patel', child: 0 }, { fn: 'Priya', ln: 'Patel', child: 0 }, { fn: 'Aiden', ln: 'Patel', child: 1 }, { fn: 'Mia', ln: 'Patel', child: 1 }] },
  { name: 'Williams', members: [{ fn: 'Robert', ln: 'Williams', child: 0 }, { fn: 'Helen', ln: 'Williams', child: 0 }] },
  { name: 'Chen', members: [{ fn: 'Kevin', ln: 'Chen', child: 0 }, { fn: 'Mei', ln: 'Chen', child: 0 }, { fn: 'Sophie', ln: 'Chen', child: 1 }] },
  { name: 'Okafor', members: [{ fn: 'Emmanuel', ln: 'Okafor', child: 0 }, { fn: 'Blessing', ln: 'Okafor', child: 0 }, { fn: 'Samuel', ln: 'Okafor', child: 1 }] },
  { name: 'Martinez', members: [{ fn: 'Carlos', ln: 'Martinez', child: 0 }, { fn: 'Ana', ln: 'Martinez', child: 0 }] },
  { name: 'Kim', members: [{ fn: 'Soo-Jin', ln: 'Kim', child: 0 }, { fn: 'Yuna', ln: 'Kim', child: 0 }, { fn: 'Lucas', ln: 'Kim', child: 1 }] },
  { name: 'Brown', members: [{ fn: 'Thomas', ln: 'Brown', child: 0 }, { fn: 'Jessica', ln: 'Brown', child: 0 }, { fn: 'Olivia', ln: 'Brown', child: 1 }, { fn: 'Jack', ln: 'Brown', child: 1 }] },
  { name: 'Wilson', members: [{ fn: 'Peter', ln: 'Wilson', child: 0 }, { fn: 'Rachel', ln: 'Wilson', child: 0 }] },
  { name: 'Lee', members: [{ fn: 'Daniel', ln: 'Lee', child: 0 }, { fn: 'Jennifer', ln: 'Lee', child: 0 }, { fn: 'Chloe', ln: 'Lee', child: 1 }] },
  { name: 'Davis', members: [{ fn: 'Andrew', ln: 'Davis', child: 0 }, { fn: 'Claire', ln: 'Davis', child: 0 }] },
  { name: 'Singh', members: [{ fn: 'Harpreet', ln: 'Singh', child: 0 }, { fn: 'Simran', ln: 'Singh', child: 0 }, { fn: 'Arjun', ln: 'Singh', child: 1 }] },
  { name: 'Taylor', members: [{ fn: 'Matthew', ln: 'Taylor', child: 0 }, { fn: 'Emma', ln: 'Taylor', child: 0 }] },
  { name: 'Russo', members: [{ fn: 'Marco', ln: 'Russo', child: 0 }, { fn: 'Giulia', ln: 'Russo', child: 0 }, { fn: 'Luca', ln: 'Russo', child: 1 }] },
  { name: 'Johnson', members: [{ fn: 'Paul', ln: 'Johnson', child: 0 }, { fn: 'Karen', ln: 'Johnson', child: 0 }] },
  { name: 'Park', members: [{ fn: 'Min-Jun', ln: 'Park', child: 0 }, { fn: 'Ji-Yeon', ln: 'Park', child: 0 }, { fn: 'Hana', ln: 'Park', child: 1 }] },
];

const SINGLES = [
  { fn: 'George', ln: 'Mitchell', child: 0 },
  { fn: 'Abigail', ln: 'Foster', child: 0 },
  { fn: 'Isaac', ln: 'Reed', child: 0 },
  { fn: 'Lydia', ln: 'Barnes', child: 0 },
  { fn: 'Marcus', ln: 'Powell', child: 0 },
  { fn: 'Naomi', ln: 'Scott', child: 0 },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function seed() {
  // Ensure directories exist
  fs.mkdirSync(path.join(DATA_DIR, 'churches'), { recursive: true });

  // --- Registry DB ---
  const reg = new BetterSqlite3(REGISTRY_PATH);
  reg.pragma('journal_mode = WAL');
  reg.exec(`
    CREATE TABLE IF NOT EXISTS churches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL UNIQUE,
      church_name TEXT NOT NULL,
      is_approved INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS user_lookup (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      email TEXT,
      mobile_number TEXT,
      church_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_lookup_email ON user_lookup(email);
    CREATE INDEX IF NOT EXISTS idx_user_lookup_church ON user_lookup(church_id);
  `);

  reg.prepare(`INSERT OR IGNORE INTO churches (church_id, church_name, is_approved) VALUES (?, ?, 1)`)
    .run(CHURCH_ID, 'Grace Community Church');

  // --- Church DB ---
  // Load the full schema from the app
  const { CHURCH_SCHEMA, UPDATED_AT_TRIGGERS } = require('../config/schema');
  const db = new BetterSqlite3(CHURCH_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(CHURCH_SCHEMA);
  db.exec(UPDATED_AT_TRIGGERS);

  // Ensure has_sample_data column exists (migration)
  const cols = db.prepare('PRAGMA table_info(church_settings)').all();
  if (!cols.some(c => c.name === 'has_sample_data')) {
    db.exec('ALTER TABLE church_settings ADD COLUMN has_sample_data INTEGER DEFAULT 0');
  }

  // --- Church settings ---
  db.prepare(`
    INSERT OR IGNORE INTO church_settings
      (church_id, church_name, country_code, timezone, email_from_name,
       email_from_address, onboarding_completed, has_sample_data)
    VALUES (?, 'Grace Community Church', 'AU', 'Australia/Sydney',
            'Let My People Grow', 'noreply@letmypeoplegrow.com.au', 1, 1)
  `).run(CHURCH_ID);

  // --- Admin user ---
  const existingUser = db.prepare(`SELECT id FROM users WHERE email = ?`).get('dev@church.local');
  let adminId;
  if (existingUser) {
    adminId = existingUser.id;
    console.log('Admin user already exists, id:', adminId);
  } else {
    const result = db.prepare(`
      INSERT INTO users (church_id, email, role, first_name, last_name, is_active, first_login_completed)
      VALUES (?, 'dev@church.local', 'admin', 'Pastor', 'Dave', 1, 1)
    `).run(CHURCH_ID);
    adminId = result.lastInsertRowid;
    reg.prepare(`INSERT OR IGNORE INTO user_lookup (user_id, email, church_id) VALUES (?, ?, ?)`)
      .run(adminId, 'dev@church.local', CHURCH_ID);
    console.log('Created admin user, id:', adminId);
  }

  // --- Clear old seed data ---
  db.exec(`
    DELETE FROM attendance_records;
    DELETE FROM headcount_records;
    DELETE FROM attendance_sessions;
    DELETE FROM gathering_lists;
    DELETE FROM individuals;
    DELETE FROM families;
    DELETE FROM gathering_types;
  `);
  console.log('Cleared old seed data');

  // --- Gathering types ---
  const sunday = db.prepare(`
    INSERT INTO gathering_types
      (name, description, day_of_week, start_time, end_time, duration_minutes,
       frequency, attendance_type, kiosk_enabled, group_by_family, is_active,
       created_by, church_id)
    VALUES ('Sunday Morning Service', 'Our main weekly gathering', 'Sunday', '10:00', '11:30',
            90, 'weekly', 'standard', 1, 1, 1, ?, ?)
  `).run(adminId, CHURCH_ID);
  const sundayId = sunday.lastInsertRowid;

  const wednesday = db.prepare(`
    INSERT INTO gathering_types
      (name, description, day_of_week, start_time, end_time, duration_minutes,
       frequency, attendance_type, kiosk_enabled, group_by_family, is_active,
       created_by, church_id)
    VALUES ('Wednesday Bible Study', 'Mid-week prayer and Bible study', 'Wednesday', '19:00', '20:30',
            90, 'weekly', 'headcount', 0, 0, 1, ?, ?)
  `).run(adminId, CHURCH_ID);
  const wednesdayId = wednesday.lastInsertRowid;

  const kids = db.prepare(`
    INSERT INTO gathering_types
      (name, description, day_of_week, start_time, end_time, duration_minutes,
       frequency, attendance_type, kiosk_enabled, group_by_family, is_active,
       created_by, church_id)
    VALUES ('Kids Church', 'Sunday morning program for children', 'Sunday', '10:00', '11:30',
            90, 'weekly', 'standard', 0, 1, 1, ?, ?)
  `).run(adminId, CHURCH_ID);
  const kidsId = kids.lastInsertRowid;

  console.log(`Created 3 gathering types: ${sundayId}, ${wednesdayId}, ${kidsId}`);

  // --- Families & individuals ---
  const familyIds = [];
  const adultIds = [];
  const childIds = [];

  const insertFamily = db.prepare(`
    INSERT INTO families (family_name, church_id, created_by) VALUES (?, ?, ?)
  `);
  const insertIndividual = db.prepare(`
    INSERT INTO individuals (first_name, last_name, people_type, family_id, is_child, is_active, church_id, created_by)
    VALUES (?, ?, 'regular', ?, ?, 1, ?, ?)
  `);

  for (const fam of FAMILIES) {
    const fid = insertFamily.run(fam.name, CHURCH_ID, adminId).lastInsertRowid;
    familyIds.push(fid);
    for (const m of fam.members) {
      const iid = insertIndividual.run(m.fn, m.ln, fid, m.child, CHURCH_ID, adminId).lastInsertRowid;
      if (m.child) childIds.push(iid); else adultIds.push(iid);
    }
  }

  // Singles (no family)
  for (const s of SINGLES) {
    const iid = insertIndividual.run(s.fn, s.ln, null, 0, CHURCH_ID, adminId).lastInsertRowid;
    adultIds.push(iid);
  }

  // Two local visitors
  const vis1 = insertIndividual.run('Alex', 'Turner', null, 0, CHURCH_ID, adminId).lastInsertRowid;
  const vis2 = insertIndividual.run('Samantha', 'Cross', null, 0, CHURCH_ID, adminId).lastInsertRowid;
  db.prepare(`UPDATE individuals SET people_type = 'local_visitor', is_visitor = 1 WHERE id IN (?, ?)`).run(vis1, vis2);

  console.log(`Created ${familyIds.length} families, ${adultIds.length} adults, ${childIds.length} children`);

  // --- Gathering lists (Sunday + Kids) ---
  const insertGL = db.prepare(`INSERT OR IGNORE INTO gathering_lists (gathering_type_id, individual_id, church_id, added_by) VALUES (?, ?, ?, ?)`);
  for (const id of [...adultIds, vis1, vis2]) {
    insertGL.run(sundayId, id, CHURCH_ID, adminId);
  }
  for (const id of childIds) {
    insertGL.run(kidsId, id, CHURCH_ID, adminId);
    // Also add children's parents to Sunday list (already done via adultIds)
  }
  console.log('Built gathering lists');

  // --- Attendance sessions + records ---
  const insertSession = db.prepare(`
    INSERT OR IGNORE INTO attendance_sessions
      (gathering_type_id, session_date, created_by, church_id)
    VALUES (?, ?, ?, ?)
  `);
  const insertRecord = db.prepare(`
    INSERT OR IGNORE INTO attendance_records
      (session_id, individual_id, present, people_type_at_time, church_id)
    VALUES (?, ?, ?, 'regular', ?)
  `);
  const insertHeadcount = db.prepare(`
    INSERT OR IGNORE INTO headcount_records
      (session_id, headcount, updated_by, church_id)
    VALUES (?, ?, ?, ?)
  `);

  const allSundayMembers = [...adultIds, vis1, vis2];

  // Sunday services: 12 weeks, ~80% average attendance, slight upward trend
  const sundays = lastNSundays(12);
  sundays.forEach((date, weekIdx) => {
    const s = insertSession.run(sundayId, date, adminId, CHURCH_ID);
    const sessionId = s.lastInsertRowid || db.prepare(`SELECT id FROM attendance_sessions WHERE gathering_type_id=? AND session_date=? AND church_id=?`).get(sundayId, date, CHURCH_ID).id;

    // Attendance rate rises from ~72% at week 12 to ~85% at week 0
    const rate = 0.72 + (weekIdx / 12) * 0.13;
    for (const iid of allSundayMembers) {
      const present = Math.random() < rate ? 1 : 0;
      insertRecord.run(sessionId, iid, present, CHURCH_ID);
    }

    // Kids church same day
    const ks = insertSession.run(kidsId, date, adminId, CHURCH_ID);
    const kSessionId = ks.lastInsertRowid || db.prepare(`SELECT id FROM attendance_sessions WHERE gathering_type_id=? AND session_date=? AND church_id=?`).get(kidsId, date, CHURCH_ID).id;
    for (const cid of childIds) {
      const present = Math.random() < (rate + 0.05) ? 1 : 0;
      db.prepare(`INSERT OR IGNORE INTO attendance_records (session_id, individual_id, present, people_type_at_time, church_id) VALUES (?, ?, ?, 'regular', ?)`).run(kSessionId, cid, present, CHURCH_ID);
    }
  });

  // Wednesday headcounts: 12 weeks, 15-35 people
  const wednesdays = lastNWednesdays(12);
  wednesdays.forEach((date, idx) => {
    const s = insertSession.run(wednesdayId, date, adminId, CHURCH_ID);
    const sessionId = s.lastInsertRowid || db.prepare(`SELECT id FROM attendance_sessions WHERE gathering_type_id=? AND session_date=? AND church_id=?`).get(wednesdayId, date, CHURCH_ID).id;
    const count = Math.floor(15 + Math.random() * 20 + (idx / 12) * 5);
    insertHeadcount.run(sessionId, count, adminId, CHURCH_ID);
  });

  // Update last_attended on individuals
  db.exec(`
    UPDATE individuals SET last_attendance_date = (
      SELECT MAX(s.session_date)
      FROM attendance_records r
      JOIN attendance_sessions s ON s.id = r.session_id
      WHERE r.individual_id = individuals.id AND r.present = 1
    )
  `);

  console.log('✅ Seed complete!');
  console.log(`   Church: Grace Community Church (${CHURCH_ID})`);
  console.log(`   Families: ${familyIds.length}`);
  console.log(`   Adults: ${adultIds.length}, Children: ${childIds.length}`);
  console.log(`   Sunday sessions: ${sundays.length}, Wednesday sessions: ${wednesdays.length}`);
  console.log(`\n   Log in at http://localhost:3000`);
  console.log(`   Email: dev@church.local`);
  console.log(`   Code:  000000`);
}

seed();
