#!/usr/bin/env node

const Database = require('./config/database');
const fs = require('fs');
const path = require('path');

async function runMigration022() {
  try {
    console.log('🔄 Running migration 022: Create migration_executions table...');
    
    const sqlContent = fs.readFileSync(path.join(__dirname, 'migrations', '022_create_migration_executions_table.sql'), 'utf8');
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'))
      .map(stmt => stmt + ';');
    
    for (const statement of statements) {
      console.log(`Executing: ${statement.substring(0, 50)}...`);
      await Database.query(statement);
    }
    
    console.log('✅ Migration 022 executed successfully');
    
    // Mark migration as completed
    await Database.query(`
      INSERT IGNORE INTO migrations (version, name, description, execution_time_ms, status, executed_at) 
      VALUES ('022', 'create_migration_executions_table', 'Create migration_executions table for advanced migration tracking', 0, 'success', NOW())
    `);
    
    console.log('✅ Migration 022 marked as completed');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
}

// Run the migration if this file is executed directly
if (require.main === module) {
  runMigration022()
    .then(() => {
      console.log('🎉 Migration 022 completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration 022 failed:', error);
      process.exit(1);
    });
}

module.exports = { runMigration022 };
