#!/usr/bin/env node

/**
 * CLI script to run database migrations from the command line
 * 
 * Usage:
 *   node scripts/run-migrations.js status          - Show migration status
 *   node scripts/run-migrations.js list            - List all migrations
 *   node scripts/run-migrations.js run <version>    - Run a specific migration
 *   node scripts/run-migrations.js run-all          - Run all pending migrations
 */

const Database = require('../config/database');
const fs = require('fs');
const path = require('path');

// Helper function to split SQL content into individual statements
function splitSqlStatements(sqlContent) {
  return sqlContent
    .split(';')
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'))
    .map(stmt => stmt + ';');
}

// Helper function to execute multiple SQL statements
async function executeMultipleStatements(sqlContent) {
  const statements = splitSqlStatements(sqlContent);
  console.log(`Executing ${statements.length} statements...`);
  
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    console.log(`Executing statement ${i + 1}/${statements.length}: ${statement.substring(0, 50)}...`);
    
    try {
      await Database.query(statement);
      console.log(`✅ Statement ${i + 1} executed successfully`);
    } catch (error) {
      console.error(`❌ Statement ${i + 1} failed:`, error.message);
      throw error;
    }
  }
  
  return { success: true, statementsExecuted: statements.length };
}

// Helper function to get migration description
function getMigrationDescription(version) {
  const descriptions = {
    '001': 'Fix audit_log table structure',
    '002': 'Add contact method fields to users',
    '003': 'Enhance visitors table with additional fields',
    '004': 'Fix duplicate attendance records',
    '005': 'Add updated_at field to attendance records',
    '006': 'Fix attendance sessions unique constraint to include church_id',
    '007': 'Add visitor filtering configuration table',
    '018_add_elvanto_config': 'Add Elvanto OAuth configuration to church_settings',
    '019_add_historical_people_type': 'Add historical people_type tracking to attendance_records',
  };
  return descriptions[version] || `Migration ${version}`;
}

// Ensure migrations table exists
async function ensureMigrationsTable() {
  await Database.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      version VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      execution_time_ms INT,
      status ENUM('success', 'failed') DEFAULT 'success',
      error_message TEXT
    ) ENGINE=InnoDB
  `);
}

// Get migration status
async function getMigrationStatus() {
  await ensureMigrationsTable();
  
  const executedMigrations = await Database.query(
    'SELECT * FROM migrations ORDER BY version'
  );

  const migrationsDir = path.join(__dirname, '../migrations');
  const availableMigrations = [];
  
  if (fs.existsSync(migrationsDir)) {
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
    
    for (const file of files) {
      const version = file.replace('.sql', '');
      const executed = executedMigrations.find(m => m.version === version);
      
      availableMigrations.push({
        version,
        name: file,
        description: getMigrationDescription(version),
        executed: !!executed,
        executedAt: executed?.executed_at,
        status: executed?.status || 'pending',
        errorMessage: executed?.error_message
      });
    }
  }

  return availableMigrations;
}

// Run a specific migration
async function runMigration(version) {
  await ensureMigrationsTable();
  
  // Check if migration already executed
  const existing = await Database.query(
    'SELECT * FROM migrations WHERE version = ?',
    [version]
  );
  
  if (existing.length > 0 && existing[0].status === 'success') {
    throw new Error(`Migration ${version} has already been executed successfully`);
  }

  // Read migration file
  const migrationFile = path.join(__dirname, '../migrations', `${version}.sql`);
  if (!fs.existsSync(migrationFile)) {
    throw new Error(`Migration file not found: ${migrationFile}`);
  }

  const sqlContent = fs.readFileSync(migrationFile, 'utf8');
  const migrationName = getMigrationDescription(version);

  console.log(`🔄 Running migration: ${version} - ${migrationName}`);
  
  // Start transaction
  await Database.query('START TRANSACTION');

  const startTime = Date.now();
  let status = 'success';
  let errorMessage = null;

  try {
    // Execute the entire SQL content as one block to handle prepared statements
    await executeMultipleStatements(sqlContent);

    // Record successful migration (or update if it was previously failed)
    if (existing.length > 0) {
      await Database.query(`
        UPDATE migrations 
        SET name = ?, description = ?, execution_time_ms = ?, status = ?, error_message = NULL, executed_at = NOW()
        WHERE version = ?
      `, [`${version}.sql`, migrationName, Date.now() - startTime, status, version]);
    } else {
      await Database.query(`
        INSERT INTO migrations (version, name, description, execution_time_ms, status)
        VALUES (?, ?, ?, ?, ?)
      `, [version, `${version}.sql`, migrationName, Date.now() - startTime, status]);
    }

    await Database.query('COMMIT');

    console.log(`✅ Migration ${version} executed successfully (${Date.now() - startTime}ms)`);
    
    return { 
      message: 'Migration executed successfully',
      version,
      executionTime: Date.now() - startTime
    };

  } catch (error) {
    await Database.query('ROLLBACK');
    status = 'failed';
    errorMessage = error.message;

    // Record failed migration
    if (existing.length > 0) {
      await Database.query(`
        UPDATE migrations 
        SET name = ?, description = ?, execution_time_ms = ?, status = ?, error_message = ?, executed_at = NOW()
        WHERE version = ?
      `, [`${version}.sql`, migrationName, Date.now() - startTime, status, errorMessage, version]);
    } else {
      await Database.query(`
        INSERT INTO migrations (version, name, description, execution_time_ms, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [version, `${version}.sql`, migrationName, Date.now() - startTime, status, errorMessage]);
    }

    throw error;
  }
}

// Run all pending migrations
async function runAllPendingMigrations() {
  const migrations = await getMigrationStatus();
  const pendingMigrations = migrations.filter(m => !m.executed || m.status === 'failed');

  if (pendingMigrations.length === 0) {
    console.log('✅ No pending migrations');
    return { successCount: 0, failureCount: 0, results: [] };
  }

  console.log(`🔄 Found ${pendingMigrations.length} pending migration(s)`);
  
  const results = [];
  let successCount = 0;
  let failureCount = 0;

  for (const migration of pendingMigrations) {
    try {
      const result = await runMigration(migration.version);
      results.push({ version: migration.version, status: 'success', ...result });
      successCount++;
    } catch (error) {
      results.push({ 
        version: migration.version, 
        status: 'failed', 
        error: error.message 
      });
      failureCount++;
      console.error(`❌ Migration ${migration.version} failed:`, error.message);
    }
  }

  console.log(`\n📊 Summary: ${successCount} succeeded, ${failureCount} failed`);
  
  return { successCount, failureCount, results };
}

// Display migration status
async function displayStatus() {
  const migrations = await getMigrationStatus();
  const pending = migrations.filter(m => !m.executed || m.status === 'failed');
  const executed = migrations.filter(m => m.executed && m.status === 'success');
  const failed = migrations.filter(m => m.executed && m.status === 'failed');

  console.log('\n📋 Migration Status\n');
  console.log(`Total migrations: ${migrations.length}`);
  console.log(`✅ Executed: ${executed.length}`);
  console.log(`⏳ Pending: ${pending.length}`);
  console.log(`❌ Failed: ${failed.length}`);
  
  if (pending.length > 0) {
    console.log('\n⏳ Pending migrations:');
    pending.forEach(m => {
      console.log(`  - ${m.version}: ${m.description} ${m.status === 'failed' ? '(previously failed)' : ''}`);
      if (m.errorMessage) {
        console.log(`    Error: ${m.errorMessage}`);
      }
    });
  }
  
  if (executed.length > 0) {
    console.log('\n✅ Executed migrations:');
    executed.forEach(m => {
      console.log(`  - ${m.version}: ${m.description} (${m.executedAt})`);
    });
  }
  
  console.log('');
}

// Display migration list
async function displayList() {
  const migrations = await getMigrationStatus();
  
  console.log('\n📋 Available Migrations\n');
  migrations.forEach(m => {
    const status = m.executed 
      ? (m.status === 'success' ? '✅' : '❌') 
      : '⏳';
    console.log(`${status} ${m.version.padEnd(25)} ${m.description}`);
    if (m.executedAt) {
      console.log(`   Executed: ${m.executedAt}`);
    }
    if (m.errorMessage) {
      console.log(`   Error: ${m.errorMessage}`);
    }
  });
  console.log('');
}

// Main CLI handler
async function main() {
  const command = process.argv[2];
  const arg = process.argv[3];

  try {
    // Test database connection
    await Database.testConnection();

    switch (command) {
      case 'status':
        await displayStatus();
        break;
        
      case 'list':
        await displayList();
        break;
        
      case 'run':
        if (!arg) {
          console.error('❌ Error: Please specify a migration version');
          console.error('Usage: node scripts/run-migrations.js run <version>');
          process.exit(1);
        }
        await runMigration(arg);
        break;
        
      case 'run-all':
        await runAllPendingMigrations();
        break;
        
      default:
        console.log('Database Migration CLI\n');
        console.log('Usage:');
        console.log('  node scripts/run-migrations.js status          - Show migration status');
        console.log('  node scripts/run-migrations.js list            - List all migrations');
        console.log('  node scripts/run-migrations.js run <version>   - Run a specific migration');
        console.log('  node scripts/run-migrations.js run-all         - Run all pending migrations');
        console.log('');
        console.log('Examples:');
        console.log('  node scripts/run-migrations.js run 018_add_elvanto_config');
        console.log('  node scripts/run-migrations.js run 006');
        process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = {
  runMigration,
  runAllPendingMigrations,
  getMigrationStatus,
  displayStatus,
  displayList
};

