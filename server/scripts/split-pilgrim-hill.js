#!/usr/bin/env node
// Manual, offline maintenance only. See docs/runbooks/split-pilgrim-hill.md.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const DB = require('better-sqlite3');

const q = value => '"' + value.replaceAll('"', '""') + '"';
const digest = value => createHash('sha256').update(value).digest('hex');
function check(condition, message) { if (!condition) throw new Error(message); }
function rows(db, table, schema = 'main') {
  return db.prepare(`SELECT * FROM ${schema}.${q(table)} ORDER BY rowid`).all();
}
function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, rows(db, name)]));
}
function insert(db, schema, table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${schema}.${q(table)} (${columns.map(q)}) VALUES (${columns.map(() => '?')})`)
    .run(...columns.map(column => row[column]));
}
function same(actual, expected, message) {
  // Avoid dumping private rows or credentials in assertion error output.
  check(JSON.stringify(actual) === JSON.stringify(expected), message);
}
function one(items, predicate, description) {
  const matches = items.filter(predicate);
  check(matches.length === 1, `Expected exactly one ${description}; found ${matches.length}`);
  return matches[0];
}
function plan(db, before, registry, sourceId, targetId) {
  const source = one(registry.churches, r => r.church_id === sourceId, 'source church');
  check(source.church_name === 'Redeemer Christian Church', 'Source must be Redeemer Christian Church');
  check(!registry.churches.some(r => r.church_id === targetId || /pilgrim\s+hill/i.test(r.church_name)), 'Pilgrim Hill already exists; refusing a repeat split');
  for (const [table, records] of Object.entries(before)) for (const row of records) {
    check(!row.church_id || row.church_id === sourceId, `Unexpected church_id in ${table}`);
  }
  const admin = one(before.users, r => r.first_name === 'Isaac' && r.last_name === 'Lee', 'Isaac Lee admin');
  check(admin.role === 'admin' && admin.is_active === 1, 'Isaac must be an active admin');
  const movedUsers = [['Peirce', 'Baehr'], ['Miriam', 'Kewley'], ['Naomi', 'Kewley']].map(([first, last]) =>
    one(before.users, r => r.first_name === first && r.last_name === last, `${first} ${last}`));
  const movedIds = movedUsers.map(r => r.id);
  const gatherings = ['Hub', 'Hall'].map(place => one(before.gathering_types,
    r => new RegExp(`^2025 Pilgrim Artists Festivall? - ${place}$`).test(r.name), `Pilgrim festival ${place}`));
  check(gatherings.every(r => r.attendance_type === 'headcount'), 'Pilgrim gatherings must use headcounts');
  const gids = gatherings.map(r => r.id), names = gatherings.map(r => r.name);
  const sessions = before.attendance_sessions.filter(r => gids.includes(r.gathering_type_id));
  const sids = sessions.map(r => r.id);
  const audit = before.audit_log.filter(r => {
    const value = JSON.parse(r.new_values || '{}');
    return names.includes(value.serviceName) || (/GATHERING_TYPE/.test(r.action) && gids.includes(r.record_id) && names.includes(value.name));
  });
  // Headcount-only extraction: never copy the wider church roster or integrations.
  const selected = {
    users: [admin, ...movedUsers].sort((a, b) => a.id - b.id),
    gathering_types: gatherings.sort((a, b) => a.id - b.id),
    user_gathering_assignments: before.user_gathering_assignments.filter(r => gids.includes(r.gathering_type_id)),
    attendance_sessions: sessions,
    headcount_records: before.headcount_records.filter(r => sids.includes(r.session_id)),
    user_invitations: before.user_invitations.filter(r => {
      const ids = JSON.parse(r.gathering_assignments || '[]');
      if (!ids.some(id => gids.includes(id))) return false;
      check(ids.every(id => gids.includes(id)), 'Mixed gathering invitation requires manual review');
      return true;
    }),
    user_preferences: before.user_preferences.filter(r => movedIds.includes(r.user_id)),
    audit_log: audit,
  };
  const copiedUserIds = selected.users.map(r => r.id);
  for (const [table, records] of Object.entries(selected)) for (const row of records) {
    for (const field of ['user_id', 'created_by', 'updated_by', 'assigned_by', 'invited_by', 'cancelled_by']) {
      check(row[field] == null || copiedUserIds.includes(row[field]), `Unreviewed user reference: ${table}.${field}`);
    }
  }
  for (const pref of selected.user_preferences) {
    check(['attendance_gathering_dates', 'attendance_last_viewed'].includes(pref.preference_key), `Unreviewed preference: ${pref.preference_key}`);
    const value = JSON.parse(pref.preference_value);
    const ids = pref.preference_key === 'attendance_last_viewed' ? [value.gatheringId] : Object.keys(value).filter(k => k !== 'timestamp').map(Number);
    check(ids.every(id => gids.includes(id)), 'Preference references a non-Pilgrim gathering');
  }
  for (const u of movedUsers) check(u.default_gathering_id == null || gids.includes(u.default_gathering_id), 'Moved user has a Redeemer default gathering');
  for (const [table, records] of Object.entries(before)) {
    const included = new Set((selected[table] || []).map(r => r.id));
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${q(table)})`).all();
    for (const row of records) {
      // Also cover compatibility tables lacking declared foreign keys.
      const referenced = movedIds.includes(row.user_id) || movedIds.includes(row.created_by) || movedIds.includes(row.updated_by)
        || gids.includes(row.gathering_type_id) || sids.includes(row.session_id)
        || foreignKeys.some(fk => (fk.table === 'users' && movedIds.includes(row[fk.from]))
          || (fk.table === 'gathering_types' && gids.includes(row[fk.from]))
          || (fk.table === 'attendance_sessions' && sids.includes(row[fk.from])));
      check(!referenced || included.has(row.id), `Unplanned dependency: ${table} row ${row.id}`);
    }
  }
  for (const u of selected.users) {
    const lookup = one(registry.user_lookup, r => r.user_id === u.id && r.church_id === sourceId, `login route for ${u.first_name}`);
    check(lookup.email === u.email && lookup.mobile_number === u.mobile_number, 'Login route does not match account');
  }
  return { selected, admin, movedIds, gids };
}

async function run({ dataDir, sourceId, targetId, apply = false, maintenanceConfirmed = false }) {
  check(dataDir && sourceId && targetId, 'dataDir, sourceId and targetId are required');
  check([sourceId, targetId].every(id => /^[a-zA-Z0-9_-]+$/.test(id)) && sourceId !== targetId, 'Invalid church ID');
  check(!apply || maintenanceConfirmed, 'Apply requires --maintenance-confirmed after stopping ALL database writers');
  const sourcePath = path.resolve(dataDir, 'churches', sourceId + '.sqlite');
  const registryPath = path.resolve(dataDir, 'registry.sqlite');
  const targetPath = path.resolve(dataDir, 'churches', targetId + '.sqlite');
  check(!fs.existsSync(targetPath), 'Target database already exists');
  const handles = [];
  const open = (file, options = {}) => { const db = new DB(file, options); handles.push(db); return db; };
  let targetCreated = false, committed = false, db, backupDirectory;
  try {
    const original = open(sourcePath, { readonly: true, fileMustExist: true });
    const originalRegistry = open(registryPath, { readonly: true, fileMustExist: true });
    // Reject wrong identities and dependencies before making any destination file.
    plan(original, snapshot(original), snapshot(originalRegistry), sourceId, targetId);
    backupDirectory = fs.mkdtempSync(path.join(path.resolve(dataDir), 'pilgrim-split-'));
    fs.chmodSync(backupDirectory, 0o700);
    await original.backup(path.join(backupDirectory, 'redeemer-before.sqlite'));
    await originalRegistry.backup(path.join(backupDirectory, 'registry-before.sqlite'));
    original.close(); originalRegistry.close();
    const beforeDb = open(path.join(backupDirectory, 'redeemer-before.sqlite'), { readonly: true });
    const regBeforeDb = open(path.join(backupDirectory, 'registry-before.sqlite'), { readonly: true });
    const before = snapshot(beforeDb), registry = snapshot(regBeforeDb);
    const { selected, admin, movedIds, gids } = plan(beforeDb, before, registry, sourceId, targetId);
    const report = {
      mode: apply ? 'apply' : 'dry-run', sourceId, targetId, backupDirectory,
      gatherings: selected.gathering_types.map(r => ({ id: r.id, name: r.name })),
      sessions: selected.attendance_sessions.length, headcountEntries: selected.headcount_records.length,
      headcountTotal: selected.headcount_records.reduce((sum, row) => sum + row.headcount, 0),
      auditEntries: selected.audit_log.length,
      movedAccounts: selected.users.filter(r => movedIds.includes(r.id)).map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, role: r.role })),
      sharedAdmin: { id: admin.id, name: 'Isaac Lee' },
      sourceTablesVerified: Object.keys(before).length,
      backupHashes: Object.fromEntries(['redeemer-before.sqlite', 'registry-before.sqlite'].map(file => [file, digest(fs.readFileSync(path.join(backupDirectory, file)))])),
    };
    fs.writeFileSync(path.join(backupDirectory, 'plan.json'), JSON.stringify(report, null, 2));
    let workingSource = sourcePath, workingRegistry = registryPath, workingTarget = targetPath;
    if (!apply) {
      workingSource = path.join(backupDirectory, 'redeemer-rehearsal.sqlite');
      workingRegistry = path.join(backupDirectory, 'registry-rehearsal.sqlite');
      workingTarget = path.join(backupDirectory, 'pilgrim-rehearsal.sqlite');
      fs.copyFileSync(path.join(backupDirectory, 'redeemer-before.sqlite'), workingSource);
      fs.copyFileSync(path.join(backupDirectory, 'registry-before.sqlite'), workingRegistry);
    }
    check(fs.statSync(path.dirname(workingSource)).dev === fs.statSync(path.dirname(workingRegistry)).dev, 'Databases must be on the same filesystem');
    // Rollback journals permit a crash-atomic multi-file ATTACH transaction (WAL does not).
    db = open(workingSource); db.pragma('busy_timeout=5000');
    check(db.pragma('journal_mode=DELETE', { simple: true }) === 'delete', 'Cannot leave WAL mode; stop all writers');
    const regWriter = open(workingRegistry);
    check(regWriter.pragma('journal_mode=DELETE', { simple: true }) === 'delete', 'Registry busy; stop all writers');
    regWriter.close();
    // Exclusive creation prevents an existing destination being overwritten.
    fs.closeSync(fs.openSync(workingTarget, 'wx', 0o600)); targetCreated = apply;
    const fresh = open(workingTarget);
    for (const { sql } of beforeDb.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all()) fresh.exec(sql);
    fresh.close();
    db.pragma('foreign_keys=ON'); db.pragma('synchronous=FULL');
    db.prepare('ATTACH DATABASE ? AS target').run(workingTarget);
    db.prepare('ATTACH DATABASE ? AS registry').run(workingRegistry);
    db.exec('PRAGMA target.synchronous=FULL; PRAGMA registry.synchronous=FULL; BEGIN IMMEDIATE');
    try {
      same(snapshot(db), before, 'Source changed after backup; retry during maintenance');
      for (const [table, expected] of Object.entries(registry)) same(rows(db, table, 'registry'), expected, 'Registry changed after backup');
      for (const schema of ['main', 'registry']) check(db.prepare(`PRAGMA ${schema}.foreign_key_check`).all().length === 0, 'Existing foreign-key violations');
      for (const row of before.migrations || []) insert(db, 'target', 'migrations', row);
      for (const [table, records] of Object.entries(selected)) for (const row of records) {
        insert(db, 'target', table, { ...row, church_id: targetId, ...(table === 'users' && row.id === admin.id ? { default_gathering_id: gids[0] } : {}) });
      }
      for (const gatheringId of gids) {
        if (!selected.user_gathering_assignments.some(r => r.user_id === admin.id && r.gathering_type_id === gatheringId))
          insert(db, 'target', 'user_gathering_assignments', { user_id: admin.id, gathering_type_id: gatheringId, assigned_by: admin.id, church_id: targetId });
      }
      const settings = one(before.church_settings, r => r.church_id === sourceId, 'church settings');
      insert(db, 'target', 'church_settings', { church_id: targetId, church_name: 'Pilgrim Hill', country_code: settings.country_code, timezone: settings.timezone, default_gathering_duration: settings.default_gathering_duration, onboarding_completed: 1, has_sample_data: 0, weekly_review_email_enabled: 0 });
      insert(db, 'target', 'visitor_config', { church_id: targetId });
      db.prepare("INSERT OR IGNORE INTO target.people_sync_settings (church_id,authority_provider) VALUES (?,'none')").run(targetId);
      insert(db, 'registry', 'churches', { church_id: targetId, church_name: 'Pilgrim Hill', is_approved: 1 });
      for (const u of selected.users) {
        const { id, ...lookup } = registry.user_lookup.find(r => r.user_id === u.id && r.church_id === sourceId);
        if (u.id === admin.id) {
          const personId = lookup.person_id || randomUUID();
          db.prepare('UPDATE registry.user_lookup SET person_id=? WHERE id=?').run(personId, id);
          insert(db, 'registry', 'user_lookup', { ...lookup, church_id: targetId, person_id: personId });
        } else db.prepare('UPDATE registry.user_lookup SET church_id=? WHERE id=?').run(targetId, id);
      }
      for (const table of ['audit_log', 'user_preferences', 'user_invitations', 'headcount_records', 'attendance_sessions', 'user_gathering_assignments', 'gathering_types', 'users']) {
        for (const row of selected[table].filter(r => table !== 'users' || movedIds.includes(r.id)))
          check(db.prepare(`DELETE FROM main.${q(table)} WHERE id=?`).run(row.id).changes === 1, 'Unexpected deletion count');
      }
      for (const [table, records] of Object.entries(before)) {
        const removed = new Set((selected[table] || []).filter(r => table !== 'users' || movedIds.includes(r.id)).map(r => r.id));
        same(rows(db, table), records.filter(r => !removed.has(r.id)), `Unexpected source change in ${table}`);
      }
      for (const [table, records] of Object.entries(selected)) {
        const expected = records.map(r => ({ ...r, church_id: targetId, ...(table === 'users' && r.id === admin.id ? { default_gathering_id: gids[0] } : {}) })).sort((a,b) => a.id-b.id);
        const ids = new Set(expected.map(r => r.id));
        const actual = rows(db, table, 'target');
        same(table === 'user_gathering_assignments' ? actual.filter(r => ids.has(r.id)) : actual, expected, `Destination mismatch in ${table}`);
      }
      for (const schema of ['main', 'target', 'registry']) {
        check(db.prepare(`PRAGMA ${schema}.foreign_key_check`).all().length === 0, `Foreign-key check failed: ${schema}`);
        check(Object.values(db.prepare(`PRAGMA ${schema}.integrity_check`).get())[0] === 'ok', `Integrity check failed: ${schema}`);
      }
      db.exec('COMMIT'); committed = true;
    } catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error; }
    fs.writeFileSync(path.join(backupDirectory, 'completed.json'), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    if (committed) error.message = `SPLIT COMMITTED, but reporting failed. Do not rerun. Backups: ${backupDirectory}. ${error.message}`;
    throw error;
  } finally {
    for (const handle of handles.reverse()) if (handle.open) handle.close();
    if (targetCreated && !committed) fs.rmSync(targetPath, { force: true });
  }
}

if (require.main === module) {
  process.umask(0o077);
  try {
    const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, source: { type: 'string' }, target: { type: 'string' }, apply: { type: 'boolean' }, 'maintenance-confirmed': { type: 'boolean' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: node scripts/split-pilgrim-hill.js --source <Redeemer church ID> --target <new Pilgrim church ID> [--data-dir /app/data] [--apply --maintenance-confirmed]\nDefaults to a complete rehearsal on copies. Apply only with ALL writers stopped. See docs/runbooks/split-pilgrim-hill.md.');
    else run({ dataDir: values['data-dir'] || process.env.CHURCH_DATA_DIR || path.join(__dirname, '../data'), sourceId: values.source, targetId: values.target, apply: values.apply, maintenanceConfirmed: values['maintenance-confirmed'] })
      .then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { run };
