require('dotenv').config();
const mariadb = require('mariadb');

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'church_attendance',
  acquireTimeout: 60000,
  timeout: 60000,
  connectionLimit: 10
};

console.log('Database config:', {
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  database: dbConfig.database,
  password: dbConfig.password ? '[HIDDEN]' : '[EMPTY]'
});

async function testConnection() {
  let conn;
  try {
    const pool = mariadb.createPool(dbConfig);
    conn = await pool.getConnection();
    console.log('✅ Database connected successfully');
    
    const result = await conn.query('SHOW TABLES');
    console.log('Tables found:', result.length);
    
    conn.release();
    await pool.end();
    return true;
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('Full error:', err);
    return false;
  }
}

testConnection(); 