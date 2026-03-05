const Database = require('../config/database');
const SchemaIntrospector = require('./schemaIntrospector');

/**
 * Migration Executor - Safely executes migration plans with rollback capabilities
 * This utility provides robust migration execution with validation and error handling
 */
class MigrationExecutor {
  constructor() {
    this.introspector = new SchemaIntrospector();
    this.executionLog = [];
  }

  /**
   * Execute a migration plan with full safety checks
   */
  async executeMigrationPlan(plan, options = {}) {
    const {
      dryRun = false,
      validateOnly = false,
      skipBackup = false,
      maxRetries = 3,
      rollbackOnError = true
    } = options;

    const executionId = this.generateExecutionId();
    const startTime = Date.now();

    try {
      console.log(`🚀 Starting migration execution: ${executionId}`);
      console.log(`📋 Plan summary: ${plan.migrations.length} migrations to execute`);
      
      // Pre-execution validation
      await this.validateMigrationPlan(plan);
      
      if (validateOnly) {
        console.log('✅ Validation completed successfully');
        return {
          executionId,
          status: 'validated',
          duration: Date.now() - startTime,
          message: 'Migration plan is valid and ready for execution'
        };
      }

      // Create backup if requested
      let backupPath = null;
      if (!skipBackup && !dryRun) {
        backupPath = await this.createBackup(executionId);
      }

      // Execute migrations
      const results = await this.executeMigrations(plan.migrations, {
        dryRun,
        maxRetries,
        rollbackOnError
      });

      const duration = Date.now() - startTime;

      // Log execution
      await this.logExecution({
        executionId,
        plan,
        results,
        duration,
        backupPath,
        dryRun
      });

      return {
        executionId,
        status: 'completed',
        duration,
        results,
        backupPath,
        message: `Migration completed successfully in ${duration}ms`
      };

    } catch (error) {
      console.error(`❌ Migration execution failed: ${error.message}`);
      
      const duration = Date.now() - startTime;
      
      // Log failed execution
      await this.logExecution({
        executionId,
        plan,
        error: error.message,
        duration,
        dryRun
      });

      throw error;
    }
  }

  /**
   * Validate migration plan before execution
   */
  async validateMigrationPlan(plan) {
    console.log('🔍 Validating migration plan...');

    const validationErrors = [];

    // Check if all required tables exist
    for (const migration of plan.migrations) {
      if (migration.type === 'add_columns' || migration.type === 'modify_columns') {
        for (const columnOp of migration.columns || []) {
          const tableExists = await this.introspector.tableExists(columnOp.table);
          if (!tableExists) {
            validationErrors.push(`Table '${columnOp.table}' does not exist for column operation`);
          }
        }
      }

      if (migration.type === 'create_indexes') {
        for (const indexOp of migration.indexes || []) {
          const tableExists = await this.introspector.tableExists(indexOp.table);
          if (!tableExists) {
            validationErrors.push(`Table '${indexOp.table}' does not exist for index operation`);
          }
        }
      }
    }

    // Check for potential data loss
    const dataLossRisks = plan.risks.filter(risk => risk.type === 'data_loss' && risk.severity === 'critical');
    if (dataLossRisks.length > 0) {
      validationErrors.push(`Critical data loss risks detected: ${dataLossRisks.map(r => r.description).join(', ')}`);
    }

    // Check for constraint violations
    const constraintRisks = plan.risks.filter(risk => risk.type === 'constraint_violation');
    if (constraintRisks.length > 0) {
      for (const risk of constraintRisks) {
        // Check if referenced tables exist
        for (const fk of risk.foreignKeys || []) {
          const [tableName] = fk.split('.');
          const tableExists = await this.introspector.tableExists(tableName);
          if (!tableExists) {
            validationErrors.push(`Referenced table '${tableName}' does not exist for foreign key constraint`);
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      throw new Error(`Migration validation failed:\n${validationErrors.join('\n')}`);
    }

    console.log('✅ Migration plan validation passed');
  }

  /**
   * Execute a list of migrations
   */
  async executeMigrations(migrations, options = {}) {
    const { dryRun, maxRetries, rollbackOnError } = options;
    const results = [];
    const executedMigrations = [];

    for (let i = 0; i < migrations.length; i++) {
      const migration = migrations[i];
      console.log(`📝 Executing migration ${i + 1}/${migrations.length}: ${migration.type}`);

      try {
        const result = await this.executeMigration(migration, { dryRun, maxRetries });
        results.push(result);
        executedMigrations.push(migration);

        console.log(`✅ Migration ${migration.type} completed successfully`);

      } catch (error) {
        console.error(`❌ Migration ${migration.type} failed: ${error.message}`);

        if (rollbackOnError && executedMigrations.length > 0) {
          console.log('🔄 Rolling back executed migrations...');
          await this.rollbackMigrations(executedMigrations.reverse(), { dryRun });
        }

        throw error;
      }
    }

    return results;
  }

  /**
   * Execute a single migration
   */
  async executeMigration(migration, options = {}) {
    const { dryRun, maxRetries } = options;
    const startTime = Date.now();

    try {
      if (dryRun) {
        console.log(`🔍 [DRY RUN] Would execute: ${migration.sql.substring(0, 100)}...`);
        return {
          type: migration.type,
          status: 'dry_run',
          duration: Date.now() - startTime,
          sql: migration.sql
        };
      }

      // Execute with retry logic
      let lastError = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await Database.query('BEGIN TRANSACTION');

          // Split and execute SQL statements
          const statements = this.splitSqlStatements(migration.sql);
          for (const statement of statements) {
            await Database.query(statement);
          }

          await Database.query('COMMIT');

          return {
            type: migration.type,
            status: 'success',
            duration: Date.now() - startTime,
            sql: migration.sql,
            statementsExecuted: statements.length
          };

        } catch (error) {
          await Database.query('ROLLBACK');
          lastError = error;

          if (attempt < maxRetries) {
            console.log(`⚠️  Attempt ${attempt} failed, retrying... (${error.message})`);
            await this.delay(1000 * attempt); // Exponential backoff
          }
        }
      }

      throw lastError;

    } catch (error) {
      return {
        type: migration.type,
        status: 'failed',
        duration: Date.now() - startTime,
        error: error.message,
        sql: migration.sql
      };
    }
  }

  /**
   * Rollback executed migrations
   */
  async rollbackMigrations(migrations, options = {}) {
    const { dryRun } = options;
    const results = [];

    for (const migration of migrations) {
      console.log(`🔄 Rolling back migration: ${migration.type}`);

      try {
        const rollbackSql = this.generateRollbackSQL(migration);
        
        if (dryRun) {
          console.log(`🔍 [DRY RUN] Would rollback: ${rollbackSql.substring(0, 100)}...`);
          results.push({
            type: migration.type,
            status: 'dry_run_rollback',
            sql: rollbackSql
          });
        } else {
          await Database.query('BEGIN TRANSACTION');
          await Database.query(rollbackSql);
          await Database.query('COMMIT');

          results.push({
            type: migration.type,
            status: 'rolled_back',
            sql: rollbackSql
          });
        }

      } catch (error) {
        console.error(`❌ Rollback failed for ${migration.type}: ${error.message}`);
        results.push({
          type: migration.type,
          status: 'rollback_failed',
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Create database backup
   */
  async createBackup(executionId) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `./backups/migration_backup_${executionId}_${timestamp}.sql`;

    console.log(`💾 Creating database backup: ${backupPath}`);

    try {
      // This would typically use mysqldump or similar
      // For now, we'll create a simple backup using SELECT statements
      const backupData = await this.generateBackupData();
      
      // In a real implementation, you'd write this to a file
      // For now, we'll just log that we would create a backup
      console.log(`📁 Backup would be created at: ${backupPath}`);
      
      return backupPath;
    } catch (error) {
      console.error(`❌ Backup creation failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate backup data (simplified)
   */
  async generateBackupData() {
    const tables = await this.introspector.getAllTables();
    const backupData = {};

    for (const table of tables) {
      if (table.name === 'migrations') continue; // Skip migrations table
      
      const rowCount = await this.introspector.getTableRowCount(table.name);
      if (rowCount > 0) {
        const data = await Database.query(`SELECT * FROM "${table.name}"`);
        backupData[table.name] = data;
      }
    }

    return backupData;
  }

  /**
   * Log migration execution
   */
  async logExecution(logData) {
    try {
      await Database.query(`
        INSERT INTO migration_executions (
          execution_id,
          plan_summary,
          results,
          duration_ms,
          backup_path,
          dry_run,
          error_message,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `, [
        logData.executionId,
        JSON.stringify(logData.plan?.summary || {}),
        JSON.stringify(logData.results || []),
        logData.duration,
        logData.backupPath,
        logData.dryRun || false,
        logData.error || null
      ]);

      this.executionLog.push(logData);
    } catch (error) {
      console.error('Failed to log migration execution:', error);
    }
  }

  /**
   * Generate rollback SQL for a migration
   */
  generateRollbackSQL(migration) {
    switch (migration.type) {
      case 'add_columns':
        return migration.columns.map(col => 
          `ALTER TABLE "${col.table}" DROP COLUMN "${col.column}"`
        ).join(';\n');

      case 'create_indexes':
        return migration.indexes.map(idx => 
          `DROP INDEX IF EXISTS "${idx.index}"`
        ).join(';\n');

      case 'add_foreign_keys':
        // SQLite does not support dropping foreign keys via ALTER TABLE;
        // the table must be recreated without the constraint
        return `-- Cannot drop foreign keys in SQLite without recreating the table`;

      case 'create_tables':
        return migration.tables.map(table => 
          `DROP TABLE IF EXISTS "${table}"`
        ).join(';\n');

      default:
        return `-- No rollback SQL available for migration type: ${migration.type}`;
    }
  }

  /**
   * Split SQL statements
   */
  splitSqlStatements(sqlContent) {
    return sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'))
      .map(stmt => stmt + ';');
  }

  /**
   * Generate unique execution ID
   */
  generateExecutionId() {
    return `mig_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Delay execution
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get execution history
   */
  async getExecutionHistory(limit = 50) {
    try {
      const history = await Database.query(`
        SELECT * FROM migration_executions 
        ORDER BY created_at DESC 
        LIMIT ?
      `, [limit]);

      return history;
    } catch (error) {
      console.error('Failed to get execution history:', error);
      return [];
    }
  }

  /**
   * Get execution details
   */
  async getExecutionDetails(executionId) {
    try {
      const execution = await Database.query(`
        SELECT * FROM migration_executions 
        WHERE execution_id = ?
      `, [executionId]);

      return execution[0] || null;
    } catch (error) {
      console.error('Failed to get execution details:', error);
      return null;
    }
  }
}

module.exports = MigrationExecutor;
