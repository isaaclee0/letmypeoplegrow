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

    // Initialize development test data if in development mode
    if (process.env.NODE_ENV === 'development') {
      await initializeDevelopmentData();
    }

    console.log('🎉 Database initialization check completed!');
    
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

async function initializeDevelopmentData() {
  try {
    console.log('🔧 Development mode: Checking for test data...');
    
    // Check if gathering types exist
    const gatheringTypes = await Database.query('SELECT COUNT(*) as count FROM gathering_types');
    if (gatheringTypes[0].count === 0) {
      console.log('📅 Creating development gathering types...');
      
      // Create Sunday Morning Service
      await Database.query(`
        INSERT INTO gathering_types (name, description, is_active, created_at, updated_at) 
        VALUES ('Sunday Morning Service', 'Main worship service on Sunday mornings at 10:00 AM', true, NOW(), NOW())
      `);
      
      // Create Youth Group
      await Database.query(`
        INSERT INTO gathering_types (name, description, is_active, created_at, updated_at) 
        VALUES ('Youth Group', 'Weekly youth ministry gathering', true, NOW(), NOW())
      `);
      
      console.log('✅ Development gathering types created');
    }
    
    // Check if families exist
    const families = await Database.query('SELECT COUNT(*) as count FROM families');
    if (families[0].count === 0) {
      console.log('👨‍👩‍👧‍👦 Creating development families from template data...');
      
      // Development test families based on import_template.csv
      const testFamilies = [
        {
          name: 'Smith, John and Jane',
          members: [
            { firstName: 'John', lastName: 'Smith' },
            { firstName: 'Jane', lastName: 'Smith' }
          ]
        },
        {
          name: 'Johnson, Mike',
          members: [
            { firstName: 'Mike', lastName: 'Johnson' }
          ]
        },
        {
          name: 'Williams, David and Sarah',
          members: [
            { firstName: 'Sarah', lastName: 'Williams' },
            { firstName: 'David', lastName: 'Williams' }
          ]
        }
      ];
      
      for (const family of testFamilies) {
        // Insert family
        const familyResult = await Database.query(`
          INSERT INTO families (family_name, created_at, updated_at) 
          VALUES (?, NOW(), NOW())
        `, [family.name]);
        
        const familyId = familyResult.insertId;
        
        // Insert family members
        for (const member of family.members) {
          await Database.query(`
            INSERT INTO individuals (family_id, first_name, last_name, created_at, updated_at) 
            VALUES (?, ?, ?, NOW(), NOW())
          `, [familyId, member.firstName, member.lastName]);
        }
        
        console.log(`✅ Created family: ${family.name}`);
      }
    }
    
    console.log('🎉 Development test data initialization completed!');
    
  } catch (error) {
    console.error('❌ Development data initialization failed:', error);
    // Don't throw error - this is just test data, shouldn't break the server
  }
}

module.exports = { initializeDatabase }; 