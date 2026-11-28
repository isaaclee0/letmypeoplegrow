const fs = require('node:fs');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');
const Database = require('../config/database');
const { REGISTRY_SCHEMA } = require('../config/schema');

async function snapshotDatabase(sourcePath, destinationPath) {
  const source = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destinationPath);
  } finally {
    source.close();
  }
}

async function restoreRegistryDatabase(sourcePath, destinationPath) {
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(destinationPath), '.restore-registry-'));
  const stagedPath = path.join(stagingDir, 'registry.sqlite');
  try {
    await snapshotDatabase(sourcePath, stagedPath);
    const staged = new BetterSqlite3(stagedPath);
    try {
      // Check the existing registry before creating any tables in the staged copy.
      staged.prepare('SELECT church_id, church_name FROM churches LIMIT 0').all();
      if (staged.pragma('quick_check', { simple: true }) !== 'ok') {
        throw new Error('Registry backup failed SQLite integrity checks');
      }
      staged.exec(REGISTRY_SCHEMA);
      Database.migrateRegistry(staged);
      // SQLite updates the live database transactionally, including for other open readers.
      const { totalPages } = await staged.backup(destinationPath);
      if (!totalPages) throw new Error('Registry restore could not write the destination database');
    } finally {
      staged.close();
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// Stage a consistent snapshot (including WAL) without modifying the backup.
// Strip credentials before installing it: neither the server nor a legacy
// token migration may ever see the backup's rotating OAuth credentials.
async function restoreChurchDatabase(sourcePath, destinationPath) {
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(destinationPath), '.restore-church-'));
  const stagedPath = path.join(stagingDir, 'church.sqlite');
  try {
    await snapshotDatabase(sourcePath, stagedPath);

    const staged = new BetterSqlite3(stagedPath);
    try {
      staged.pragma('secure_delete = ON');
      const hasTable = (name) => staged.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
      ).get(name);
      staged.transaction(() => {
        if (hasTable('integration_connections')) {
          staged.prepare("DELETE FROM integration_connections WHERE auth_type = 'oauth'").run();
        }
        // Older backups can otherwise resurrect a connection during migration.
        if (hasTable('user_preferences')) {
          staged.prepare("DELETE FROM user_preferences WHERE preference_key = 'planning_center_tokens'").run();
        }
      })();
      staged.pragma('wal_checkpoint(TRUNCATE)');
      staged.pragma('journal_mode = DELETE');
    } finally {
      staged.close();
    }

    for (const suffix of ['-wal', '-shm']) {
      fs.rmSync(destinationPath + suffix, { force: true });
    }
    fs.renameSync(stagedPath, destinationPath);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

module.exports = { restoreChurchDatabase, restoreRegistryDatabase };
