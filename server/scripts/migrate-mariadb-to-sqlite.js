#!/usr/bin/env node
/**
 * Migrate data from MariaDB to per-church SQLite databases.
 *
 * Usage:
 *   DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=root \
 *     node scripts/migrate-mariadb-to-sqlite.js
 *
 * Output:
 *   data/registry.sqlite          — church list + user lookup
 *   data/churches/{church_id}.sqlite — one file per church
 */

const mariadb = require('mariadb');
const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { REGISTRY_SCHEMA, CHURCH_SCHEMA, UPDATED_AT_TRIGGERS } = require('../config/schema');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT) || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'church_attendance';
const DATA_DIR = process.env.CHURCH_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DEFAULT_CHURCH_ID = process.env.MIGRATION_DEFAULT_CHURCH_ID || 'devch1';

const TABLES = [
  'users',
  'otc_codes',
  'church_settings',
  'gathering_types',
  'user_gathering_assignments',
  'families',
  'individuals',
  'gathering_lists',
  'attendance_sessions',
  'attendance_records',
  'headcount_records',
  'user_invitations',
  'notification_rules',
  'notifications',
  'audit_log',
  'ai_chat_conversations',
  'ai_chat_messages',
  'kiosk_checkins',
  'onboarding_progress',
  'visitor_config',
  'migrations',
  'user_preferences',
];

async function main() {
  console.log('🔄 Starting MariaDB → SQLite migration');
  console.log(`   MariaDB: ${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);
  console.log(`   Output:  ${DATA_DIR}`);

  const churchDir = path.join(DATA_DIR, 'churches');
  fs.mkdirSync(churchDir, { recursive: true });

  const pool = mariadb.createPool({
    host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
    database: DB_NAME, connectionLimit: 5,
    typeCast(field, next) {
      if (field.type === 'JSON') return field.string();
      if (field.type === 'BIGINT') return Number(field.string());
      return next();
    }
  });

  let conn;
  try {
    conn = await pool.getConnection();
    console.log('✅ Connected to MariaDB');

    const hasChurchId = await checkColumnExists(conn, 'users', 'church_id');
    console.log(`   Multi-tenant: ${hasChurchId ? 'yes' : 'no (single-tenant)'}`);

    let churchIds;
    if (hasChurchId) {
      const rows = await conn.query(
        'SELECT DISTINCT church_id FROM users WHERE church_id IS NOT NULL'
      );
      churchIds = rows.map(r => r.church_id);
    } else {
      churchIds = [DEFAULT_CHURCH_ID];
    }

    console.log(`   Churches found: ${churchIds.length} — ${churchIds.join(', ')}`);

    // --- Registry ---
    const registryPath = path.join(DATA_DIR, 'registry.sqlite');
    if (fs.existsSync(registryPath)) fs.unlinkSync(registryPath);
    const registry = new BetterSqlite3(registryPath);
    registry.pragma('journal_mode = WAL');
    registry.pragma('foreign_keys = ON');
    registry.exec(REGISTRY_SCHEMA);

    const insertChurch = registry.prepare(
      'INSERT OR IGNORE INTO churches (church_id, church_name) VALUES (?, ?)'
    );
    const insertLookup = registry.prepare(
      'INSERT OR REPLACE INTO user_lookup (user_id, email, mobile_number, church_id) VALUES (?, ?, ?, ?)'
    );

    for (const churchId of churchIds) {
      console.log(`\n📦 Migrating church: ${churchId}`);

      let churchName = churchId;
      if (hasChurchId) {
        const settings = await conn.query(
          'SELECT church_name FROM church_settings WHERE church_id = ?', [churchId]
        );
        if (settings.length > 0) churchName = settings[0].church_name;
      } else {
        const settings = await conn.query('SELECT church_name FROM church_settings LIMIT 1');
        if (settings.length > 0) churchName = settings[0].church_name;
      }

      insertChurch.run(churchId, churchName);

      const dbPath = path.join(churchDir, `${churchId}.sqlite`);
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      const db = new BetterSqlite3(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = OFF');
      db.exec(CHURCH_SCHEMA);

      for (const table of TABLES) {
        const tableExists = await checkTableExists(conn, table);
        if (!tableExists) {
          console.log(`   ⏭️  Table ${table} does not exist in MariaDB — skipping`);
          continue;
        }

        const sqliteCols = getSqliteColumns(db, table);
        if (sqliteCols.length === 0) {
          console.log(`   ⏭️  Table ${table} not in SQLite schema — skipping`);
          continue;
        }

        const mariaCols = await getMariaColumns(conn, table);
        const commonCols = sqliteCols.filter(c => mariaCols.includes(c));
        if (commonCols.length === 0) {
          console.log(`   ⏭️  No common columns for ${table} — skipping`);
          continue;
        }

        let whereClause = '';
        const params = [];
        if (hasChurchId && mariaCols.includes('church_id')) {
          whereClause = ' WHERE church_id = ?';
          params.push(churchId);
        }

        const rows = await conn.query(
          `SELECT ${commonCols.join(', ')} FROM ${table}${whereClause}`,
          params
        );

        if (rows.length === 0) {
          console.log(`   ✓ ${table}: 0 rows`);
          continue;
        }

        const placeholders = commonCols.map(() => '?').join(', ');
        const insert = db.prepare(
          `INSERT OR IGNORE INTO ${table} (${commonCols.join(', ')}) VALUES (${placeholders})`
        );

        const insertMany = db.transaction((rowList) => {
          for (const row of rowList) {
            const values = commonCols.map(col => {
              let v = row[col];
              if (v === undefined) v = null;
              if (typeof v === 'boolean') v = v ? 1 : 0;
              if (v instanceof Date) {
                // Date-only columns: store as YYYY-MM-DD, not full datetime
                const isDateOnly = col.includes('date') && !col.includes('datetime') && !col.includes('_at');
                if (isDateOnly && v.getHours() === 0 && v.getMinutes() === 0 && v.getSeconds() === 0) {
                  v = v.toISOString().split('T')[0];
                } else {
                  v = v.toISOString().replace('T', ' ').replace('Z', '');
                }
              }
              if (typeof v === 'object' && v !== null) v = JSON.stringify(v);
              return v;
            });
            insert.run(...values);
          }
        });

        insertMany(rows);
        console.log(`   ✓ ${table}: ${rows.length} rows`);

        if (table === 'users') {
          for (const row of rows) {
            insertLookup.run(
              row.id, row.email || null, row.mobile_number || null, churchId
            );
          }
        }
      }

      db.pragma('foreign_keys = ON');
      db.exec(UPDATED_AT_TRIGGERS);
      db.close();
    }

    registry.close();
    console.log('\n🎉 Migration complete!');
    console.log(`   Registry: ${registryPath}`);
    console.log(`   Churches: ${churchDir}/`);

  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    if (conn) conn.release();
    await pool.end();
  }
}

async function checkColumnExists(conn, table, column) {
  try {
    const rows = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [DB_NAME, table, column]
    );
    return rows.length > 0;
  } catch { return false; }
}

async function checkTableExists(conn, table) {
  try {
    const rows = await conn.query(
      'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [DB_NAME, table]
    );
    return rows.length > 0;
  } catch { return false; }
}

function getSqliteColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  } catch { return []; }
}

async function getMariaColumns(conn, table) {
  try {
    const rows = await conn.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [DB_NAME, table]
    );
    return rows.map(r => r.COLUMN_NAME);
  } catch { return []; }
}

main();
