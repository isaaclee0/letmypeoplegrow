const Database = require('./config/database');

async function runMigrations() {
  const churchId = Database.getCurrentChurchId();
  if (!churchId) return;

  try {
    console.log(`🔄 Checking migrations for church ${churchId}...`);

    // Migration versions are prefixed with the server version that introduced them
    // (e.g. v1.8.5_description) to avoid collisions. New columns/tables should be
    // added to schema.js for fresh databases; migrations here handle upgrades for
    // existing databases.
    const migrationFiles = [
      { version: 'v1.8.5_add_leader_checkin_enabled', name: 'add_leader_checkin_enabled', description: 'Add leader_checkin_enabled column to gathering_types' }
    ];

    const executedMigrations = await Database.query(
      "SELECT version FROM migrations WHERE status = 'success'"
    );
    const executedVersions = executedMigrations.map(row => row.version);
    const pendingMigrations = migrationFiles.filter(m => !executedVersions.includes(m.version));

    if (pendingMigrations.length === 0) return;

    console.log(`🔄 Running ${pendingMigrations.length} pending migrations for ${churchId}...`);

    for (const migration of pendingMigrations) {
      const startTime = Date.now();
      try {
        if (migration.version === 'v1.8.5_add_leader_checkin_enabled') {
          const cols = await Database.query(`PRAGMA table_info(gathering_types)`);
          if (!cols.some(c => c.name === 'leader_checkin_enabled')) {
            await Database.query(`ALTER TABLE gathering_types ADD COLUMN leader_checkin_enabled INTEGER DEFAULT 0`);
            console.log(`  ✅ Added leader_checkin_enabled column to gathering_types`);
          }
        }

        await Database.query(
          `INSERT OR IGNORE INTO migrations (version, name, description, execution_time_ms, status, executed_at)
           VALUES (?, ?, ?, ?, 'success', datetime('now'))`,
          [migration.version, migration.name, migration.description, Date.now() - startTime]
        );
      } catch (error) {
        console.error(`❌ Migration ${migration.name} failed:`, error);
      }
    }
  } catch (error) {
    console.error('❌ Migration process failed:', error);
  }
}

async function initializeDatabase() {
  try {
    console.log('🔍 Initializing SQLite databases...');

    Database.initialize();

    const churches = Database.listChurches();

    if (churches.length === 0) {
      console.log('📋 No churches found. A church will be created on first login/registration.');
    } else {
      console.log(`📋 Found ${churches.length} church(es). Verifying schemas...`);
      for (const church of churches) {
        try {
          Database.ensureChurchSchema(church.church_id);
          await Database.setChurchContext(church.church_id, () => runMigrations());
        } catch (err) {
          console.warn(`⚠️  Error checking church ${church.church_id}:`, err.message);
        }
      }
    }

    console.log('🎉 Database initialization completed!');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

async function startServer() {
  try {
    console.log('🚀 Starting server...');
    await initializeDatabase();
    console.log('✅ Database initialized');

    const PORT = process.env.PORT || 3001;
    const app = require('./index');
    app.listen(PORT, () => {
      console.log(`🎉 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV}`);
      console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

module.exports = { initializeDatabase, startServer };
