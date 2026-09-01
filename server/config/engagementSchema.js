const PASTORAL_INSIGHT_STATES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS pastoral_insight_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  insight_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL REFERENCES individuals(id) ON DELETE RESTRICT,
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
);`;

const ENGAGEMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS engagement_settings (
  church_id TEXT PRIMARY KEY,
  core_minimum INTEGER NOT NULL DEFAULT 60
    CHECK(typeof(core_minimum) = 'integer' AND core_minimum BETWEEN 0 AND 100),
  casual_minimum INTEGER NOT NULL DEFAULT 20
    CHECK(typeof(casual_minimum) = 'integer' AND casual_minimum BETWEEN 0 AND 100),
  core_label TEXT NOT NULL DEFAULT 'Core',
  core_colour TEXT NOT NULL DEFAULT '#16A34A',
  casual_label TEXT NOT NULL DEFAULT 'Casual',
  casual_colour TEXT NOT NULL DEFAULT '#D97706',
  irregular_label TEXT NOT NULL DEFAULT 'Irregular',
  irregular_colour TEXT NOT NULL DEFAULT '#DC2626',
  calculation_rules_version INTEGER NOT NULL DEFAULT 1
    CHECK(calculation_rules_version >= 1),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  CHECK(casual_minimum < core_minimum)
);

CREATE TABLE IF NOT EXISTS engagement_decline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  individual_id INTEGER NOT NULL REFERENCES individuals(id) ON DELETE RESTRICT,
  family_at_detection_id INTEGER REFERENCES families(id) ON DELETE SET NULL,
  from_tier TEXT NOT NULL CHECK(from_tier IN ('core','casual','irregular')),
  to_tier TEXT NOT NULL CHECK(to_tier IN ('core','casual','irregular')),
  effective_week_end TEXT NOT NULL,
  rules_version INTEGER NOT NULL CHECK(rules_version >= 1),
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  recovered_at TEXT,
  primary_attended_at_detection INTEGER
    CHECK(primary_attended_at_detection IS NULL OR primary_attended_at_detection >= 0),
  primary_opportunities_at_detection INTEGER
    CHECK(primary_opportunities_at_detection IS NULL OR primary_opportunities_at_detection >= 0),
  primary_rate_at_detection REAL
    CHECK(primary_rate_at_detection IS NULL OR primary_rate_at_detection BETWEEN 0 AND 1),
  confirmation_attended_at_detection INTEGER
    CHECK(confirmation_attended_at_detection IS NULL OR confirmation_attended_at_detection >= 0),
  confirmation_opportunities_at_detection INTEGER
    CHECK(confirmation_opportunities_at_detection IS NULL OR confirmation_opportunities_at_detection >= 0),
  confirmation_rate_at_detection REAL
    CHECK(confirmation_rate_at_detection IS NULL OR confirmation_rate_at_detection BETWEEN 0 AND 1),
  UNIQUE(church_id, individual_id, to_tier, effective_week_end, rules_version)
);
CREATE INDEX IF NOT EXISTS idx_engagement_decline_events_person
  ON engagement_decline_events(church_id, individual_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_engagement_decline_events_recovery
  ON engagement_decline_events(church_id, recovered_at, effective_week_end);

CREATE TABLE IF NOT EXISTS engagement_evaluation_state (
  church_id TEXT NOT NULL,
  individual_id INTEGER NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
  rules_version INTEGER NOT NULL CHECK(rules_version >= 1),
  last_evaluated_week_end TEXT NOT NULL,
  current_tier TEXT CHECK(current_tier IN ('core','casual','irregular')),
  active_lowest_decline_tier TEXT
    CHECK(active_lowest_decline_tier IN ('core','casual','irregular')),
  baseline_suppressed INTEGER NOT NULL DEFAULT 0 CHECK(baseline_suppressed IN (0,1)),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(church_id, individual_id)
);
CREATE INDEX IF NOT EXISTS idx_engagement_evaluation_state_week
  ON engagement_evaluation_state(church_id, last_evaluated_week_end);
CREATE INDEX IF NOT EXISTS idx_engagement_evaluation_state_tier
  ON engagement_evaluation_state(church_id, current_tier, individual_id);

CREATE TABLE IF NOT EXISTS engagement_tier_state (
  church_id TEXT NOT NULL,
  individual_id INTEGER NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('primary','community')),
  rules_version INTEGER NOT NULL CHECK(rules_version >= 1),
  established_tier TEXT CHECK(established_tier IN ('core','casual','irregular')),
  candidate_tier TEXT CHECK(candidate_tier IN ('core','casual','irregular')),
  candidate_direction TEXT CHECK(candidate_direction IN ('higher','lower')),
  candidate_started_week_end TEXT,
  candidate_final_week_end TEXT,
  last_evaluated_week_end TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY(church_id, individual_id, axis),
  CHECK((candidate_tier IS NULL AND candidate_direction IS NULL
         AND candidate_started_week_end IS NULL AND candidate_final_week_end IS NULL)
     OR (candidate_tier IS NOT NULL AND candidate_direction IS NOT NULL
         AND candidate_started_week_end IS NOT NULL AND candidate_final_week_end IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS engagement_tier_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  individual_id INTEGER NOT NULL REFERENCES individuals(id) ON DELETE CASCADE,
  axis TEXT NOT NULL CHECK(axis IN ('primary','community')),
  from_tier TEXT NOT NULL CHECK(from_tier IN ('core','casual','irregular')),
  to_tier TEXT NOT NULL CHECK(to_tier IN ('core','casual','irregular')),
  candidate_started_week_end TEXT NOT NULL,
  confirmed_week_end TEXT NOT NULL,
  rules_version INTEGER NOT NULL CHECK(rules_version >= 1),
  long_term_attended INTEGER NOT NULL CHECK(long_term_attended >= 0),
  long_term_opportunities INTEGER NOT NULL CHECK(long_term_opportunities >= 0),
  long_term_rate REAL NOT NULL CHECK(long_term_rate BETWEEN 0 AND 1),
  confirmation_attended INTEGER NOT NULL CHECK(confirmation_attended >= 0),
  confirmation_opportunities INTEGER NOT NULL CHECK(confirmation_opportunities >= 0),
  confirmation_rate REAL NOT NULL CHECK(confirmation_rate BETWEEN 0 AND 1),
  pastoral_processed_at TEXT,
  decline_event_id INTEGER REFERENCES engagement_decline_events(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, individual_id, axis, from_tier, to_tier, confirmed_week_end, rules_version)
);
CREATE INDEX IF NOT EXISTS idx_engagement_tier_transitions_person
  ON engagement_tier_transitions(church_id, individual_id, axis, confirmed_week_end);
CREATE INDEX IF NOT EXISTS idx_engagement_tier_transitions_recent
  ON engagement_tier_transitions(church_id, confirmed_week_end);
CREATE INDEX IF NOT EXISTS idx_engagement_tier_transitions_unprocessed
  ON engagement_tier_transitions(church_id, axis, pastoral_processed_at, confirmed_week_end);

CREATE TABLE IF NOT EXISTS engagement_decline_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  church_id TEXT NOT NULL,
  event_id INTEGER NOT NULL REFERENCES engagement_decline_events(id) ON DELETE RESTRICT,
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('user','contact')),
  recipient_id INTEGER NOT NULL,
  family_caregiver_id INTEGER REFERENCES family_caregivers(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_attempt_at TEXT,
  last_error TEXT,
  cancellation_reason TEXT,
  delivered_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(church_id, event_id, recipient_type, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_engagement_decline_deliveries_event
  ON engagement_decline_deliveries(church_id, event_id, state);
CREATE INDEX IF NOT EXISTS idx_engagement_decline_deliveries_pending
  ON engagement_decline_deliveries(church_id, state, last_attempt_at);
CREATE INDEX IF NOT EXISTS idx_engagement_decline_deliveries_recipient
  ON engagement_decline_deliveries(church_id, recipient_type, recipient_id, state);

${PASTORAL_INSIGHT_STATES_TABLE_SQL}
CREATE INDEX IF NOT EXISTS idx_pastoral_insight_states_subject
  ON pastoral_insight_states(church_id, insight_type, subject_id, workflow_state);
CREATE INDEX IF NOT EXISTS idx_pastoral_insight_states_workflow
  ON pastoral_insight_states(church_id, workflow_state, snoozed_until);
CREATE INDEX IF NOT EXISTS idx_pastoral_insight_states_decline_event
  ON pastoral_insight_states(church_id, decline_event_id, workflow_state);
`;

const ENGAGEMENT_LOOKUP_INDEX_DEFINITIONS = Object.freeze([
  ['idx_gathering_types_engagement_role', 'gathering_types',
    ['church_id', 'engagement_role']],
  ['idx_attendance_sessions_engagement_state', 'attendance_sessions',
    ['church_id', 'session_status', 'session_date', 'gathering_type_id']],
  ['idx_attendance_sessions_engagement_gathering', 'attendance_sessions',
    ['church_id', 'gathering_type_id', 'session_date', 'session_status']],
  ['idx_attendance_records_engagement_session', 'attendance_records',
    ['church_id', 'session_id', 'eligible_at_snapshot', 'present', 'individual_id']],
  ['idx_attendance_records_engagement_person', 'attendance_records',
    ['church_id', 'individual_id', 'session_id']],
  ['idx_headcount_records_engagement_session', 'headcount_records',
    ['church_id', 'session_id']],
  ['idx_gathering_lists_engagement_person', 'gathering_lists',
    ['church_id', 'individual_id', 'gathering_type_id']],
  ['idx_gathering_lists_engagement_gathering', 'gathering_lists',
    ['church_id', 'gathering_type_id', 'individual_id']],
]);

const ENGAGEMENT_LOOKUP_INDEX_SQL = ENGAGEMENT_LOOKUP_INDEX_DEFINITIONS
  .map(([name, table, columns]) =>
    `CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns.join(', ')});`)
  .join('\n');

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info("${tableName}")`).all();
}

function hasTable(db, tableName) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(tableName));
}

function addMissingColumns(db, tableName, columns) {
  const currentColumns = tableColumns(db, tableName);
  if (currentColumns.length === 0) return;
  const existing = new Set(currentColumns.map((column) => column.name));
  for (const [name, definition] of columns) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE "${tableName}" ADD COLUMN "${name}" ${definition}`);
    }
  }
}

function ensurePastoralSubjectForeignKey(db) {
  if (!hasTable(db, 'pastoral_insight_states')) return;
  const subjectForeignKey = db.prepare('PRAGMA foreign_key_list("pastoral_insight_states")').all()
    .find((foreignKey) => foreignKey.from === 'subject_id');
  if (subjectForeignKey?.table === 'individuals' && subjectForeignKey.on_delete === 'RESTRICT') {
    return;
  }

  // The pre-release table briefly allowed workflow-only rows to outlive their subject.
  // Such rows cannot be rendered or acted on, so discard them before enforcing integrity.
  db.exec(`DELETE FROM pastoral_insight_states
    WHERE NOT EXISTS (
      SELECT 1 FROM individuals WHERE individuals.id = pastoral_insight_states.subject_id
    )`);
  db.exec(`
    DROP TABLE IF EXISTS pastoral_insight_states_without_subject_fk;
    ALTER TABLE pastoral_insight_states RENAME TO pastoral_insight_states_without_subject_fk;
    ${PASTORAL_INSIGHT_STATES_TABLE_SQL}
    INSERT INTO pastoral_insight_states
      (id, church_id, insight_type, subject_id, episode_key, decline_event_id,
       workflow_state, snoozed_until, acted_by, resolved_at, created_at, updated_at)
    SELECT id, church_id, insight_type, subject_id, episode_key, decline_event_id,
           workflow_state, snoozed_until, acted_by, resolved_at, created_at, updated_at
    FROM pastoral_insight_states_without_subject_fk;
    DROP TABLE pastoral_insight_states_without_subject_fk;
  `);
}

function ensureEngagementLookupIndexes(db) {
  for (const [name, table, columns] of ENGAGEMENT_LOOKUP_INDEX_DEFINITIONS) {
    const existingColumns = new Set(tableColumns(db, table).map((column) => column.name));
    if (columns.every((column) => existingColumns.has(column))) {
      db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns.join(', ')})`);
    }
  }
}

function ensureEngagementSchema(db, churchId) {
  if (!churchId) throw new Error('A church ID is required to migrate engagement schema');

  db.transaction(() => {
    addMissingColumns(db, 'gathering_types', [
      ['engagement_role', "TEXT CHECK (engagement_role IN ('primary','community','other'))"],
    ]);

    const currentSessionColumns = tableColumns(db, 'attendance_sessions');
    const sessionColumns = new Set(currentSessionColumns.map((column) => column.name));
    const addedSessionStatus = currentSessionColumns.length > 0
      && !sessionColumns.has('session_status');
    addMissingColumns(db, 'attendance_sessions', [
      ['session_status', "TEXT NOT NULL DEFAULT 'open' CHECK (session_status IN ('open','held','cancelled'))"],
      ['roster_provenance_version', 'INTEGER NOT NULL DEFAULT 0'],
      ['cancelled_at', 'TEXT'],
      ['cancelled_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
    ]);
    addMissingColumns(db, 'attendance_records', [
      ['eligible_at_snapshot', 'INTEGER NOT NULL DEFAULT 0 CHECK (eligible_at_snapshot IN (0,1))'],
      ['updated_by', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
    ]);

    db.exec(ENGAGEMENT_SCHEMA_SQL);
    addMissingColumns(db, 'engagement_decline_events', [
      ['primary_attended_at_detection',
        'INTEGER CHECK(primary_attended_at_detection IS NULL OR primary_attended_at_detection >= 0)'],
      ['primary_opportunities_at_detection',
        'INTEGER CHECK(primary_opportunities_at_detection IS NULL OR primary_opportunities_at_detection >= 0)'],
      ['primary_rate_at_detection',
        'REAL CHECK(primary_rate_at_detection IS NULL OR primary_rate_at_detection BETWEEN 0 AND 1)'],
      ['confirmation_attended_at_detection',
        'INTEGER CHECK(confirmation_attended_at_detection IS NULL OR confirmation_attended_at_detection >= 0)'],
      ['confirmation_opportunities_at_detection',
        'INTEGER CHECK(confirmation_opportunities_at_detection IS NULL OR confirmation_opportunities_at_detection >= 0)'],
      ['confirmation_rate_at_detection',
        'REAL CHECK(confirmation_rate_at_detection IS NULL OR confirmation_rate_at_detection BETWEEN 0 AND 1)'],
    ]);
    ensurePastoralSubjectForeignKey(db);
    // Recreate the named indexes if the pastoral table was rebuilt above.
    db.exec(ENGAGEMENT_SCHEMA_SQL);
    ensureEngagementLookupIndexes(db);

    if (addedSessionStatus) {
      const evidenceClauses = [];
      const parameters = [churchId];
      if (sessionColumns.has('roster_snapshotted')) {
        evidenceClauses.push('COALESCE(attendance_sessions.roster_snapshotted, 0) = 1');
      }
      if (hasTable(db, 'attendance_records')) {
        evidenceClauses.push(`EXISTS (
          SELECT 1 FROM attendance_records
          WHERE attendance_records.church_id = ?
            AND attendance_records.session_id = attendance_sessions.id
        )`);
        parameters.push(churchId);
      }
      if (hasTable(db, 'headcount_records')) {
        evidenceClauses.push(`EXISTS (
          SELECT 1 FROM headcount_records
          WHERE headcount_records.church_id = ?
            AND headcount_records.session_id = attendance_sessions.id
        )`);
        parameters.push(churchId);
      }
      if (evidenceClauses.length > 0) {
        db.prepare(`UPDATE attendance_sessions
          SET session_status = 'held'
          WHERE church_id = ?
            AND session_status = 'open'
            AND (${evidenceClauses.join(' OR ')})`).run(...parameters);
      }
    }
  })();
}

module.exports = {
  ENGAGEMENT_SCHEMA_SQL,
  ENGAGEMENT_LOOKUP_INDEX_SQL,
  ensureEngagementSchema,
};
