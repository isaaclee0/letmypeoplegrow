const Database = require('./config/database');

async function runMigrations() {
  const churchId = Database.getCurrentChurchId();
  if (!churchId) return;

  try {
    console.log(`🔄 Checking migrations for church ${churchId}...`);

    const migrationFiles = [
      { version: '001', name: 'fix_audit_log', description: 'Fix audit log table structure' },
      { version: '002', name: 'add_contact_fields', description: 'Add contact method fields to users' },
      { version: '003', name: 'enhance_visitors_table', description: 'Enhance visitors table with additional fields' },
      { version: '004', name: 'fix_attendance_duplicates', description: 'Fix duplicate attendance records' },
      { version: '005', name: 'add_attendance_updated_at', description: 'Add updated_at field to attendance records' },
      { version: '006', name: 'fix_attendance_sessions_unique_constraint', description: 'Fix attendance sessions unique constraint to include church_id' },
      { version: '007', name: 'add_visitor_config', description: 'Add visitor filtering configuration table' },
      { version: '008_add_roster_snapshotted', name: 'add_roster_snapshotted', description: 'Add roster_snapshotted column to attendance_sessions and backfill people_type_at_time' }
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
        // Execute migration-specific SQL
        if (migration.version === '008_add_roster_snapshotted') {
          // Add roster_snapshotted column to attendance_sessions if missing
          const cols = await Database.query(`PRAGMA table_info(attendance_sessions)`);
          if (!cols.some(c => c.name === 'roster_snapshotted')) {
            await Database.query(`ALTER TABLE attendance_sessions ADD COLUMN roster_snapshotted INTEGER DEFAULT 0`);
            console.log(`  ✅ Added roster_snapshotted column to attendance_sessions`);
          }
          // Backfill NULL people_type_at_time with current people_type (best available data)
          await Database.query(`
            UPDATE attendance_records
            SET people_type_at_time = (
              SELECT COALESCE(i.people_type, 'regular')
              FROM individuals i
              WHERE i.id = attendance_records.individual_id
            )
            WHERE people_type_at_time IS NULL
          `);
          console.log(`  ✅ Backfilled NULL people_type_at_time values`);
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
