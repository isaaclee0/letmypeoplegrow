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
      { version: 'v1.8.6_add_leader_checkin_enabled', name: 'add_leader_checkin_enabled', description: 'Add leader_checkin_enabled column to gathering_types' },
      { version: 'v1.8.6_backfill_leader_checkin', name: 'backfill_leader_checkin', description: 'Enable leader check-in for gatherings that had self check-in enabled' },
      { version: 'v1.9.0_add_church_approval', name: 'add_church_approval', description: 'Add is_approved column to churches registry table and approve all existing churches' },
      { version: 'v1.10.0_add_weekly_review_settings', name: 'add_weekly_review_settings', description: 'Add weekly review email settings to church_settings' },
      { version: 'v1.11.0_add_excluded_from_stats', name: 'add_excluded_from_stats', description: 'Add excluded_from_stats column to attendance_sessions' }
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
        if (migration.version === 'v1.8.6_add_leader_checkin_enabled') {
          const cols = await Database.query(`PRAGMA table_info(gathering_types)`);
          if (!cols.some(c => c.name === 'leader_checkin_enabled')) {
            await Database.query(`ALTER TABLE gathering_types ADD COLUMN leader_checkin_enabled INTEGER DEFAULT 0`);
            // Enable leader check-in for any gathering that already had self check-in enabled
            await Database.query(`UPDATE gathering_types SET leader_checkin_enabled = 1 WHERE kiosk_enabled = 1`);
            console.log(`  ✅ Added leader_checkin_enabled column to gathering_types`);
          }
        }

        if (migration.version === 'v1.8.6_backfill_leader_checkin') {
          await Database.query(`UPDATE gathering_types SET leader_checkin_enabled = 1 WHERE kiosk_enabled = 1`);
          console.log(`  ✅ Enabled leader check-in for existing self-checkin gatherings`);
        }

        if (migration.version === 'v1.9.0_add_church_approval') {
          // This migration runs per-church but the actual schema change is on the registry.
          // We handle it here so it's tracked, but the ALTER TABLE runs on the registry DB.
          // The registry migration is done in initializeDatabase() instead.
          console.log(`  ✅ Church approval migration tracked for ${churchId}`);
        }

        if (migration.version === 'v1.10.0_add_weekly_review_settings') {
          const cols = await Database.query(`PRAGMA table_info(church_settings)`);
          const colNames = cols.map(c => c.name);
          if (!colNames.includes('weekly_review_email_enabled')) {
            await Database.query(`ALTER TABLE church_settings ADD COLUMN weekly_review_email_enabled INTEGER DEFAULT 1`);
          }
          if (!colNames.includes('weekly_review_email_day')) {
            await Database.query(`ALTER TABLE church_settings ADD COLUMN weekly_review_email_day TEXT DEFAULT NULL`);
          }
          if (!colNames.includes('weekly_review_email_include_insight')) {
            await Database.query(`ALTER TABLE church_settings ADD COLUMN weekly_review_email_include_insight INTEGER DEFAULT 1`);
          }
          if (!colNames.includes('weekly_review_email_last_sent')) {
            await Database.query(`ALTER TABLE church_settings ADD COLUMN weekly_review_email_last_sent TEXT`);
          }
          console.log(`  ✅ Added weekly review email settings columns to church_settings`);
        }

        if (migration.version === 'v1.11.0_add_excluded_from_stats') {
          const cols = await Database.query(`PRAGMA table_info(attendance_sessions)`);
          if (!cols.some(c => c.name === 'excluded_from_stats')) {
            await Database.query(`ALTER TABLE attendance_sessions ADD COLUMN excluded_from_stats INTEGER DEFAULT 0`);
            console.log(`  ✅ Added excluded_from_stats column to attendance_sessions`);
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

    // Migrate registry: add is_approved column to churches table if missing
    Database.migrateRegistry();

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
