const SchemaIntrospector = require('./schemaIntrospector');
const Database = require('../config/database');

/**
 * Migration Planner - Generates migration plans based on current vs desired schema
 * This utility analyzes the current database state and creates migration plans
 */
class MigrationPlanner {
  constructor() {
    this.introspector = new SchemaIntrospector();
  }

  /**
   * Generate a comprehensive migration plan
   */
  async generateMigrationPlan(desiredSchema) {
    try {
      console.log('🔍 Analyzing current database schema...');
      const currentSchema = await this.introspector.getFullSchema();
      
      console.log('📋 Generating migration plan...');
      const plan = {
        summary: {
          tablesToCreate: [],
          tablesToDrop: [],
          tablesToModify: [],
          columnsToAdd: [],
          columnsToModify: [],
          columnsToDrop: [],
          indexesToCreate: [],
          indexesToDrop: [],
          foreignKeysToAdd: [],
          foreignKeysToDrop: [],
          constraintsToAdd: [],
          constraintsToDrop: []
        },
        migrations: [],
        risks: [],
        estimatedTime: 0,
        rollbackPlan: null
      };

      // Analyze table differences
      await this.analyzeTableDifferences(currentSchema, desiredSchema, plan);
      
      // Analyze column differences
      await this.analyzeColumnDifferences(currentSchema, desiredSchema, plan);
      
      // Analyze index differences
      await this.analyzeIndexDifferences(currentSchema, desiredSchema, plan);
      
      // Analyze foreign key differences
      await this.analyzeForeignKeyDifferences(currentSchema, desiredSchema, plan);
      
      // Generate migration SQL
      await this.generateMigrationSQL(plan);
      
      // Assess risks
      await this.assessRisks(plan);
      
      // Generate rollback plan
      plan.rollbackPlan = await this.generateRollbackPlan(plan);
      
      // Estimate execution time
      plan.estimatedTime = this.estimateExecutionTime(plan);
      
      return plan;
    } catch (error) {
      console.error('Error generating migration plan:', error);
      throw error;
    }
  }

  /**
   * Analyze differences in tables
   */
  async analyzeTableDifferences(currentSchema, desiredSchema, plan) {
    const currentTables = new Set(currentSchema.tables.map(t => t.name));
    const desiredTables = new Set(desiredSchema.tables.map(t => t.name));

    // Tables to create
    for (const tableName of desiredTables) {
      if (!currentTables.has(tableName)) {
        plan.summary.tablesToCreate.push(tableName);
      }
    }

    // Tables to drop (be very careful with this)
    for (const tableName of currentTables) {
      if (!desiredTables.has(tableName) && !this.isSystemTable(tableName)) {
        plan.summary.tablesToDrop.push(tableName);
        plan.risks.push({
          type: 'data_loss',
          severity: 'high',
          description: `Table ${tableName} will be dropped - all data will be lost`,
          table: tableName
        });
      }
    }

    // Tables to modify
    for (const tableName of currentTables) {
      if (desiredTables.has(tableName)) {
        const currentTable = currentSchema.tables.find(t => t.name === tableName);
        const desiredTable = desiredSchema.tables.find(t => t.name === tableName);
        
        if (this.tablesDiffer(currentTable, desiredTable)) {
          plan.summary.tablesToModify.push(tableName);
        }
      }
    }
  }

  /**
   * Analyze differences in columns
   */
  async analyzeColumnDifferences(currentSchema, desiredSchema, plan) {
    const currentColumns = this.groupColumnsByTable(currentSchema.columns);
    const desiredColumns = this.groupColumnsByTable(desiredSchema.columns);

    for (const tableName of Object.keys(desiredColumns)) {
      const currentTableColumns = currentColumns[tableName] || [];
      const desiredTableColumns = desiredColumns[tableName] || [];
      
      const currentColumnNames = new Set(currentTableColumns.map(c => c.name));
      const desiredColumnNames = new Set(desiredTableColumns.map(c => c.name));

      // Columns to add
      for (const column of desiredTableColumns) {
        if (!currentColumnNames.has(column.name)) {
          plan.summary.columnsToAdd.push({
            table: tableName,
            column: column
          });
        }
      }

      // Columns to drop
      for (const column of currentTableColumns) {
        if (!desiredColumnNames.has(column.name) && !this.isSystemColumn(column.name)) {
          plan.summary.columnsToDrop.push({
            table: tableName,
            column: column
          });
          
          // Check if column has data
          const rowCount = await this.introspector.getTableRowCount(tableName);
          if (rowCount > 0) {
            plan.risks.push({
              type: 'data_loss',
              severity: 'medium',
              description: `Column ${tableName}.${column.name} will be dropped and may contain data`,
              table: tableName,
              column: column.name,
              rowCount
            });
          }
        }
      }

      // Columns to modify
      for (const currentColumn of currentTableColumns) {
        const desiredColumn = desiredTableColumns.find(c => c.name === currentColumn.name);
        if (desiredColumn && this.columnsDiffer(currentColumn, desiredColumn)) {
          plan.summary.columnsToModify.push({
            table: tableName,
            current: currentColumn,
            desired: desiredColumn
          });
        }
      }
    }
  }

  /**
   * Analyze differences in indexes
   */
  async analyzeIndexDifferences(currentSchema, desiredSchema, plan) {
    const currentIndexes = this.groupIndexesByTable(currentSchema.indexes);
    const desiredIndexes = this.groupIndexesByTable(desiredSchema.indexes);

    for (const tableName of Object.keys(desiredIndexes)) {
      const currentTableIndexes = currentIndexes[tableName] || [];
      const desiredTableIndexes = desiredIndexes[tableName] || [];
      
      const currentIndexNames = new Set(currentTableIndexes.map(i => i.name));
      const desiredIndexNames = new Set(desiredTableIndexes.map(i => i.name));

      // Indexes to create
      for (const index of desiredTableIndexes) {
        if (!currentIndexNames.has(index.name)) {
          plan.summary.indexesToCreate.push({
            table: tableName,
            index: index
          });
        }
      }

      // Indexes to drop
      for (const index of currentTableIndexes) {
        if (!desiredIndexNames.has(index.name) && !this.isSystemIndex(index.name)) {
          plan.summary.indexesToDrop.push({
            table: tableName,
            index: index
          });
        }
      }
    }
  }

  /**
   * Analyze differences in foreign keys
   */
  async analyzeForeignKeyDifferences(currentSchema, desiredSchema, plan) {
    const currentFKs = this.groupForeignKeysByTable(currentSchema.foreignKeys);
    const desiredFKs = this.groupForeignKeysByTable(desiredSchema.foreignKeys);

    for (const tableName of Object.keys(desiredFKs)) {
      const currentTableFKs = currentFKs[tableName] || [];
      const desiredTableFKs = desiredFKs[tableName] || [];
      
      const currentFKNames = new Set(currentTableFKs.map(fk => fk.name));
      const desiredFKNames = new Set(desiredTableFKs.map(fk => fk.name));

      // Foreign keys to add
      for (const fk of desiredTableFKs) {
        if (!currentFKNames.has(fk.name)) {
          plan.summary.foreignKeysToAdd.push({
            table: tableName,
            foreignKey: fk
          });
        }
      }

      // Foreign keys to drop
      for (const fk of currentTableFKs) {
        if (!desiredFKNames.has(fk.name)) {
          plan.summary.foreignKeysToDrop.push({
            table: tableName,
            foreignKey: fk
          });
        }
      }
    }
  }

  /**
   * Generate migration SQL statements
   */
  async generateMigrationSQL(plan) {
    const migrations = [];

    // Create tables
    if (plan.summary.tablesToCreate.length > 0) {
      migrations.push({
        type: 'create_tables',
        description: `Create ${plan.summary.tablesToCreate.length} new tables`,
        sql: plan.summary.tablesToCreate.map(tableName => 
          `CREATE TABLE \`${tableName}\` (/* TODO: Define table structure */)`
        ).join(';\n'),
        tables: plan.summary.tablesToCreate
      });
    }

    // Add columns
    if (plan.summary.columnsToAdd.length > 0) {
      const columnMigrations = plan.summary.columnsToAdd.map(({ table, column }) => {
        const sql = `ALTER TABLE \`${table}\` ADD COLUMN \`${column.name}\` ${this.getColumnDefinition(column)}`;
        return { table, column: column.name, sql };
      });

      migrations.push({
        type: 'add_columns',
        description: `Add ${plan.summary.columnsToAdd.length} new columns`,
        sql: columnMigrations.map(m => m.sql).join(';\n'),
        columns: columnMigrations
      });
    }

    // Modify columns
    if (plan.summary.columnsToModify.length > 0) {
      const columnMigrations = plan.summary.columnsToModify.map(({ table, current, desired }) => {
        const sql = `ALTER TABLE \`${table}\` MODIFY COLUMN \`${current.name}\` ${this.getColumnDefinition(desired)}`;
        return { table, column: current.name, sql };
      });

      migrations.push({
        type: 'modify_columns',
        description: `Modify ${plan.summary.columnsToModify.length} existing columns`,
        sql: columnMigrations.map(m => m.sql).join(';\n'),
        columns: columnMigrations
      });
    }

    // Create indexes
    if (plan.summary.indexesToCreate.length > 0) {
      const indexMigrations = plan.summary.indexesToCreate.map(({ table, index }) => {
        const sql = `CREATE INDEX \`${index.name}\` ON \`${table}\` (\`${index.columnName}\`)`;
        return { table, index: index.name, sql };
      });

      migrations.push({
        type: 'create_indexes',
        description: `Create ${plan.summary.indexesToCreate.length} new indexes`,
        sql: indexMigrations.map(m => m.sql).join(';\n'),
        indexes: indexMigrations
      });
    }

    // Add foreign keys
    if (plan.summary.foreignKeysToAdd.length > 0) {
      const fkMigrations = plan.summary.foreignKeysToAdd.map(({ table, foreignKey }) => {
        const sql = `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${foreignKey.name}\` FOREIGN KEY (\`${foreignKey.columnName}\`) REFERENCES \`${foreignKey.referencedTableName}\` (\`${foreignKey.referencedColumnName}\`)`;
        return { table, foreignKey: foreignKey.name, sql };
      });

      migrations.push({
        type: 'add_foreign_keys',
        description: `Add ${plan.summary.foreignKeysToAdd.length} new foreign key constraints`,
        sql: fkMigrations.map(m => m.sql).join(';\n'),
        foreignKeys: fkMigrations
      });
    }

    plan.migrations = migrations;
  }

  /**
   * Assess risks of the migration plan
   */
  async assessRisks(plan) {
    // Data loss risks
    if (plan.summary.tablesToDrop.length > 0) {
      plan.risks.push({
        type: 'data_loss',
        severity: 'critical',
        description: `${plan.summary.tablesToDrop.length} tables will be dropped - all data will be permanently lost`,
        tables: plan.summary.tablesToDrop
      });
    }

    // Performance risks
    if (plan.summary.indexesToDrop.length > 0) {
      plan.risks.push({
        type: 'performance',
        severity: 'medium',
        description: `${plan.summary.indexesToDrop.length} indexes will be dropped - may impact query performance`,
        indexes: plan.summary.indexesToDrop.map(i => `${i.table}.${i.index.name}`)
      });
    }

    // Constraint risks
    if (plan.summary.foreignKeysToAdd.length > 0) {
      plan.risks.push({
        type: 'constraint_violation',
        severity: 'medium',
        description: `${plan.summary.foreignKeysToAdd.length} foreign key constraints will be added - may fail if data violates constraints`,
        foreignKeys: plan.summary.foreignKeysToAdd.map(fk => `${fk.table}.${fk.foreignKey.name}`)
      });
    }

    // Downtime risks
    const totalOperations = plan.summary.tablesToCreate.length + 
                           plan.summary.columnsToAdd.length + 
                           plan.summary.indexesToCreate.length;
    
    if (totalOperations > 10) {
      plan.risks.push({
        type: 'downtime',
        severity: 'medium',
        description: `Large migration with ${totalOperations} operations - may cause temporary downtime`,
        operations: totalOperations
      });
    }
  }

  /**
   * Generate rollback plan
   */
  async generateRollbackPlan(plan) {
    const rollbackMigrations = [];

    // Reverse foreign key additions
    if (plan.summary.foreignKeysToAdd.length > 0) {
      const fkRollbacks = plan.summary.foreignKeysToAdd.map(({ table, foreignKey }) => {
        const sql = `ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${foreignKey.name}\``;
        return { table, foreignKey: foreignKey.name, sql };
      });

      rollbackMigrations.push({
        type: 'drop_foreign_keys',
        description: `Drop ${plan.summary.foreignKeysToAdd.length} foreign key constraints`,
        sql: fkRollbacks.map(m => m.sql).join(';\n'),
        foreignKeys: fkRollbacks
      });
    }

    // Reverse index creations
    if (plan.summary.indexesToCreate.length > 0) {
      const indexRollbacks = plan.summary.indexesToCreate.map(({ table, index }) => {
        const sql = `DROP INDEX \`${index.name}\` ON \`${table}\``;
        return { table, index: index.name, sql };
      });

      rollbackMigrations.push({
        type: 'drop_indexes',
        description: `Drop ${plan.summary.indexesToCreate.length} indexes`,
        sql: indexRollbacks.map(m => m.sql).join(';\n'),
        indexes: indexRollbacks
      });
    }

    // Reverse column modifications
    if (plan.summary.columnsToModify.length > 0) {
      const columnRollbacks = plan.summary.columnsToModify.map(({ table, current }) => {
        const sql = `ALTER TABLE \`${table}\` MODIFY COLUMN \`${current.name}\` ${this.getColumnDefinition(current)}`;
        return { table, column: current.name, sql };
      });

      rollbackMigrations.push({
        type: 'restore_columns',
        description: `Restore ${plan.summary.columnsToModify.length} column definitions`,
        sql: columnRollbacks.map(m => m.sql).join(';\n'),
        columns: columnRollbacks
      });
    }

    // Reverse column additions
    if (plan.summary.columnsToAdd.length > 0) {
      const columnRollbacks = plan.summary.columnsToAdd.map(({ table, column }) => {
        const sql = `ALTER TABLE \`${table}\` DROP COLUMN \`${column.name}\``;
        return { table, column: column.name, sql };
      });

      rollbackMigrations.push({
        type: 'drop_columns',
        description: `Drop ${plan.summary.columnsToAdd.length} columns`,
        sql: columnRollbacks.map(m => m.sql).join(';\n'),
        columns: columnRollbacks
      });
    }

    // Reverse table creations
    if (plan.summary.tablesToCreate.length > 0) {
      rollbackMigrations.push({
        type: 'drop_tables',
        description: `Drop ${plan.summary.tablesToCreate.length} tables`,
        sql: plan.summary.tablesToCreate.map(tableName => 
          `DROP TABLE \`${tableName}\``
        ).join(';\n'),
        tables: plan.summary.tablesToCreate
      });
    }

    return {
      migrations: rollbackMigrations,
      description: 'Rollback plan to reverse all changes',
      risks: [
        {
          type: 'data_loss',
          severity: 'high',
          description: 'Rollback will permanently delete any data added during migration'
        }
      ]
    };
  }

  /**
   * Estimate execution time
   */
  estimateExecutionTime(plan) {
    let totalTime = 0;
    
    // Base times for different operations
    const operationTimes = {
      create_table: 1000, // 1 second
      add_column: 500,    // 0.5 seconds
      modify_column: 2000, // 2 seconds (can be slow with large tables)
      create_index: 3000,  // 3 seconds (can be slow with large tables)
      add_foreign_key: 1000, // 1 second
      drop_table: 100,    // 0.1 seconds
      drop_column: 1000,  // 1 second
      drop_index: 100,    // 0.1 seconds
      drop_foreign_key: 100 // 0.1 seconds
    };

    totalTime += plan.summary.tablesToCreate.length * operationTimes.create_table;
    totalTime += plan.summary.columnsToAdd.length * operationTimes.add_column;
    totalTime += plan.summary.columnsToModify.length * operationTimes.modify_column;
    totalTime += plan.summary.indexesToCreate.length * operationTimes.create_index;
    totalTime += plan.summary.foreignKeysToAdd.length * operationTimes.add_foreign_key;

    return totalTime;
  }

  // Helper methods
  groupColumnsByTable(columns) {
    return columns.reduce((groups, column) => {
      if (!groups[column.tableName]) {
        groups[column.tableName] = [];
      }
      groups[column.tableName].push(column);
      return groups;
    }, {});
  }

  groupIndexesByTable(indexes) {
    return indexes.reduce((groups, index) => {
      if (!groups[index.tableName]) {
        groups[index.tableName] = [];
      }
      groups[index.tableName].push(index);
      return groups;
    }, {});
  }

  groupForeignKeysByTable(foreignKeys) {
    return foreignKeys.reduce((groups, fk) => {
      if (!groups[fk.tableName]) {
        groups[fk.tableName] = [];
      }
      groups[fk.tableName].push(fk);
      return groups;
    }, {});
  }

  tablesDiffer(current, desired) {
    return current.engine !== desired.engine ||
           current.collation !== desired.collation ||
           current.comment !== desired.comment;
  }

  columnsDiffer(current, desired) {
    return current.dataType !== desired.dataType ||
           current.isNullable !== desired.isNullable ||
           current.defaultValue !== desired.defaultValue ||
           current.columnType !== desired.columnType;
  }

  getColumnDefinition(column) {
    let definition = column.columnType || column.dataType;
    
    if (column.maxLength && ['varchar', 'char', 'text'].includes(column.dataType.toLowerCase())) {
      definition = `${column.dataType}(${column.maxLength})`;
    }
    
    if (column.numericPrecision && column.numericScale) {
      definition = `${column.dataType}(${column.numericPrecision},${column.numericScale})`;
    }
    
    if (column.isNullable === 'NO') {
      definition += ' NOT NULL';
    }
    
    if (column.defaultValue !== null) {
      definition += ` DEFAULT ${column.defaultValue}`;
    }
    
    if (column.extra) {
      definition += ` ${column.extra}`;
    }
    
    return definition;
  }

  isSystemTable(tableName) {
    return tableName.startsWith('information_schema') ||
           tableName.startsWith('mysql') ||
           tableName.startsWith('performance_schema') ||
           tableName === 'migrations';
  }

  isSystemColumn(columnName) {
    return columnName === 'id' || 
           columnName === 'created_at' || 
           columnName === 'updated_at';
  }

  isSystemIndex(indexName) {
    return indexName === 'PRIMARY' || 
           indexName.startsWith('idx_') ||
           indexName.includes('_fk_');
  }
}

module.exports = MigrationPlanner;
