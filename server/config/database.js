const mariadb = require('mariadb');

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'church_attendance',
  acquireTimeout: 60000,
  timeout: 60000,
  connectionLimit: 10,
  // Ensure JSON fields are returned as strings, not parsed objects
  // Convert BigInt to Number to avoid JSON serialization issues
  typeCast: function (field, next) {
    if (field.type === 'JSON') {
      return field.string();
    }
    if (field.type === 'BIGINT') {
      return Number(field.string());
    }
    return next();
  }
};

// Create connection pool
const pool = mariadb.createPool(dbConfig);

// Database utility functions
class Database {
  static async query(sql, params = []) {
    let conn;
    try {
      conn = await pool.getConnection();
      const result = await conn.query(sql, params);
      return result;
    } catch (err) {
      console.error('Database query error:', err);
      throw err;
    } finally {
      if (conn) conn.release();
    }
  }

  static async transaction(callback) {
    let conn;
    try {
      conn = await pool.getConnection();
      await conn.beginTransaction();
      
      const result = await callback(conn);
      
      await conn.commit();
      return result;
    } catch (err) {
      if (conn) await conn.rollback();
      console.error('Database transaction error:', err);
      throw err;
    } finally {
      if (conn) conn.release();
    }
  }

  static async testConnection() {
    try {
      const conn = await pool.getConnection();
      console.log('✅ Database connected successfully');
      conn.release();
      return true;
    } catch (err) {
      console.error('❌ Database connection failed:', err.message);
      return false;
    }
  }

  /**
   * Execute multiple SQL statements on a single connection
   * This preserves session variables (@sql, @column_exists, etc.) between statements
   * @param {string} sqlContent - SQL content with multiple statements separated by semicolons
   * @returns {Promise<Object>} - Result with success status and statement count
   */
  static async executeMultipleStatements(sqlContent) {
    let conn;
    try {
      conn = await pool.getConnection();
      
      // Split SQL into statements
      const statements = sqlContent
        .split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'))
        .map(stmt => stmt + ';');
      
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i];
        await conn.query(statement);
      }
      
      return { success: true, statementsExecuted: statements.length };
    } catch (err) {
      console.error('Database executeMultipleStatements error:', err);
      throw err;
    } finally {
      if (conn) conn.release();
    }
  }
}

module.exports = Database; 