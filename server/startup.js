const Database = require('./config/database');

async function initializeDatabase() {
  try {
    console.log('🔍 Checking database schema...');
    
    // Check if all required tables exist
    const requiredTables = [
      'users',
      'otc_codes', 
      'church_settings',
      'gathering_types',
      'user_gathering_assignments',
      'families',
      'individuals',
      'gathering_lists',
      'attendance_sessions',
      'attendance_records',
      'visitors',
      'user_invitations',
      'notification_rules',
      'notifications',
      'audit_log'
    ];

    const existingTables = await Database.query('SHOW TABLES');
    const existingTableNames = existingTables.map(row => Object.values(row)[0]);

    const missingTables = requiredTables.filter(table => !existingTableNames.includes(table));

    if (missingTables.length > 0) {
      console.log(`⚠️  Missing tables: ${missingTables.join(', ')}`);
      console.log('🗄️  Initializing database schema...');
      
      // Run the database initialization script directly
      const { createTables } = require('./scripts/initDatabase');
      
      try {
        await createTables();
        console.log('✅ Database schema initialized successfully!');
      } catch (error) {
        console.error('❌ Failed to initialize database schema:', error.message);
        throw error;
      }
    } else {
      console.log('✅ All required tables exist');
    }

    // Check if we have at least one admin user
    const adminUsers = await Database.query('SELECT id FROM users WHERE role = "admin" AND is_active = true');
    
    if (adminUsers.length === 0) {
      console.log('⚠️  No admin users found, creating default admin...');
      await Database.query(`
        INSERT INTO users (email, role, first_name, last_name, is_active, first_login_completed) 
        VALUES ('admin@church.local', 'admin', 'System', 'Administrator', true, true)
      `);
      console.log('✅ Default admin user created');
    }

    console.log('🎉 Database initialization check completed!');
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

module.exports = { initializeDatabase }; 