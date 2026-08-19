const { test } = require('node:test');
const assert = require('node:assert/strict');
const BetterSqlite3 = require('better-sqlite3');

const { CHURCH_SCHEMA } = require('./schema');
const { ENGAGEMENT_SCHEMA_SQL, ensureEngagementSchema } = require('./engagementSchema');

const CHURCH_ID = 'engagement_test_church';
const NEW_SESSION_COLUMNS = [
  'session_status',
  'roster_provenance_version',
  'cancelled_at',
  'cancelled_by',
];

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name);
}

function tableSql(db, table) {
  return db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table).sql;
}

function indexColumnSets(db, table) {
  return db.prepare(`PRAGMA index_list("${table}")`).all().map((index) =>
    db.prepare(`PRAGMA index_info("${index.name}")`).all().map((column) => column.name),
  );
}

function hasIndexBeginningWith(db, table, prefix) {
  return indexColumnSets(db, table).some(
    (columns) => prefix.every((column, index) => columns[index] === column),
  );
}

function foreignKey(db, table, from) {
  return db.prepare(`PRAGMA foreign_key_list("${table}")`).all()
    .find((candidate) => candidate.from === from);
}

function createLegacyDb() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL
    );
    CREATE TABLE gathering_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL
    );
    CREATE TABLE families (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL
    );
    CREATE TABLE individuals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      family_id INTEGER REFERENCES families(id) ON DELETE SET NULL,
      church_id TEXT NOT NULL
    );
    CREATE TABLE family_caregivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE
    );
    CREATE TABLE gathering_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gathering_type_id INTEGER NOT NULL REFERENCES gathering_types(id) ON DELETE CASCADE,
      individual_id INTEGER NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
      church_id TEXT NOT NULL,
      UNIQUE(gathering_type_id, individual_id)
    );
    CREATE TABLE attendance_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gathering_type_id INTEGER NOT NULL REFERENCES gathering_types(id) ON DELETE CASCADE,
      session_date TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      roster_snapshotted INTEGER DEFAULT 0,
      church_id TEXT NOT NULL,
      UNIQUE(gathering_type_id, session_date, church_id)
    );
    CREATE TABLE attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      individual_id INTEGER NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
      present INTEGER DEFAULT 0,
      church_id TEXT NOT NULL,
      UNIQUE(session_id, individual_id)
    );
    CREATE TABLE headcount_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      headcount INTEGER NOT NULL DEFAULT 0,
      updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      church_id TEXT NOT NULL,
      UNIQUE(session_id, updated_by)
    );
    CREATE TABLE pastoral_insight_states (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      insight_type TEXT NOT NULL,
      subject_id INTEGER NOT NULL,
      episode_key TEXT NOT NULL,
      decline_event_id INTEGER REFERENCES engagement_decline_events(id) ON DELETE SET NULL,
      workflow_state TEXT NOT NULL DEFAULT 'open'
        CHECK(workflow_state IN ('open','snoozed','dismissed','resolved')),
      snoozed_until TEXT,
      acted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(church_id, insight_type, subject_id, episode_key)
    );
  `);
  return db;
}

function seedLegacySessions(db) {
  const userId = Number(db.prepare('INSERT INTO users (church_id) VALUES (?)').run(CHURCH_ID).lastInsertRowid);
  const gatheringId = Number(db.prepare('INSERT INTO gathering_types (church_id) VALUES (?)').run(CHURCH_ID).lastInsertRowid);
  const familyId = Number(db.prepare('INSERT INTO families (church_id) VALUES (?)').run(CHURCH_ID).lastInsertRowid);
  const individualId = Number(db.prepare(
    'INSERT INTO individuals (family_id, church_id) VALUES (?, ?)',
  ).run(familyId, CHURCH_ID).lastInsertRowid);
  const caregiverId = Number(db.prepare(
    'INSERT INTO family_caregivers (family_id, church_id) VALUES (?, ?)',
  ).run(familyId, CHURCH_ID).lastInsertRowid);

  const insertSession = db.prepare(`INSERT INTO attendance_sessions
    (gathering_type_id, session_date, created_by, roster_snapshotted, church_id)
    VALUES (?, ?, ?, ?, ?)`);
  const zeroHeadcountSessionId = Number(
    insertSession.run(gatheringId, '2026-06-07', userId, 0, CHURCH_ID).lastInsertRowid,
  );
  const snapshottedAbsentSessionId = Number(
    insertSession.run(gatheringId, '2026-06-14', userId, 1, CHURCH_ID).lastInsertRowid,
  );
  const attendanceActivitySessionId = Number(
    insertSession.run(gatheringId, '2026-06-21', userId, 0, CHURCH_ID).lastInsertRowid,
  );
  const untouchedSessionId = Number(
    insertSession.run(gatheringId, '2026-06-28', userId, 0, CHURCH_ID).lastInsertRowid,
  );

  db.prepare(`INSERT INTO headcount_records
    (session_id, headcount, updated_by, church_id) VALUES (?, 0, ?, ?)`)
    .run(zeroHeadcountSessionId, userId, CHURCH_ID);
  db.prepare(`INSERT INTO attendance_records
    (session_id, individual_id, present, church_id) VALUES (?, ?, 0, ?)`)
    .run(snapshottedAbsentSessionId, individualId, CHURCH_ID);
  const secondIndividualId = Number(db.prepare(
    'INSERT INTO individuals (family_id, church_id) VALUES (?, ?)',
  ).run(familyId, CHURCH_ID).lastInsertRowid);
  db.prepare(`INSERT INTO attendance_records
    (session_id, individual_id, present, church_id) VALUES (?, ?, 1, ?)`)
    .run(attendanceActivitySessionId, secondIndividualId, CHURCH_ID);

  return {
    userId,
    familyId,
    individualId,
    caregiverId,
    zeroHeadcountSessionId,
    snapshottedAbsentSessionId,
    attendanceActivitySessionId,
    untouchedSessionId,
  };
}

function statusFor(db, sessionId) {
  return db.prepare('SELECT session_status FROM attendance_sessions WHERE id = ?')
    .get(sessionId).session_status;
}

function assertEngagementColumns(db) {
  assert.deepEqual(
    columnNames(db, 'attendance_sessions')
      .filter((name) => NEW_SESSION_COLUMNS.includes(name)).sort(),
    ['cancelled_at', 'cancelled_by', 'roster_provenance_version', 'session_status'],
  );
  assert.equal(db.prepare('PRAGMA table_info(gathering_types)').all()
    .find((column) => column.name === 'engagement_role').notnull, 0);

  const sessionColumns = db.prepare('PRAGMA table_info(attendance_sessions)').all();
  assert.deepEqual(
    Object.fromEntries(sessionColumns.filter((column) => NEW_SESSION_COLUMNS.includes(column.name))
      .map((column) => [column.name, { type: column.type, notnull: column.notnull, default: column.dflt_value }])),
    {
      session_status: { type: 'TEXT', notnull: 1, default: "'open'" },
      roster_provenance_version: { type: 'INTEGER', notnull: 1, default: '0' },
      cancelled_at: { type: 'TEXT', notnull: 0, default: null },
      cancelled_by: { type: 'INTEGER', notnull: 0, default: null },
    },
  );
  const eligibleColumn = db.prepare('PRAGMA table_info(attendance_records)').all()
    .find((column) => column.name === 'eligible_at_snapshot');
  assert.deepEqual(
    { type: eligibleColumn.type, notnull: eligibleColumn.notnull, default: eligibleColumn.dflt_value },
    { type: 'INTEGER', notnull: 1, default: '0' },
  );
  const attendanceUpdatedByColumn = db.prepare('PRAGMA table_info(attendance_records)').all()
    .find((column) => column.name === 'updated_by');
  assert.deepEqual(
    {
      type: attendanceUpdatedByColumn?.type,
      notnull: attendanceUpdatedByColumn?.notnull,
      default: attendanceUpdatedByColumn?.dflt_value,
    },
    { type: 'INTEGER', notnull: 0, default: null },
  );

  assert.match(tableSql(db, 'gathering_types'), /CHECK\s*\(engagement_role IN \('primary','community','other'\)\)/i);
  assert.match(tableSql(db, 'attendance_sessions'), /CHECK\s*\(session_status IN \('open','held','cancelled'\)\)/i);
  assert.match(tableSql(db, 'attendance_records'), /CHECK\s*\(eligible_at_snapshot IN \(0,1\)\)/i);
}

function assertEngagementTables(db) {
  const expectedColumns = {
    engagement_settings: [
      'church_id', 'core_minimum', 'casual_minimum', 'core_label', 'core_colour',
      'casual_label', 'casual_colour', 'irregular_label', 'irregular_colour',
      'calculation_rules_version', 'created_at', 'updated_at',
    ],
    engagement_decline_events: [
      'id', 'church_id', 'individual_id', 'family_at_detection_id', 'from_tier',
      'to_tier', 'effective_week_end', 'rules_version', 'detected_at', 'recovered_at',
      'primary_attended_at_detection', 'primary_opportunities_at_detection',
      'primary_rate_at_detection',
    ],
    engagement_evaluation_state: [
      'church_id', 'individual_id', 'rules_version', 'last_evaluated_week_end',
      'current_tier', 'active_lowest_decline_tier', 'baseline_suppressed',
      'created_at', 'updated_at',
    ],
    engagement_decline_deliveries: [
      'id', 'church_id', 'event_id', 'recipient_type', 'recipient_id',
      'family_caregiver_id', 'state', 'attempts', 'last_attempt_at', 'last_error',
      'cancellation_reason', 'delivered_at', 'created_at', 'updated_at',
    ],
    pastoral_insight_states: [
      'id', 'church_id', 'insight_type', 'subject_id', 'episode_key',
      'decline_event_id', 'workflow_state', 'snoozed_until', 'acted_by',
      'resolved_at', 'created_at', 'updated_at',
    ],
  };

  for (const [table, expected] of Object.entries(expectedColumns)) {
    assert.deepEqual(columnNames(db, table), expected, `${table} columns`);
  }
  assert.equal(
    db.prepare('PRAGMA table_info(engagement_decline_deliveries)').all()
      .find((column) => column.name === 'recipient_id').type,
    'INTEGER',
  );
  assert.equal(
    db.prepare('PRAGMA table_info(pastoral_insight_states)').all()
      .find((column) => column.name === 'subject_id').type,
    'INTEGER',
  );

  const settings = db.prepare(`INSERT INTO engagement_settings (church_id)
    VALUES (?) RETURNING *`).get(CHURCH_ID);
  assert.deepEqual(
    {
      core: settings.core_minimum,
      casual: settings.casual_minimum,
      coreLabel: settings.core_label,
      coreColour: settings.core_colour,
      casualLabel: settings.casual_label,
      casualColour: settings.casual_colour,
      irregularLabel: settings.irregular_label,
      irregularColour: settings.irregular_colour,
      rules: settings.calculation_rules_version,
    },
    {
      core: 60,
      casual: 20,
      coreLabel: 'Core',
      coreColour: '#16A34A',
      casualLabel: 'Casual',
      casualColour: '#D97706',
      irregularLabel: 'Irregular',
      irregularColour: '#DC2626',
      rules: 1,
    },
  );
}

function assertChecksAndUniqueKeys(db, ids) {
  assert.throws(
    () => db.prepare("UPDATE gathering_types SET engagement_role = 'weekend' WHERE id = 1").run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare("UPDATE attendance_sessions SET session_status = 'finished' WHERE id = ?").run(ids.untouchedSessionId),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare('UPDATE attendance_records SET eligible_at_snapshot = 2').run(),
    /CHECK constraint failed/,
  );

  const eventId = Number(db.prepare(`INSERT INTO engagement_decline_events
    (church_id, individual_id, family_at_detection_id, from_tier, to_tier,
     effective_week_end, rules_version)
    VALUES (?, ?, ?, 'core', 'casual', '2026-08-09', 1)`)
    .run(CHURCH_ID, ids.individualId, ids.familyId).lastInsertRowid);
  assert.throws(
    () => db.prepare(`INSERT INTO engagement_decline_events
      (church_id, individual_id, from_tier, to_tier, effective_week_end, rules_version)
      VALUES (?, ?, 'core', 'casual', '2026-08-09', 1)`)
      .run(CHURCH_ID, ids.individualId),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO engagement_decline_events
      (church_id, individual_id, from_tier, to_tier, effective_week_end, rules_version)
      VALUES (?, ?, 'establishing', 'casual', '2026-08-16', 1)`)
      .run(CHURCH_ID, ids.individualId),
    /CHECK constraint failed/,
  );

  db.prepare(`INSERT INTO engagement_evaluation_state
    (church_id, individual_id, rules_version, last_evaluated_week_end,
     current_tier, active_lowest_decline_tier)
    VALUES (?, ?, 1, '2026-08-09', 'casual', 'casual')`)
    .run(CHURCH_ID, ids.individualId);
  assert.throws(
    () => db.prepare(`INSERT INTO engagement_evaluation_state
      (church_id, individual_id, rules_version, last_evaluated_week_end)
      VALUES (?, ?, 1, '2026-08-16')`).run(CHURCH_ID, ids.individualId),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => db.prepare(`UPDATE engagement_evaluation_state
      SET baseline_suppressed = 3 WHERE church_id = ? AND individual_id = ?`)
      .run(CHURCH_ID, ids.individualId),
    /CHECK constraint failed/,
  );

  db.prepare(`INSERT INTO engagement_decline_deliveries
    (church_id, event_id, recipient_type, recipient_id, family_caregiver_id)
    VALUES (?, ?, 'user', ?, ?)`)
    .run(CHURCH_ID, eventId, String(ids.userId), ids.caregiverId);
  assert.throws(
    () => db.prepare(`INSERT INTO engagement_decline_deliveries
      (church_id, event_id, recipient_type, recipient_id)
      VALUES (?, ?, 'user', ?)`)
      .run(CHURCH_ID, eventId, String(ids.userId)),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => db.prepare(`INSERT INTO engagement_decline_deliveries
      (church_id, event_id, recipient_type, recipient_id)
      VALUES (?, ?, 'sms', '1')`).run(CHURCH_ID, eventId),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => db.prepare(`UPDATE engagement_decline_deliveries
      SET state = 'failed' WHERE church_id = ? AND event_id = ?`)
      .run(CHURCH_ID, eventId),
    /CHECK constraint failed/,
  );

  db.prepare(`INSERT INTO pastoral_insight_states
    (church_id, insight_type, subject_id, episode_key, decline_event_id)
    VALUES (?, 'primary_decline', ?, 'decline:1', ?)`)
    .run(CHURCH_ID, String(ids.individualId), eventId);
  assert.throws(
    () => db.prepare(`INSERT INTO pastoral_insight_states
      (church_id, insight_type, subject_id, episode_key)
      VALUES (?, 'primary_decline', ?, 'decline:1')`)
      .run(CHURCH_ID, String(ids.individualId)),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => db.prepare(`UPDATE pastoral_insight_states
      SET workflow_state = 'archived' WHERE church_id = ?`)
      .run(CHURCH_ID),
    /CHECK constraint failed/,
  );

  db.prepare('DELETE FROM family_caregivers WHERE id = ?').run(ids.caregiverId);
  assert.equal(db.prepare(`SELECT family_caregiver_id FROM engagement_decline_deliveries
    WHERE event_id = ?`).get(eventId).family_caregiver_id, null);
}

function assertForeignKeysAndIndexes(db) {
  assert.deepEqual(
    { table: foreignKey(db, 'attendance_records', 'updated_by').table,
      onDelete: foreignKey(db, 'attendance_records', 'updated_by').on_delete },
    { table: 'users', onDelete: 'SET NULL' },
  );
  assert.deepEqual(
    { table: foreignKey(db, 'attendance_sessions', 'cancelled_by').table,
      onDelete: foreignKey(db, 'attendance_sessions', 'cancelled_by').on_delete },
    { table: 'users', onDelete: 'SET NULL' },
  );
  assert.deepEqual(
    { table: foreignKey(db, 'engagement_decline_deliveries', 'family_caregiver_id').table,
      onDelete: foreignKey(db, 'engagement_decline_deliveries', 'family_caregiver_id').on_delete },
    { table: 'family_caregivers', onDelete: 'SET NULL' },
  );
  assert.deepEqual(
    { table: foreignKey(db, 'engagement_decline_events', 'individual_id')?.table,
      onDelete: foreignKey(db, 'engagement_decline_events', 'individual_id')?.on_delete },
    { table: 'individuals', onDelete: 'RESTRICT' },
  );
  assert.deepEqual(
    { table: foreignKey(db, 'pastoral_insight_states', 'subject_id')?.table,
      onDelete: foreignKey(db, 'pastoral_insight_states', 'subject_id')?.on_delete },
    { table: 'individuals', onDelete: 'RESTRICT' },
  );

  const requiredIndexPrefixes = {
    gathering_types: [['church_id', 'engagement_role']],
    attendance_sessions: [
      ['church_id', 'session_status', 'session_date'],
      ['church_id', 'gathering_type_id', 'session_date'],
    ],
    attendance_records: [
      ['church_id', 'session_id', 'eligible_at_snapshot'],
      ['church_id', 'individual_id', 'session_id'],
    ],
    headcount_records: [['church_id', 'session_id']],
    gathering_lists: [
      ['church_id', 'individual_id', 'gathering_type_id'],
      ['church_id', 'gathering_type_id', 'individual_id'],
    ],
    engagement_settings: [['church_id']],
    engagement_decline_events: [
      ['church_id', 'individual_id'],
      ['church_id', 'recovered_at', 'effective_week_end'],
    ],
    engagement_evaluation_state: [
      ['church_id', 'individual_id'],
      ['church_id', 'last_evaluated_week_end'],
    ],
    engagement_decline_deliveries: [
      ['church_id', 'event_id'],
      ['church_id', 'state', 'last_attempt_at'],
      ['church_id', 'recipient_type', 'recipient_id'],
    ],
    pastoral_insight_states: [
      ['church_id', 'insight_type', 'subject_id'],
      ['church_id', 'workflow_state', 'snoozed_until'],
      ['church_id', 'decline_event_id'],
    ],
  };
  for (const [table, prefixes] of Object.entries(requiredIndexPrefixes)) {
    for (const prefix of prefixes) {
      assert.equal(
        hasIndexBeginningWith(db, table, prefix),
        true,
        `${table} needs an index beginning (${prefix.join(', ')})`,
      );
    }
  }
}

test('ensureEngagementSchema upgrades a legacy database and backfills only evidenced sessions', () => {
  const db = createLegacyDb();
  const ids = seedLegacySessions(db);

  ensureEngagementSchema(db, CHURCH_ID);

  assertEngagementColumns(db);
  assertEngagementTables(db);
  assert.equal(statusFor(db, ids.zeroHeadcountSessionId), 'held');
  assert.equal(statusFor(db, ids.snapshottedAbsentSessionId), 'held');
  assert.equal(statusFor(db, ids.attendanceActivitySessionId), 'held');
  assert.equal(statusFor(db, ids.untouchedSessionId), 'open');
  assertChecksAndUniqueKeys(db, ids);
  assertForeignKeysAndIndexes(db);

  db.prepare("UPDATE attendance_sessions SET session_status = 'cancelled' WHERE id = ?")
    .run(ids.zeroHeadcountSessionId);
  ensureEngagementSchema(db, CHURCH_ID);
  assert.equal(statusFor(db, ids.zeroHeadcountSessionId), 'cancelled');
  assert.equal(statusFor(db, ids.untouchedSessionId), 'open');

  db.close();
});

test('CHURCH_SCHEMA creates the same engagement contract for fresh databases', () => {
  assert.equal(typeof ENGAGEMENT_SCHEMA_SQL, 'string');
  assert.ok(ENGAGEMENT_SCHEMA_SQL.length > 0);

  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(CHURCH_SCHEMA);

  assertEngagementColumns(db);
  assertEngagementTables(db);
  assertForeignKeysAndIndexes(db);
  db.close();
});
