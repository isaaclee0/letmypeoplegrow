const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// All routes require admin authentication
router.use(verifyToken);
router.use(requireRole(['admin']));

// Get migration status
router.get('/status', async (req, res) => {
  try {
    // Check if migrations table exists, create if not
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

    // Get all executed migrations
    const executedMigrations = await Database.query(
      'SELECT * FROM migrations ORDER BY version'
    );

    // Get all available migration files
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

    const pendingMigrations = availableMigrations.filter(m => !m.executed);
    const failedMigrations = availableMigrations.filter(m => m.executed && m.status === 'failed');

    res.json({
      migrations: availableMigrations,
      pendingCount: pendingMigrations.length,
      failedCount: failedMigrations.length,
      hasPending: pendingMigrations.length > 0,
      hasFailed: failedMigrations.length > 0
    });

  } catch (error) {
    console.error('Get migration status error:', error);
    res.status(500).json({ error: 'Failed to get migration status' });
  }
});

// Run a specific migration
router.post('/run/:version', async (req, res) => {
  try {
    const { version } = req.params;
    
    // Check if migration already executed
    const existing = await Database.query(
      'SELECT * FROM migrations WHERE version = ?',
      [version]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Migration already executed' });
    }

    // Read migration file
    const migrationFile = path.join(__dirname, '../migrations', `${version}.sql`);
    if (!fs.existsSync(migrationFile)) {
      return res.status(404).json({ error: 'Migration file not found' });
    }

    const sqlContent = fs.readFileSync(migrationFile, 'utf8');
    const migrationName = getMigrationDescription(version);

    // Start transaction
    await Database.query('START TRANSACTION');

    const startTime = Date.now();
    let status = 'success';
    let errorMessage = null;

    try {
      // Split and execute SQL statements
      const statements = sqlContent
        .split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

      for (const statement of statements) {
        if (statement.trim()) {
          await Database.query(statement);
        }
      }

      // Record successful migration
      await Database.query(`
        INSERT INTO migrations (version, name, description, execution_time_ms, status)
        VALUES (?, ?, ?, ?, ?)
      `, [version, `${version}.sql`, migrationName, Date.now() - startTime, status]);

      await Database.query('COMMIT');

      res.json({ 
        message: 'Migration executed successfully',
        version,
        executionTime: Date.now() - startTime
      });

    } catch (error) {
      await Database.query('ROLLBACK');
      status = 'failed';
      errorMessage = error.message;

      // Record failed migration
      await Database.query(`
        INSERT INTO migrations (version, name, description, execution_time_ms, status, error_message)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [version, `${version}.sql`, migrationName, Date.now() - startTime, status, errorMessage]);

      throw error;
    }

  } catch (error) {
    console.error('Run migration error:', error);
    res.status(500).json({ 
      error: 'Failed to execute migration',
      details: error.message 
    });
  }
});

// Run all pending migrations
router.post('/run-all', async (req, res) => {
  try {
    // Get pending migrations
    const statusResponse = await getMigrationStatus();
    const pendingMigrations = statusResponse.migrations.filter(m => !m.executed);

    if (pendingMigrations.length === 0) {
      return res.json({ message: 'No pending migrations' });
    }

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
      }
    }

    res.json({
      message: `Executed ${successCount} migrations successfully, ${failureCount} failed`,
      results,
      successCount,
      failureCount
    });

  } catch (error) {
    console.error('Run all migrations error:', error);
    res.status(500).json({ error: 'Failed to execute migrations' });
  }
});

// Helper function to get migration description
function getMigrationDescription(version) {
  const descriptions = {
    '001_fix_audit_log': 'Fix audit_log table structure - add entity_type and entity_id columns',
    '002_add_missing_indexes': 'Add missing database indexes for performance',
    // Add more descriptions as migrations are created
  };
  return descriptions[version] || `Migration ${version}`;
}

// Helper function to get migration status (duplicate of route logic for internal use)
async function getMigrationStatus() {
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

  return { migrations: availableMigrations };
}

// Helper function to run a migration (duplicate of route logic for internal use)
async function runMigration(version) {
  const migrationFile = path.join(__dirname, '../migrations', `${version}.sql`);
  const sqlContent = fs.readFileSync(migrationFile, 'utf8');
  const migrationName = getMigrationDescription(version);

  await Database.query('START TRANSACTION');

  const startTime = Date.now();
  let status = 'success';
  let errorMessage = null;

  try {
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

    for (const statement of statements) {
      if (statement.trim()) {
        await Database.query(statement);
      }
    }

    await Database.query(`
      INSERT INTO migrations (version, name, description, execution_time_ms, status)
      VALUES (?, ?, ?, ?, ?)
    `, [version, `${version}.sql`, migrationName, Date.now() - startTime, status]);

    await Database.query('COMMIT');

    return { 
      message: 'Migration executed successfully',
      executionTime: Date.now() - startTime
    };

  } catch (error) {
    await Database.query('ROLLBACK');
    status = 'failed';
    errorMessage = error.message;

    await Database.query(`
      INSERT INTO migrations (version, name, description, execution_time_ms, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [version, `${version}.sql`, migrationName, Date.now() - startTime, status, errorMessage]);

    throw error;
  }
}

module.exports = router; 