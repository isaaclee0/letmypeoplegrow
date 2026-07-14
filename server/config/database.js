const BetterSqlite3 = require('better-sqlite3');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('path');
const fs = require('fs');
const { REGISTRY_SCHEMA, CHURCH_SCHEMA, UPDATED_AT_TRIGGERS } = require('./schema');
const { randomUUID } = require('crypto');

const asyncLocalStorage = new AsyncLocalStorage();
const churchDbs = new Map();
const churchTxLocks = new Map(); // Mutex per church to prevent concurrent transactions on shared connection
let registryDb = null;
let dataDir = null;

function getChurchTxLock(churchId) {
  if (!churchTxLocks.has(churchId)) {
    churchTxLocks.set(churchId, { queue: Promise.resolve(), pending: 0 });
  }
  return churchTxLocks.get(churchId);
}

class Database {
  static initialize() {
    dataDir = process.env.CHURCH_DATA_DIR || process.env.DATA_DIR ||
      path.join(__dirname, '..', 'data');
    const churchDir = path.join(dataDir, 'churches');
    fs.mkdirSync(churchDir, { recursive: true });

    registryDb = new BetterSqlite3(path.join(dataDir, 'registry.sqlite'));
    registryDb.pragma('journal_mode = WAL');
    registryDb.pragma('foreign_keys = ON');
    registryDb.pragma('busy_timeout = 5000');
    registryDb.exec(REGISTRY_SCHEMA);

    console.log('✅ SQLite registry database initialized at', path.join(dataDir, 'registry.sqlite'));
  }

  static getChurchDb(churchId) {
    if (!churchId) throw new Error('No church ID provided');
    if (churchDbs.has(churchId)) return churchDbs.get(churchId);

    const dbPath = path.join(dataDir, 'churches', `${churchId}.sqlite`);
    const isNew = !fs.existsSync(dbPath);
    const db = new BetterSqlite3(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    if (isNew) {
      db.exec(CHURCH_SCHEMA);
      db.exec(UPDATED_AT_TRIGGERS);
      console.log(`✅ Created church database: ${churchId}`);
    }

    // Migrate existing church DBs
    if (!isNew) {
      const cols = db.prepare('PRAGMA table_info(church_settings)').all();
      if (!cols.some(c => c.name === 'has_sample_data')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN has_sample_data INTEGER DEFAULT 0');
      }

      // Migrate gathering_types table
      const gatheringCols = db.prepare('PRAGMA table_info(gathering_types)').all();
      if (!gatheringCols.some(c => c.name === 'individual_mode')) {
        db.exec('ALTER TABLE gathering_types ADD COLUMN individual_mode INTEGER DEFAULT 0');
      }

      // Migrate caregiver tables
      const existingTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);

      if (!existingTables.includes('sms_send_log')) {
        db.exec(`CREATE TABLE IF NOT EXISTS sms_send_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          church_id TEXT,
          contact_identifier TEXT NOT NULL,
          sent_at TEXT DEFAULT (datetime('now'))
        )`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_sms_send_log_contact ON sms_send_log(contact_identifier, sent_at)`);
      }

      if (!existingTables.includes('contacts')) {
        db.exec(`CREATE TABLE IF NOT EXISTS contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          church_id TEXT NOT NULL,
          first_name TEXT NOT NULL,
          last_name TEXT NOT NULL,
          email TEXT,
          mobile_number TEXT,
          primary_contact_method TEXT CHECK(primary_contact_method IN ('email', 'sms')) DEFAULT 'email',
          notes TEXT,
          is_active INTEGER DEFAULT 1,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_church ON contacts(church_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_active ON contacts(is_active)`);
      }

      if (!existingTables.includes('family_caregivers')) {
        db.exec(`CREATE TABLE IF NOT EXISTS family_caregivers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          church_id TEXT NOT NULL,
          family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
          caregiver_type TEXT NOT NULL CHECK(caregiver_type IN ('user', 'contact')),
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
          created_at TEXT DEFAULT (datetime('now')),
          CHECK(
            (caregiver_type = 'user' AND user_id IS NOT NULL AND contact_id IS NULL) OR
            (caregiver_type = 'contact' AND contact_id IS NOT NULL AND user_id IS NULL)
          )
        )`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fc_user ON family_caregivers(family_id, user_id) WHERE user_id IS NOT NULL`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fc_contact ON family_caregivers(family_id, contact_id) WHERE contact_id IS NOT NULL`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_fc_family ON family_caregivers(family_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_fc_church ON family_caregivers(church_id)`);
      }

      if (!existingTables.includes('contact_notifications')) {
        db.exec(`CREATE TABLE IF NOT EXISTS contact_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          church_id TEXT NOT NULL,
          contact_id INTEGER NOT NULL REFERENCES contacts(id),
          family_id INTEGER REFERENCES families(id),
          individual_id INTEGER REFERENCES individuals(id),
          rule_id INTEGER REFERENCES notification_rules(id),
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          email_sent INTEGER DEFAULT 0,
          sms_sent INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        )`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_cn_contact ON contact_notifications(contact_id)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_cn_church ON contact_notifications(church_id)`);
      }

      // Migrate church_settings
      const settingsCols = db.prepare('PRAGMA table_info(church_settings)').all();
      if (!settingsCols.some(c => c.name === 'caregiver_absence_threshold')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN caregiver_absence_threshold INTEGER DEFAULT 3');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_sync_indicator')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_sync_indicator INTEGER DEFAULT 0');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_auto_archive')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_auto_archive INTEGER DEFAULT 0');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_last_sync')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_last_sync TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_last_sync_archived')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_last_sync_archived INTEGER DEFAULT 0');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_sync_enabled')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_sync_enabled INTEGER DEFAULT 0');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_sync_frequency')) {
        db.exec("ALTER TABLE church_settings ADD COLUMN planning_center_sync_frequency TEXT DEFAULT 'weekly'");
      }
      if (!settingsCols.some(c => c.name === 'planning_center_sync_day')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_sync_day INTEGER DEFAULT 1');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_membership_allowlist')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_membership_allowlist TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_membership_filter_enabled')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_membership_filter_enabled INTEGER DEFAULT 1');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_field_filter_enabled')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_field_filter_enabled INTEGER DEFAULT 0');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_field_filters')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_field_filters TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_last_sync_result')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_last_sync_result TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_checkin_import_state')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_checkin_import_state TEXT');
      }
      if (!settingsCols.some(c => c.name === 'weekly_review_guidance')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN weekly_review_guidance TEXT');
      }
      if (!settingsCols.some(c => c.name === 'weekly_review_guidance_inputs')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN weekly_review_guidance_inputs TEXT');
      }
      if (!settingsCols.some(c => c.name === 'weekly_review_guidance_updated_at')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN weekly_review_guidance_updated_at TEXT');
      }

      // Migrate families: add planning_center_id if missing
      const familiesCols = db.prepare('PRAGMA table_info(families)').all();
      if (!familiesCols.some(c => c.name === 'planning_center_id')) {
        db.exec('ALTER TABLE families ADD COLUMN planning_center_id TEXT');
      }

      // Migrate individuals: add planning_center_id if missing
      const individualsCols = db.prepare('PRAGMA table_info(individuals)').all();
      if (!individualsCols.some(c => c.name === 'planning_center_id')) {
        db.exec('ALTER TABLE individuals ADD COLUMN planning_center_id TEXT');
      }
      if (!individualsCols.some(c => c.name === 'pco_link_declined')) {
        db.exec('ALTER TABLE individuals ADD COLUMN pco_link_declined INTEGER DEFAULT 0');
      }

      // Migrate church_settings: reconciliation schedule columns
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_schedule_enabled')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_schedule_enabled INTEGER DEFAULT 0');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_frequency')) {
        db.exec("ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_frequency TEXT DEFAULT 'weekly'");
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_day')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_day INTEGER DEFAULT 1');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_last_run_at')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_last_run_at TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_reconciliation_last_result')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_reconciliation_last_result TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_membership_cache')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_membership_cache TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_field_definitions_cache')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_field_definitions_cache TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_last_notified_review')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_last_notified_review TEXT');
      }

      // Create planning_center_sync_batches if missing, and seed exactly once from
      // the legacy single-filter columns (additive-only migration — the old columns
      // are left in place, unused, rather than dropped; this codebase's migrations
      // never DROP COLUMN).
      if (!existingTables.includes('planning_center_sync_batches')) {
        db.exec(`CREATE TABLE IF NOT EXISTS planning_center_sync_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          church_id TEXT NOT NULL,
          name TEXT NOT NULL,
          membership_filter_enabled INTEGER DEFAULT 0,
          membership_allowlist TEXT,
          field_filter_enabled INTEGER DEFAULT 0,
          field_filters TEXT,
          default_people_type TEXT DEFAULT 'regular' CHECK(default_people_type IN ('regular', 'local_visitor', 'traveller_visitor')),
          gathering_type_id INTEGER,
          gathering_auto_remove_enabled INTEGER DEFAULT 0,
          schedule_enabled INTEGER DEFAULT 0,
          schedule_frequency TEXT DEFAULT 'weekly',
          schedule_day INTEGER DEFAULT 1,
          last_sync_at TEXT,
          last_sync_result TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE SET NULL
        )`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_pcsb_church ON planning_center_sync_batches(church_id)`);

        const legacy = db.prepare(
          `SELECT planning_center_membership_filter_enabled AS membershipFilterEnabled,
                  planning_center_membership_allowlist AS membershipAllowlist,
                  planning_center_field_filter_enabled AS fieldFilterEnabled,
                  planning_center_field_filters AS fieldFilters,
                  planning_center_sync_frequency AS syncFrequency,
                  planning_center_sync_day AS syncDay
             FROM church_settings WHERE church_id = ?`
        ).get(churchId);
        if (legacy) {
          let allowlistArr = [];
          try { allowlistArr = JSON.parse(legacy.membershipAllowlist || '[]'); } catch (_) {}
          let fieldFiltersArr = [];
          try { fieldFiltersArr = JSON.parse(legacy.fieldFilters || '[]'); } catch (_) {}
          const hasMembershipFilter = !!legacy.membershipFilterEnabled && allowlistArr.length > 0;
          const hasFieldFilter = !!legacy.fieldFilterEnabled && fieldFiltersArr.length > 0;
          // Only seed a batch when there was an actual configured filter — a church
          // that never touched PCO sync shouldn't get a dead "Main Sync" batch just
          // because membership_filter_enabled defaults to 1 with an empty allowlist.
          if (hasMembershipFilter || hasFieldFilter) {
            db.prepare(
              `INSERT INTO planning_center_sync_batches
                 (church_id, name, membership_filter_enabled, membership_allowlist, field_filter_enabled, field_filters,
                  default_people_type, gathering_type_id, schedule_enabled, schedule_frequency, schedule_day)
               VALUES (?, 'Main Sync', ?, ?, ?, ?, 'regular', NULL, 1, ?, ?)`
            ).run(
              churchId,
              legacy.membershipFilterEnabled ? 1 : 0,
              legacy.membershipAllowlist || '[]',
              legacy.fieldFilterEnabled ? 1 : 0,
              legacy.fieldFilters || '[]',
              legacy.syncFrequency || 'weekly',
              typeof legacy.syncDay === 'number' ? legacy.syncDay : 1
            );
          }
        }
      }

      // Migrate planning_center_sync_batches: gathering auto-remove toggle
      const pcsbCols = db.prepare('PRAGMA table_info(planning_center_sync_batches)').all();
      if (!pcsbCols.some(c => c.name === 'gathering_auto_remove_enabled')) {
        db.exec('ALTER TABLE planning_center_sync_batches ADD COLUMN gathering_auto_remove_enabled INTEGER DEFAULT 0');
      }

      // Migrate gathering_lists: batch-ownership tracking for auto-remove
      const glCols = db.prepare('PRAGMA table_info(gathering_lists)').all();
      if (!glCols.some(c => c.name === 'added_by_pco_batch_id')) {
        db.exec('ALTER TABLE gathering_lists ADD COLUMN added_by_pco_batch_id INTEGER REFERENCES planning_center_sync_batches(id) ON DELETE SET NULL');
      }
    }

    churchDbs.set(churchId, db);
    return db;
  }

  static ensureChurchSchema(churchId) {
    const db = Database.getChurchDb(churchId);
    db.exec(CHURCH_SCHEMA);
    db.exec(UPDATED_AT_TRIGGERS);
  }

  static setChurchContext(churchId, callback) {
    return asyncLocalStorage.run({ churchId }, callback);
  }

  static getCurrentChurchId() {
    const store = asyncLocalStorage.getStore();
    return store?.churchId;
  }

  static _getCurrentDb() {
    const churchId = Database.getCurrentChurchId();
    if (!churchId) {
      throw new Error(
        'No church context set. Use Database.setChurchContext() or Database.queryForChurch().'
      );
    }
    return Database.getChurchDb(churchId);
  }

  static async query(sql, params = []) {
    const db = Database._getCurrentDb();
    return Database._executeQuery(db, sql, params);
  }

  static async registryQuery(sql, params = []) {
    if (!registryDb) throw new Error('Registry database not initialized. Call Database.initialize() first.');
    return Database._executeQuery(registryDb, sql, params);
  }

  static async queryForChurch(churchId, sql, params = []) {
    const db = Database.getChurchDb(churchId);
    return Database._executeQuery(db, sql, params);
  }

  static async transaction(callback) {
    const db = Database._getCurrentDb();
    const churchId = Database.getCurrentChurchId();
    return Database._runTransaction(db, callback, churchId);
  }

  static async transactionForChurch(churchId, callback) {
    const db = Database.getChurchDb(churchId);
    return Database.setChurchContext(churchId, () =>
      Database._runTransaction(db, callback, churchId)
    );
  }

  static async _runTransaction(db, callback, churchId) {
    const lock = churchId ? getChurchTxLock(churchId) : null;

    const run = async () => {
      const conn = {
        query: (sql, params = []) => Database._executeQuery(db, sql, params),
        beginTransaction: () => {},
        commit: () => {},
        rollback: () => {}
      };

      db.exec('BEGIN');
      try {
        const result = await callback(conn);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) {}
        console.error('Database transaction error:', err);
        throw err;
      }
    };

    if (lock) {
      const prev = lock.queue;
      let release;
      lock.queue = new Promise((resolve) => { release = resolve; });
      lock.pending++;
      try {
        await prev;
        return await run();
      } finally {
        lock.pending--;
        release();
      }
    }
    return run();
  }

  static async testConnection() {
    try {
      if (!registryDb) {
        Database.initialize();
      }
      const result = registryDb.prepare('SELECT 1 as test').get();
      console.log('✅ Database connected successfully');
      return !!result;
    } catch (err) {
      console.error('❌ Database connection failed:', err.message);
      return false;
    }
  }

  static async executeMultipleStatements(sqlContent) {
    const db = Database._getCurrentDb();
    try {
      db.exec(sqlContent);
      return { success: true };
    } catch (err) {
      console.error('Database executeMultipleStatements error:', err);
      throw err;
    }
  }

  static _executeQuery(db, sql, params = []) {
    params = Database._normalizeParams(params);

    const expanded = Database._expandArrayParams(sql, params);
    sql = expanded.sql;
    params = expanded.params;

    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();
    const isRead = upper.startsWith('SELECT') ||
                   upper.startsWith('PRAGMA') ||
                   upper.startsWith('WITH') ||
                   upper.startsWith('EXPLAIN');

    try {
      if (isRead) {
        const stmt = db.prepare(sql);
        return stmt.all(...params);
      } else {
        const stmt = db.prepare(sql);
        const result = stmt.run(...params);
        return {
          insertId: Number(result.lastInsertRowid),
          affectedRows: result.changes
        };
      }
    } catch (err) {
      if (err.message && err.message.includes('no such table')) {
        console.error(`Table not found. SQL: ${sql.substring(0, 200)}`);
      }
      throw err;
    }
  }

  static _expandArrayParams(sql, params) {
    if (!params.some(p => Array.isArray(p))) return { sql, params };

    const newParams = [];
    let paramIdx = 0;
    const newSql = sql.replace(/\?/g, () => {
      const p = params[paramIdx++];
      if (Array.isArray(p)) {
        newParams.push(...p);
        return p.map(() => '?').join(', ');
      }
      newParams.push(p);
      return '?';
    });

    return { sql: newSql, params: newParams };
  }

  static _normalizeParams(params) {
    return params.map(p => {
      if (p === undefined) return null;
      if (typeof p === 'boolean') return p ? 1 : 0;
      return p;
    });
  }

  // --- Registry helpers ---

  static ensureChurch(churchId, churchName) {
    if (!registryDb) throw new Error('Registry not initialized');
    registryDb.prepare(
      'INSERT OR IGNORE INTO churches (church_id, church_name) VALUES (?, ?)'
    ).run(churchId, churchName || churchId);
    Database.getChurchDb(churchId);
  }

  static registerUserLookup(userId, email, mobileNumber, churchId) {
    if (!registryDb) throw new Error('Registry not initialized');
    const existing = registryDb.prepare(
      'SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?'
    ).get(userId, churchId);
    registryDb.prepare(
      'DELETE FROM user_lookup WHERE user_id = ? AND church_id = ?'
    ).run(userId, churchId);
    registryDb.prepare(
      'INSERT OR REPLACE INTO user_lookup (user_id, email, mobile_number, church_id, person_id) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, email || null, mobileNumber || null, churchId, existing ? existing.person_id : null);
  }

  static lookupLinkedChurches(userId, churchId, email, mobileNumber) {
    if (!registryDb) return [];
    const selfRow = registryDb.prepare(
      'SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?'
    ).get(userId, churchId);
    const personId = selfRow ? selfRow.person_id : null;
    const emailParam = email || null;
    const mobileParam = mobileNumber || null;

    return registryDb.prepare(
      `SELECT DISTINCT ul.church_id, ul.user_id, c.church_name
       FROM user_lookup ul
       JOIN churches c ON c.church_id = ul.church_id
       WHERE ul.church_id != ?
         AND (
           (? IS NOT NULL AND ul.email = ?) OR
           (? IS NOT NULL AND ul.mobile_number = ?) OR
           (? IS NOT NULL AND ul.person_id = ?)
         )`
    ).all(churchId, emailParam, emailParam, mobileParam, mobileParam, personId, personId);
  }

  static async resolveChurchSwitch(userId, churchId, email, mobileNumber, targetChurchId) {
    const linked = Database.lookupLinkedChurches(userId, churchId, email, mobileNumber);
    const target = linked.find(l => l.church_id === targetChurchId);
    if (!target) {
      return { ok: false, status: 403, error: 'That church is not linked to your account.' };
    }
    if (!Database.isChurchApproved(targetChurchId)) {
      return { ok: false, status: 403, error: 'That church is pending approval.' };
    }

    const targetUsers = await Database.queryForChurch(
      targetChurchId,
      'SELECT id, email, mobile_number, primary_contact_method, role, first_name, last_name, is_active, first_login_completed, default_gathering_id, church_id FROM users WHERE id = ?',
      [target.user_id]
    );
    if (targetUsers.length === 0 || !targetUsers[0].is_active) {
      return { ok: false, status: 401, error: 'That account is no longer active.' };
    }

    return { ok: true, targetUser: targetUsers[0] };
  }

  static linkUserLookups(churchIdA, userIdA, churchIdB, userIdB) {
    if (!registryDb) throw new Error('Registry not initialized');
    const rowA = registryDb.prepare(
      'SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?'
    ).get(userIdA, churchIdA);
    const rowB = registryDb.prepare(
      'SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?'
    ).get(userIdB, churchIdB);
    if (!rowA || !rowB) throw new Error('No registry entry found for one or both users');

    if (rowA.person_id && rowB.person_id && rowA.person_id !== rowB.person_id) {
      // Both already belong to different groups: merge B's whole group into A's.
      registryDb.prepare('UPDATE user_lookup SET person_id = ? WHERE person_id = ?')
        .run(rowA.person_id, rowB.person_id);
      return rowA.person_id;
    }

    const personId = rowA.person_id || rowB.person_id || randomUUID();
    registryDb.prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?')
      .run(personId, userIdA, churchIdA);
    registryDb.prepare('UPDATE user_lookup SET person_id = ? WHERE user_id = ? AND church_id = ?')
      .run(personId, userIdB, churchIdB);
    return personId;
  }

  static unlinkUserLookup(churchId, userId) {
    if (!registryDb) throw new Error('Registry not initialized');
    const result = registryDb.prepare('UPDATE user_lookup SET person_id = NULL WHERE user_id = ? AND church_id = ?')
      .run(userId, churchId);
    return result.changes > 0;
  }

  static resyncUserLookup(userId) {
    const churchId = Database.getCurrentChurchId();
    if (!churchId) throw new Error('resyncUserLookup requires an active church context');
    const rows = Database.getChurchDb(churchId)
      .prepare('SELECT email, mobile_number FROM users WHERE id = ?')
      .get(userId);
    if (!rows) return;
    Database.registerUserLookup(userId, rows.email, rows.mobile_number, churchId);
  }

  static lookupChurchByEmail(email) {
    if (!registryDb) return null;
    return registryDb.prepare(
      'SELECT church_id, user_id FROM user_lookup WHERE email = ?'
    ).get(email) || null;
  }

  static lookupChurchByMobile(mobile) {
    if (!registryDb) return null;
    return registryDb.prepare(
      'SELECT church_id, user_id FROM user_lookup WHERE mobile_number = ?'
    ).get(mobile) || null;
  }

  static lookupAllChurchesByMobile(mobile) {
    if (!registryDb) return [];
    return registryDb.prepare(
      `SELECT ul.church_id, ul.user_id, c.church_name
       FROM user_lookup ul
       JOIN churches c ON c.church_id = ul.church_id
       WHERE ul.mobile_number = ?`
    ).all(mobile);
  }

  static lookupAllChurchesByEmail(email) {
    if (!registryDb) return [];
    return registryDb.prepare(
      `SELECT ul.church_id, ul.user_id, c.church_name
       FROM user_lookup ul
       JOIN churches c ON c.church_id = ul.church_id
       WHERE ul.email = ?`
    ).all(email);
  }

  static listChurches() {
    if (!registryDb) return [];
    return registryDb.prepare('SELECT * FROM churches ORDER BY church_name').all();
  }

  static isChurchApproved(churchId) {
    if (!registryDb) return false;
    const row = registryDb.prepare('SELECT is_approved FROM churches WHERE church_id = ?').get(churchId);
    return row ? !!row.is_approved : false;
  }

  static getChurchName(churchId) {
    if (!registryDb) return null;
    const row = registryDb.prepare('SELECT church_name FROM churches WHERE church_id = ?').get(churchId);
    return row ? row.church_name : null;
  }

  static approveChurch(churchId, approved) {
    if (!registryDb) throw new Error('Registry not initialized');
    registryDb.prepare('UPDATE churches SET is_approved = ? WHERE church_id = ?').run(approved ? 1 : 0, churchId);
  }

  static migrateRegistry() {
    if (!registryDb) return;
    const cols = registryDb.prepare('PRAGMA table_info(churches)').all();
    if (!cols.some(c => c.name === 'is_approved')) {
      registryDb.exec('ALTER TABLE churches ADD COLUMN is_approved INTEGER DEFAULT 0');
      // Approve all existing churches so they aren't locked out
      registryDb.exec('UPDATE churches SET is_approved = 1');
      console.log('✅ Registry migration: added is_approved column, approved all existing churches');
    }

    const lookupCols = registryDb.prepare('PRAGMA table_info(user_lookup)').all();
    if (!lookupCols.some(c => c.name === 'person_id')) {
      registryDb.exec('ALTER TABLE user_lookup ADD COLUMN person_id TEXT');
      console.log('✅ Registry migration: added person_id column to user_lookup');
    }
    registryDb.exec('CREATE INDEX IF NOT EXISTS idx_user_lookup_person ON user_lookup(person_id)');
  }

  static getRegistryDb() {
    return registryDb;
  }

  static closeChurchDb(churchId) {
    const db = churchDbs.get(churchId);
    if (db) {
      try { db.close(); } catch (_) {}
      churchDbs.delete(churchId);
    }
    churchTxLocks.delete(churchId);
  }

  static closeAll() {
    for (const [, db] of churchDbs) {
      try { db.close(); } catch (_) {}
    }
    churchDbs.clear();
    if (registryDb) {
      try { registryDb.close(); } catch (_) {}
      registryDb = null;
    }
  }
}

module.exports = Database;
