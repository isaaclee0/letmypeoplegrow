const Database = require('./config/database');
const app = require('./index');

async function runMigrations() {
  try {
    console.log('🔄 Checking for pending migrations...');
    
    // Get all migration files
    const migrationFiles = [
  { version: '001', name: 'fix_audit_log', description: 'Fix audit log table structure' },
  { version: '002', name: 'add_contact_fields', description: 'Add contact method fields to users' },
  { version: '003', name: 'enhance_visitors_table', description: 'Enhance visitors table with additional fields' },
  { version: '004', name: 'fix_attendance_duplicates', description: 'Fix duplicate attendance records' },
  { version: '005', name: 'add_attendance_updated_at', description: 'Add updated_at field to attendance records' },
  { version: '006', name: 'fix_attendance_sessions_unique_constraint', description: 'Fix attendance sessions unique constraint to include church_id' },
  { version: '007', name: 'add_visitor_config', description: 'Add visitor filtering configuration table' }
];

    // Check which migrations have been run
    const executedMigrations = await Database.query('SELECT version FROM migrations WHERE status = "success"');
    const executedVersions = executedMigrations.map(row => row.version);

    const pendingMigrations = migrationFiles.filter(migration => !executedVersions.includes(migration.version));

    if (pendingMigrations.length === 0) {
      console.log('✅ All migrations are up to date');
      return;
    }

    console.log(`🔄 Running ${pendingMigrations.length} pending migrations...`);

    for (const migration of pendingMigrations) {
      console.log(`📝 Running migration: ${migration.name} (${migration.version})`);
      
      const startTime = Date.now();
      
      try {
        // Mark migration as successful (since schema is already created in init.sql)
        await Database.query(`
          INSERT INTO migrations (version, name, description, execution_time_ms, status, executed_at) 
          VALUES (?, ?, ?, ?, 'success', NOW())
        `, [migration.version, migration.name, migration.description, Date.now() - startTime]);
        
        console.log(`✅ Migration ${migration.name} completed`);
      } catch (error) {
        console.error(`❌ Migration ${migration.name} failed:`, error);
        throw error;
      }
    }
    
    console.log('🎉 All migrations completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration process failed:', error);
    throw error;
  }
}

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
      'audit_log',
      'migrations'
    ];

    const existingTables = await Database.query('SHOW TABLES');
    const existingTableNames = existingTables.map(row => Object.values(row)[0]);

    const missingTables = requiredTables.filter(table => !existingTableNames.includes(table));

    if (missingTables.length > 0) {
      console.log(`⚠️  Missing tables: ${missingTables.join(', ')}`);
      console.log('🗄️  Database schema will be initialized by Docker init script');
    } else {
      console.log('✅ All required tables exist');
    }

    // Ensure optional columns exist
    try {
      const userColumns = await Database.query("SHOW COLUMNS FROM users LIKE 'last_login_at'");
      if (userColumns.length === 0) {
        console.log('🛠️  Adding users.last_login_at column');
        await Database.query('ALTER TABLE users ADD COLUMN last_login_at DATETIME NULL AFTER updated_at');
        console.log('✅ users.last_login_at added');
      }
    } catch (e) {
      console.warn('⚠️  Could not ensure users.last_login_at column:', e.message);
    }

    // Ensure location columns exist in church_settings
    try {
      const locNameCol = await Database.query("SHOW COLUMNS FROM church_settings LIKE 'location_name'");
      if (locNameCol.length === 0) {
        console.log('🛠️  Adding church_settings location columns');
        await Database.query('ALTER TABLE church_settings ADD COLUMN location_name VARCHAR(255) NULL');
        await Database.query('ALTER TABLE church_settings ADD COLUMN location_lat DECIMAL(10,7) NULL');
        await Database.query('ALTER TABLE church_settings ADD COLUMN location_lng DECIMAL(10,7) NULL');
        console.log('✅ church_settings location columns added');
      }
    } catch (e) {
      console.warn('⚠️  Could not ensure church_settings location columns:', e.message);
    }

    // Ensure kiosk columns exist in gathering_types
    try {
      const kioskCol = await Database.query("SHOW COLUMNS FROM gathering_types LIKE 'kiosk_enabled'");
      if (kioskCol.length === 0) {
        console.log('🛠️  Adding gathering_types.kiosk_enabled column');
        await Database.query('ALTER TABLE gathering_types ADD COLUMN kiosk_enabled BOOLEAN DEFAULT false AFTER custom_schedule');
        console.log('✅ gathering_types.kiosk_enabled added');
      }
    } catch (e) {
      console.warn('⚠️  Could not ensure gathering_types.kiosk_enabled column:', e.message);
    }

    try {
      const kioskMsgCol = await Database.query("SHOW COLUMNS FROM gathering_types LIKE 'kiosk_message'");
      if (kioskMsgCol.length === 0) {
        console.log('🛠️  Adding gathering_types.kiosk_message column');
        await Database.query('ALTER TABLE gathering_types ADD COLUMN kiosk_message TEXT DEFAULT NULL AFTER kiosk_enabled');
        console.log('✅ gathering_types.kiosk_message added');
      }
    } catch (e) {
      console.warn('⚠️  Could not ensure gathering_types.kiosk_message column:', e.message);
    }

    // Ensure AI chat tables exist (needed for AI Insights chat history)
    try {
      const chatTables = await Database.query("SHOW TABLES LIKE 'ai_chat_conversations'");
      if (chatTables.length === 0) {
        console.log('🛠️  Creating ai_chat_conversations table');
        await Database.query(`
          CREATE TABLE IF NOT EXISTS ai_chat_conversations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            church_id VARCHAR(255) NOT NULL,
            title VARCHAR(500) DEFAULT 'New Chat',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_user_church (user_id, church_id),
            INDEX idx_church_id (church_id),
            INDEX idx_updated_at (updated_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ ai_chat_conversations table created');
      }
    } catch (e) {
      console.warn('⚠️  Could not ensure ai_chat_conversations table:', e.message);
    }

    try {
      const msgTables = await Database.query("SHOW TABLES LIKE 'ai_chat_messages'");
      if (msgTables.length === 0) {
        console.log('🛠️  Creating ai_chat_messages table');
        await Database.query(`
          CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            conversation_id INT NOT NULL,
            role ENUM('user', 'assistant', 'system') NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (conversation_id) REFERENCES ai_chat_conversations(id) ON DELETE CASCADE,
            INDEX idx_conversation (conversation_id),
            INDEX idx_created_at (created_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ ai_chat_messages table created');
      }
    } catch (e) {
      console.warn('⚠️  Could not ensure ai_chat_messages table:', e.message);
    }

    console.log('🎉 Database initialization check completed!');
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

async function startServer() {
  try {
    console.log('🚀 Starting server...');
    
    // Initialize database connection
    await Database.initialize();
    console.log('✅ Database connected');
    
    // Check database schema
    await initializeDatabase();
    
    // Run pending migrations
    await runMigrations();
    
    // Start the server
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
      console.log(`🎉 Server running on port ${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV}`);
      console.log(`🌐 Health check: http://localhost:${PORT}/health`);
    });
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

module.exports = { initializeDatabase, startServer }; 