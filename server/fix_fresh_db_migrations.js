const Database = require('./config/database');

async function markMigrationsAsCompleted() {
  try {
    console.log('🔧 Marking migrations as completed for fresh database...');
    
    // List of migrations that are already applied via init.sql
    const migrations = [
      {
        version: '001',
        name: 'fix_audit_log',
        description: 'Fix audit_log table structure - Add missing entity_type and entity_id columns'
      },
      {
        version: '002', 
        name: 'add_contact_fields',
        description: 'Add visitor flag to individuals table - This helps identify people who were originally added as visitors'
      },
      {
        version: '003',
        name: 'enhance_visitors_table', 
        description: 'Enhance visitors table for better attendance tracking - Add session_id and improve visitor management'
      },
      {
        version: '004',
        name: 'fix_attendance_duplicates',
        description: 'Fix attendance duplicates - This migration adds a unique constraint to prevent duplicate attendance records'
      },
      {
        version: '005',
        name: 'add_attendance_updated_at',
        description: 'Add updated_at column to attendance_records - This migration adds the updated_at column to track when attendance records were last modified'
      }
    ];

    for (const migration of migrations) {
      // Check if migration already exists
      const existing = await Database.query(
        'SELECT * FROM migrations WHERE version = ?',
        [migration.version]
      );

      if (existing.length === 0) {
        // Insert migration as completed
        await Database.query(
          `INSERT INTO migrations (version, name, description, execution_time_ms, status) 
           VALUES (?, ?, ?, ?, ?)`,
          [migration.version, migration.name, migration.description, 0, 'success']
        );
        console.log(`✅ Marked migration ${migration.version} as completed`);
      } else {
        console.log(`ℹ️  Migration ${migration.version} already exists`);
      }
    }

    console.log('🎉 All migrations marked as completed!');
    console.log('📊 Migration status:');
    
    const allMigrations = await Database.query('SELECT version, name, status FROM migrations ORDER BY version');
    allMigrations.forEach(m => {
      console.log(`   ${m.version}: ${m.name} - ${m.status}`);
    });

  } catch (error) {
    console.error('❌ Error marking migrations as completed:', error);
  } finally {
    process.exit(0);
  }
}

markMigrationsAsCompleted(); 