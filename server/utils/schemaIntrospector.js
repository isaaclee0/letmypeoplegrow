const Database = require('../config/database');

/**
 * Schema Introspector - Analyzes current database state
 * Uses SQLite PRAGMA statements and sqlite_master for schema analysis
 */
class SchemaIntrospector {
  constructor() {
  }

  /**
   * Get complete database schema information
   */
  async getFullSchema() {
    try {
      const schema = {
        tables: await this.getAllTables(),
        columns: await this.getAllColumns(),
        indexes: await this.getAllIndexes(),
        foreignKeys: await this.getAllForeignKeys(),
        constraints: await this.getAllConstraints()
      };

      return schema;
    } catch (error) {
      console.error('Error getting full schema:', error);
      throw error;
    }
  }

  /**
   * Get all tables in the database
   */
  async getAllTables() {
    const tables = await Database.query(`
      SELECT name, type, sql
      FROM sqlite_master 
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `);

    return tables.map(t => ({
      name: t.name,
      type: t.type,
      sql: t.sql
    }));
  }

  /**
   * Get all columns for all tables
   */
  async getAllColumns() {
    const tables = await this.getAllTables();
    const allColumns = [];

    for (const table of tables) {
      const columns = await Database.query(`PRAGMA table_info("${table.name}")`);
      for (const col of columns) {
        allColumns.push({
          tableName: table.name,
          name: col.name,
          position: col.cid,
          defaultValue: col.dflt_value,
          isNullable: col.notnull ? 'NO' : 'YES',
          dataType: col.type,
          columnType: col.type,
          columnKey: col.pk ? 'PRI' : ''
        });
      }
    }

    return allColumns;
  }

  /**
   * Get all indexes for all tables
   */
  async getAllIndexes() {
    const tables = await this.getAllTables();
    const allIndexes = [];

    for (const table of tables) {
      const indexes = await Database.query(`PRAGMA index_list("${table.name}")`);
      for (const idx of indexes) {
        const indexInfo = await Database.query(`PRAGMA index_info("${idx.name}")`);
        for (const col of indexInfo) {
          allIndexes.push({
            tableName: table.name,
            name: idx.name,
            nonUnique: idx.unique ? 0 : 1,
            sequence: col.seqno,
            columnName: col.name,
            indexType: idx.origin === 'pk' ? 'PRIMARY' : 'BTREE'
          });
        }
      }
    }

    return allIndexes;
  }

  /**
   * Get all foreign key constraints
   */
  async getAllForeignKeys() {
    const tables = await this.getAllTables();
    const allForeignKeys = [];

    for (const table of tables) {
      const fks = await Database.query(`PRAGMA foreign_key_list("${table.name}")`);
      for (const fk of fks) {
        allForeignKeys.push({
          name: `fk_${table.name}_${fk.from}`,
          tableName: table.name,
          columnName: fk.from,
          referencedTableName: fk.table,
          referencedColumnName: fk.to
        });
      }
    }

    return allForeignKeys;
  }

  /**
   * Get all constraints (PRIMARY KEY, UNIQUE)
   */
  async getAllConstraints() {
    const tables = await this.getAllTables();
    const allConstraints = [];

    for (const table of tables) {
      const columns = await Database.query(`PRAGMA table_info("${table.name}")`);
      const pkColumns = columns.filter(c => c.pk > 0);
      if (pkColumns.length > 0) {
        allConstraints.push({
          name: 'PRIMARY',
          tableName: table.name,
          type: 'PRIMARY KEY'
        });
      }

      const indexes = await Database.query(`PRAGMA index_list("${table.name}")`);
      for (const idx of indexes) {
        if (idx.unique) {
          allConstraints.push({
            name: idx.name,
            tableName: table.name,
            type: 'UNIQUE'
          });
        }
      }
    }

    return allConstraints;
  }

  /**
   * Get all triggers
   */
  async getAllTriggers() {
    const triggers = await Database.query(`
      SELECT name, sql FROM sqlite_master 
      WHERE type = 'trigger'
      ORDER BY name
    `);

    return triggers.map(t => ({
      name: t.name,
      sql: t.sql
    }));
  }

  /**
   * Get all views
   */
  async getAllViews() {
    const views = await Database.query(`
      SELECT name, sql FROM sqlite_master 
      WHERE type = 'view'
      ORDER BY name
    `);

    return views.map(v => ({
      name: v.name,
      definition: v.sql
    }));
  }

  /**
   * Get all functions — SQLite has no stored functions
   */
  async getAllFunctions() {
    return [];
  }

  /**
   * Get all stored procedures — SQLite has no stored procedures
   */
  async getAllProcedures() {
    return [];
  }

  /**
   * Get schema for a specific table
   */
  async getTableSchema(tableName) {
    const tableInfo = await Database.query(`
      SELECT name, type, sql FROM sqlite_master 
      WHERE type = 'table' AND name = ?
    `, [tableName]);

    if (tableInfo.length === 0) {
      return null;
    }

    const columns = await Database.query(`PRAGMA table_info("${tableName}")`);
    const mappedColumns = columns.map(col => ({
      name: col.name,
      position: col.cid,
      defaultValue: col.dflt_value,
      isNullable: col.notnull ? 'NO' : 'YES',
      dataType: col.type,
      columnType: col.type,
      columnKey: col.pk ? 'PRI' : ''
    }));

    const indexList = await Database.query(`PRAGMA index_list("${tableName}")`);
    const indexes = [];
    for (const idx of indexList) {
      const indexInfo = await Database.query(`PRAGMA index_info("${idx.name}")`);
      for (const col of indexInfo) {
        indexes.push({
          name: idx.name,
          nonUnique: idx.unique ? 0 : 1,
          sequence: col.seqno,
          columnName: col.name,
          indexType: idx.origin === 'pk' ? 'PRIMARY' : 'BTREE'
        });
      }
    }

    const fkList = await Database.query(`PRAGMA foreign_key_list("${tableName}")`);
    const foreignKeys = fkList.map(fk => ({
      name: `fk_${tableName}_${fk.from}`,
      columnName: fk.from,
      referencedTableName: fk.table,
      referencedColumnName: fk.to
    }));

    return {
      table: { name: tableInfo[0].name, type: tableInfo[0].type, sql: tableInfo[0].sql },
      columns: mappedColumns,
      indexes,
      foreignKeys
    };
  }

  /**
   * Check if a table exists
   */
  async tableExists(tableName) {
    const result = await Database.query(`
      SELECT COUNT(*) as count FROM sqlite_master 
      WHERE type = 'table' AND name = ?
    `, [tableName]);
    
    return result[0].count > 0;
  }

  /**
   * Check if a column exists in a table
   */
  async columnExists(tableName, columnName) {
    const columns = await Database.query(`PRAGMA table_info("${tableName}")`);
    return columns.some(col => col.name === columnName);
  }

  /**
   * Check if an index exists
   */
  async indexExists(tableName, indexName) {
    const indexes = await Database.query(`PRAGMA index_list("${tableName}")`);
    return indexes.some(idx => idx.name === indexName);
  }

  /**
   * Get table row count
   */
  async getTableRowCount(tableName) {
    const result = await Database.query(`SELECT COUNT(*) as count FROM "${tableName}"`);
    return result[0].count;
  }

  /**
   * Get the CREATE TABLE statement for a table
   */
  async getCreateTableStatement(tableName) {
    const result = await Database.query(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
    `, [tableName]);
    return result.length > 0 ? result[0].sql : null;
  }

  /**
   * Get database size information
   */
  async getDatabaseSize() {
    const pageCount = await Database.query('PRAGMA page_count');
    const pageSize = await Database.query('PRAGMA page_size');
    const count = pageCount[0]?.page_count || 0;
    const size = pageSize[0]?.page_size || 0;
    const totalSize = count * size;
    const tables = await this.getAllTables();

    return {
      totalSize,
      dataSize: totalSize,
      indexSize: 0,
      tableCount: tables.length
    };
  }
}

module.exports = SchemaIntrospector;
