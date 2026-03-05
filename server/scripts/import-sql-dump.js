#!/usr/bin/env node
/**
 * Import a phpMyAdmin SQL dump into per-church SQLite databases.
 *
 * Usage:
 *   node scripts/import-sql-dump.js <path-to-dump.sql>
 *
 * Output:
 *   data/registry.sqlite          — church list + user lookup
 *   data/churches/{church_id}.sqlite — one file per church
 */

const BetterSqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { REGISTRY_SCHEMA, CHURCH_SCHEMA, UPDATED_AT_TRIGGERS } = require('../config/schema');

const DATA_DIR = process.env.CHURCH_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dumpPath = process.argv[2];

if (!dumpPath) {
  console.error('Usage: node scripts/import-sql-dump.js <path-to-dump.sql>');
  process.exit(1);
}
if (!fs.existsSync(dumpPath)) {
  console.error(`File not found: ${dumpPath}`);
  process.exit(1);
}

const TABLES = [
  'users', 'otc_codes', 'church_settings', 'gathering_types',
  'user_gathering_assignments', 'families', 'individuals', 'gathering_lists',
  'attendance_sessions', 'attendance_records', 'headcount_records',
  'user_invitations', 'notification_rules', 'notifications', 'audit_log',
  'ai_chat_conversations', 'ai_chat_messages', 'kiosk_checkins',
  'onboarding_progress', 'visitor_config', 'migrations', 'user_preferences',
];

function main() {
  console.log('📂 Reading SQL dump...');
  const sql = fs.readFileSync(dumpPath, 'utf8');

  console.log('🔍 Parsing INSERT statements...');
  const tableData = parseInserts(sql);

  const tables = Object.keys(tableData);
  console.log(`   Found ${tables.length} tables with data: ${tables.join(', ')}`);

  const churchIds = discoverChurches(tableData);
  console.log(`   Churches found: ${churchIds.size} — ${[...churchIds.keys()].join(', ')}`);

  const churchDir = path.join(DATA_DIR, 'churches');
  fs.mkdirSync(churchDir, { recursive: true });

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

  for (const [churchId, churchName] of churchIds) {
    console.log(`\n📦 Migrating church: ${churchId} (${churchName})`);
    insertChurch.run(churchId, churchName);

    const dbPath = path.join(churchDir, `${churchId}.sqlite`);
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const db = new BetterSqlite3(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    db.exec(CHURCH_SCHEMA);

    for (const table of TABLES) {
      if (!tableData[table]) {
        continue;
      }

      const { columns, rows } = tableData[table];
      const sqliteCols = getSqliteColumns(db, table);
      if (sqliteCols.length === 0) continue;

      const churchIdColIdx = columns.indexOf('church_id');
      const commonCols = columns.filter(c => sqliteCols.includes(c));
      if (commonCols.length === 0) continue;

      const commonColIndices = commonCols.map(c => columns.indexOf(c));

      let churchRows;
      if (churchIdColIdx >= 0) {
        churchRows = rows.filter(r => r[churchIdColIdx] === churchId);
      } else {
        churchRows = rows;
      }

      if (churchRows.length === 0) {
        console.log(`   ✓ ${table}: 0 rows`);
        continue;
      }

      const placeholders = commonCols.map(() => '?').join(', ');
      const insert = db.prepare(
        `INSERT OR IGNORE INTO ${table} (${commonCols.join(', ')}) VALUES (${placeholders})`
      );

      const insertMany = db.transaction((rowList) => {
        for (const row of rowList) {
          const values = commonColIndices.map(idx => {
            let v = row[idx];
            if (v === undefined) v = null;
            if (typeof v === 'boolean') v = v ? 1 : 0;
            return v;
          });
          insert.run(...values);
        }
      });

      insertMany(churchRows);
      console.log(`   ✓ ${table}: ${churchRows.length} rows`);

      if (table === 'users') {
        const emailIdx = columns.indexOf('email');
        const mobileIdx = columns.indexOf('mobile_number');
        const idIdx = columns.indexOf('id');
        for (const row of churchRows) {
          insertLookup.run(
            row[idIdx],
            emailIdx >= 0 ? row[emailIdx] : null,
            mobileIdx >= 0 ? row[mobileIdx] : null,
            churchId
          );
        }
      }
    }

    db.pragma('foreign_keys = ON');
    db.exec(UPDATED_AT_TRIGGERS);
    db.close();
  }

  registry.close();
  console.log('\n🎉 Import complete!');
  console.log(`   Registry: ${path.join(DATA_DIR, 'registry.sqlite')}`);
  console.log(`   Churches: ${churchDir}/`);
}

/**
 * Parse all INSERT statements from the SQL dump.
 * Returns { tableName: { columns: [...], rows: [[...], ...] } }
 */
function parseInserts(sql) {
  const result = {};
  const insertRegex = /INSERT INTO `(\w+)` \(([^)]+)\) VALUES\s*/g;
  let match;

  while ((match = insertRegex.exec(sql)) !== null) {
    const table = match[1];
    const columns = match[2].replace(/`/g, '').split(',').map(c => c.trim());
    const startPos = match.index + match[0].length;

    const rows = parseValueRows(sql, startPos);
    if (!result[table]) {
      result[table] = { columns, rows: [] };
    }
    result[table].rows.push(...rows);
  }

  return result;
}

/**
 * Parse the VALUES portion: (v1, v2, ...), (v1, v2, ...), ... ;
 * Handles escaped strings, NULL, numbers, nested parens in strings.
 */
function parseValueRows(sql, startPos) {
  const rows = [];
  let i = startPos;
  const len = sql.length;

  while (i < len) {
    // Skip whitespace and newlines
    while (i < len && /\s/.test(sql[i])) i++;

    if (i >= len || sql[i] === ';') break;

    if (sql[i] === ',') {
      i++;
      continue;
    }

    if (sql[i] === '(') {
      const [row, endIdx] = parseOneRow(sql, i);
      rows.push(row);
      i = endIdx;
    } else {
      break;
    }
  }

  return rows;
}

/**
 * Parse a single (v1, v2, ...) tuple starting at position i (which is '(').
 * Returns [values_array, next_position].
 */
function parseOneRow(sql, start) {
  const values = [];
  let i = start + 1; // skip '('
  const len = sql.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(sql[i])) i++;

    if (sql[i] === ')') {
      i++;
      return [values, i];
    }

    if (sql[i] === ',') {
      i++;
      while (i < len && /\s/.test(sql[i])) i++;
      continue;
    }

    if (sql[i] === "'") {
      // String value — handle escapes
      let str = '';
      i++; // skip opening quote
      while (i < len) {
        if (sql[i] === '\\') {
          const next = sql[i + 1];
          if (next === "'") { str += "'"; i += 2; }
          else if (next === '\\') { str += '\\'; i += 2; }
          else if (next === 'n') { str += '\n'; i += 2; }
          else if (next === 'r') { str += '\r'; i += 2; }
          else if (next === 't') { str += '\t'; i += 2; }
          else if (next === '0') { str += '\0'; i += 2; }
          else { str += next; i += 2; }
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          str += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++; // skip closing quote
          break;
        } else {
          str += sql[i];
          i++;
        }
      }
      values.push(str);
    } else if (sql.substring(i, i + 4).toUpperCase() === 'NULL') {
      values.push(null);
      i += 4;
    } else {
      // Number or other literal
      let num = '';
      while (i < len && sql[i] !== ',' && sql[i] !== ')' && !/\s/.test(sql[i])) {
        num += sql[i];
        i++;
      }
      const parsed = Number(num);
      values.push(isNaN(parsed) ? num : parsed);
    }
  }

  return [values, i];
}

/**
 * Discover all church_ids and their names from the parsed data.
 */
function discoverChurches(tableData) {
  const churches = new Map();

  // Get names from church_settings if available
  if (tableData.church_settings) {
    const { columns, rows } = tableData.church_settings;
    const idIdx = columns.indexOf('church_id');
    const nameIdx = columns.indexOf('church_name');
    if (idIdx >= 0 && nameIdx >= 0) {
      for (const row of rows) {
        churches.set(row[idIdx], row[nameIdx]);
      }
    }
  }

  // Also scan users table for any church_ids not in settings
  if (tableData.users) {
    const { columns, rows } = tableData.users;
    const idIdx = columns.indexOf('church_id');
    if (idIdx >= 0) {
      for (const row of rows) {
        if (row[idIdx] && !churches.has(row[idIdx])) {
          churches.set(row[idIdx], row[idIdx]);
        }
      }
    }
  }

  return churches;
}

function getSqliteColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  } catch { return []; }
}

main();
