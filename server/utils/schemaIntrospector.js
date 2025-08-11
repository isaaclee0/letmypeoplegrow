const Database = require('../config/database');

/**
 * Schema Introspector - Analyzes current database state
 * This utility provides comprehensive database schema analysis capabilities
 */
class SchemaIntrospector {
  constructor() {
    this.dbName = process.env.DB_NAME || 'church_attendance';
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
      SELECT 
        TABLE_NAME as name,
        TABLE_TYPE as type,
        ENGINE as engine,
        TABLE_ROWS as tableRows,
        AVG_ROW_LENGTH as avgRowLength,
        DATA_LENGTH as dataLength,
        MAX_DATA_LENGTH as maxDataLength,
        INDEX_LENGTH as indexLength,
        DATA_FREE as dataFree,
        AUTO_INCREMENT as autoIncrement,
        CREATE_TIME as createTime,
        UPDATE_TIME as updateTime,
        CHECK_TIME as checkTime,
        TABLE_COLLATION as collation,
        CHECKSUM as checksum,
        CREATE_OPTIONS as createOptions,
        TABLE_COMMENT as comment
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [this.dbName]);

    return tables;
  }

  /**
   * Get all columns for all tables
   */
  async getAllColumns() {
    const columns = await Database.query(`
      SELECT 
        TABLE_NAME as tableName,
        COLUMN_NAME as name,
        ORDINAL_POSITION as position,
        COLUMN_DEFAULT as defaultValue,
        IS_NULLABLE as isNullable,
        DATA_TYPE as dataType,
        CHARACTER_MAXIMUM_LENGTH as maxLength,
        NUMERIC_PRECISION as numericPrecision,
        NUMERIC_SCALE as numericScale,
        DATETIME_PRECISION as datetimePrecision,
        CHARACTER_SET_NAME as characterSet,
        COLLATION_NAME as columnCollation,
        COLUMN_TYPE as columnType,
        COLUMN_KEY as columnKey,
        EXTRA as extra,
        PRIVILEGES as privileges,
        COLUMN_COMMENT as comment,
        IS_GENERATED as isGenerated,
        GENERATION_EXPRESSION as generationExpression
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `, [this.dbName]);

    return columns;
  }

  /**
   * Get all indexes for all tables
   */
  async getAllIndexes() {
    const indexes = await Database.query(`
      SELECT 
        TABLE_NAME as tableName,
        INDEX_NAME as name,
        NON_UNIQUE as nonUnique,
        SEQ_IN_INDEX as sequence,
        COLUMN_NAME as columnName,
        COLLATION as collation,
        CARDINALITY as cardinality,
        SUB_PART as subPart,
        PACKED as packed,
        NULLABLE as nullable,
        INDEX_TYPE as indexType,
        COMMENT as comment,
        INDEX_COMMENT as indexComment
      FROM INFORMATION_SCHEMA.STATISTICS 
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
    `, [this.dbName]);

    return indexes;
  }

  /**
   * Get all foreign key constraints
   */
  async getAllForeignKeys() {
    const foreignKeys = await Database.query(`
      SELECT 
        CONSTRAINT_NAME as name,
        TABLE_NAME as tableName,
        COLUMN_NAME as columnName,
        REFERENCED_TABLE_NAME as referencedTableName,
        REFERENCED_COLUMN_NAME as referencedColumnName
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
      WHERE TABLE_SCHEMA = ? 
      AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, CONSTRAINT_NAME
    `, [this.dbName]);

    return foreignKeys;
  }

  /**
   * Get all constraints (CHECK, UNIQUE, etc.)
   */
  async getAllConstraints() {
    const constraints = await Database.query(`
      SELECT 
        CONSTRAINT_NAME as name,
        TABLE_NAME as tableName,
        CONSTRAINT_TYPE as type
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS 
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, CONSTRAINT_NAME
    `, [this.dbName]);

    return constraints;
  }

  /**
   * Get all triggers
   */
  async getAllTriggers() {
    const triggers = await Database.query(`
      SELECT 
        TRIGGER_NAME as name,
        EVENT_MANIPULATION as eventManipulation,
        EVENT_OBJECT_TABLE as eventObjectTable,
        ACTION_ORDER as actionOrder,
        ACTION_CONDITION as actionCondition,
        ACTION_STATEMENT as actionStatement,
        ACTION_ORIENTATION as actionOrientation,
        ACTION_TIMING as actionTiming,
        ACTION_REFERENCE_OLD_TABLE as actionReferenceOldTable,
        ACTION_REFERENCE_NEW_TABLE as actionReferenceNewTable,
        ACTION_REFERENCE_OLD_ROW as actionReferenceOldRow,
        ACTION_REFERENCE_NEW_ROW as actionReferenceNewRow,
        CREATED as created,
        SQL_MODE as sqlMode,
        DEFINER as definer,
        CHARACTER_SET_CLIENT as characterSetClient,
        COLLATION_CONNECTION as collationConnection,
        DATABASE_COLLATION as databaseCollation
      FROM INFORMATION_SCHEMA.TRIGGERS 
      WHERE TRIGGER_SCHEMA = ?
      ORDER BY EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
    `, [this.dbName]);

    return triggers;
  }

  /**
   * Get all views
   */
  async getAllViews() {
    const views = await Database.query(`
      SELECT 
        TABLE_NAME as name,
        VIEW_DEFINITION as definition,
        CHECK_OPTION as checkOption,
        IS_UPDATABLE as isUpdatable,
        DEFINER as definer,
        SECURITY_TYPE as securityType,
        CHARACTER_SET_CLIENT as characterSetClient,
        COLLATION_CONNECTION as collationConnection
      FROM INFORMATION_SCHEMA.VIEWS 
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME
    `, [this.dbName]);

    return views;
  }

  /**
   * Get all functions
   */
  async getAllFunctions() {
    const functions = await Database.query(`
      SELECT 
        ROUTINE_NAME as name,
        ROUTINE_TYPE as type,
        DATA_TYPE as dataType,
        ROUTINE_DEFINITION as definition,
        IS_DETERMINISTIC as isDeterministic,
        SQL_DATA_ACCESS as sqlDataAccess,
        SECURITY_TYPE as securityType,
        CREATED as created,
        LAST_ALTERED as lastAltered,
        SQL_MODE as sqlMode,
        ROUTINE_COMMENT as comment,
        DEFINER as definer,
        CHARACTER_SET_CLIENT as characterSetClient,
        COLLATION_CONNECTION as collationConnection,
        DATABASE_COLLATION as databaseCollation
      FROM INFORMATION_SCHEMA.ROUTINES 
      WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION'
      ORDER BY ROUTINE_NAME
    `, [this.dbName]);

    return functions;
  }

  /**
   * Get all stored procedures
   */
  async getAllProcedures() {
    const procedures = await Database.query(`
      SELECT 
        ROUTINE_NAME as name,
        ROUTINE_TYPE as type,
        DATA_TYPE as dataType,
        ROUTINE_DEFINITION as definition,
        IS_DETERMINISTIC as isDeterministic,
        SQL_DATA_ACCESS as sqlDataAccess,
        SECURITY_TYPE as securityType,
        CREATED as created,
        LAST_ALTERED as lastAltered,
        SQL_MODE as sqlMode,
        ROUTINE_COMMENT as comment,
        DEFINER as definer,
        CHARACTER_SET_CLIENT as characterSetClient,
        COLLATION_CONNECTION as collationConnection,
        DATABASE_COLLATION as databaseCollation
      FROM INFORMATION_SCHEMA.ROUTINES 
      WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'
      ORDER BY ROUTINE_NAME
    `, [this.dbName]);

    return procedures;
  }

  /**
   * Get schema for a specific table
   */
  async getTableSchema(tableName) {
    const tableInfo = await Database.query(`
      SELECT 
        TABLE_NAME as name,
        TABLE_TYPE as type,
        ENGINE as engine,
        TABLE_ROWS as tableRows,
        AVG_ROW_LENGTH as avgRowLength,
        DATA_LENGTH as dataLength,
        MAX_DATA_LENGTH as maxDataLength,
        INDEX_LENGTH as indexLength,
        DATA_FREE as dataFree,
        AUTO_INCREMENT as autoIncrement,
        CREATE_TIME as createTime,
        UPDATE_TIME as updateTime,
        CHECK_TIME as checkTime,
        TABLE_COLLATION as collation,
        CHECKSUM as checksum,
        CREATE_OPTIONS as createOptions,
        TABLE_COMMENT as comment
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [this.dbName, tableName]);

    if (tableInfo.length === 0) {
      return null;
    }

    const columns = await Database.query(`
      SELECT 
        COLUMN_NAME as name,
        ORDINAL_POSITION as position,
        COLUMN_DEFAULT as defaultValue,
        IS_NULLABLE as isNullable,
        DATA_TYPE as dataType,
        CHARACTER_MAXIMUM_LENGTH as maxLength,
        NUMERIC_PRECISION as numericPrecision,
        NUMERIC_SCALE as numericScale,
        DATETIME_PRECISION as datetimePrecision,
        CHARACTER_SET_NAME as characterSet,
        COLLATION_NAME as columnCollation,
        COLUMN_TYPE as columnType,
        COLUMN_KEY as columnKey,
        EXTRA as extra,
        PRIVILEGES as privileges,
        COLUMN_COMMENT as comment,
        IS_GENERATED as isGenerated,
        GENERATION_EXPRESSION as generationExpression
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [this.dbName, tableName]);

    const indexes = await Database.query(`
      SELECT 
        INDEX_NAME as name,
        NON_UNIQUE as nonUnique,
        SEQ_IN_INDEX as sequence,
        COLUMN_NAME as columnName,
        COLLATION as collation,
        CARDINALITY as cardinality,
        SUB_PART as subPart,
        PACKED as packed,
        NULLABLE as nullable,
        INDEX_TYPE as indexType,
        COMMENT as comment,
        INDEX_COMMENT as indexComment
      FROM INFORMATION_SCHEMA.STATISTICS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `, [this.dbName, tableName]);

    const foreignKeys = await Database.query(`
      SELECT 
        CONSTRAINT_NAME as name,
        COLUMN_NAME as columnName,
        REFERENCED_TABLE_NAME as referencedTableName,
        REFERENCED_COLUMN_NAME as referencedColumnName
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY CONSTRAINT_NAME
    `, [this.dbName, tableName]);

    return {
      table: tableInfo[0],
      columns,
      indexes,
      foreignKeys
    };
  }

  /**
   * Check if a table exists
   */
  async tableExists(tableName) {
    const result = await Database.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [this.dbName, tableName]);
    
    return result[0].count > 0;
  }

  /**
   * Check if a column exists in a table
   */
  async columnExists(tableName, columnName) {
    const result = await Database.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
    `, [this.dbName, tableName, columnName]);
    
    return result[0].count > 0;
  }

  /**
   * Check if an index exists
   */
  async indexExists(tableName, indexName) {
    const result = await Database.query(`
      SELECT COUNT(*) as count 
      FROM INFORMATION_SCHEMA.STATISTICS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
    `, [this.dbName, tableName, indexName]);
    
    return result[0].count > 0;
  }

  /**
   * Get table row count
   */
  async getTableRowCount(tableName) {
    const result = await Database.query(`SELECT COUNT(*) as count FROM \`${tableName}\``);
    return result[0].count;
  }

  /**
   * Generate CREATE TABLE statement for a table
   */
  async getCreateTableStatement(tableName) {
    const result = await Database.query(`SHOW CREATE TABLE \`${tableName}\``);
    return result[0]['Create Table'];
  }

  /**
   * Get database size information
   */
  async getDatabaseSize() {
    const result = await Database.query(`
      SELECT 
        SUM(DATA_LENGTH + INDEX_LENGTH) as totalSize,
        SUM(DATA_LENGTH) as dataSize,
        SUM(INDEX_LENGTH) as indexSize,
        COUNT(*) as tableCount
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ?
    `, [this.dbName]);

    return result[0];
  }
}

module.exports = SchemaIntrospector;
