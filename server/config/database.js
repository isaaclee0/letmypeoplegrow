const BetterSqlite3 = require('better-sqlite3');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('path');
const fs = require('fs');
const { REGISTRY_SCHEMA, CHURCH_SCHEMA, UPDATED_AT_TRIGGERS } = require('./schema');

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
    registryDb.prepare(
      'DELETE FROM user_lookup WHERE user_id = ? AND church_id = ?'
    ).run(userId, churchId);
    registryDb.prepare(
      'INSERT OR REPLACE INTO user_lookup (user_id, email, mobile_number, church_id) VALUES (?, ?, ?, ?)'
    ).run(userId, email || null, mobileNumber || null, churchId);
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

  static listChurches() {
    if (!registryDb) return [];
    return registryDb.prepare('SELECT * FROM churches ORDER BY church_name').all();
  }

  static isChurchApproved(churchId) {
    if (!registryDb) return false;
    const row = registryDb.prepare('SELECT is_approved FROM churches WHERE church_id = ?').get(churchId);
    return row ? !!row.is_approved : false;
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
