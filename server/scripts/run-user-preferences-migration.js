const Database = require('../config/database');

async function runMigration() {
  try {
    console.log('🚀 Starting user preferences migration...');
    
    // Read and execute the migration SQL
    const fs = require('fs');
    const path = require('path');
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, 'user-preferences-migration.sql'), 
      'utf8'
    );
    
    // Split by semicolon and execute each statement
    const statements = migrationSQL
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));
    
    for (const statement of statements) {
      if (statement.trim()) {
        console.log(`Executing: ${statement.substring(0, 50)}...`);
        await Database.query(statement);
      }
    }
    
    console.log('✅ User preferences migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    // Database connection is managed by the pool, no need to close
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  runMigration().catch(console.error);
}

module.exports = runMigration;
