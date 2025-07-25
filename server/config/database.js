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
}

module.exports = Database; 