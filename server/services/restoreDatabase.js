const fs = require('node:fs');
const path = require('node:path');
const BetterSqlite3 = require('better-sqlite3');

// Stage a consistent snapshot (including WAL) without modifying the backup.
// Strip credentials before installing it: neither the server nor a legacy
// token migration may ever see the backup's rotating OAuth credentials.
async function restoreChurchDatabase(sourcePath, destinationPath) {
  const stagingDir = fs.mkdtempSync(path.join(path.dirname(destinationPath), '.restore-church-'));
  const stagedPath = path.join(stagingDir, 'church.sqlite');
  try {
    const source = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(stagedPath);
    } finally {
      source.close();
    }

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

module.exports = { restoreChurchDatabase };
