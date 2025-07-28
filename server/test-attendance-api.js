require('dotenv').config();
const Database = require('./config/database');

async function testAttendanceAPI() {
  console.log('🔍 Testing Attendance API and Database Connection...\n');
  
  try {
    // Test 1: Check database connection
    console.log('1. Testing database connection...');
    const testResult = await Database.query('SELECT 1 as test');
    console.log('   ✅ Database connection successful');
    console.log('');
    
    // Test 2: Check if attendance tables exist
    console.log('2. Checking attendance tables...');
    const tables = ['attendance_sessions', 'attendance_records', 'visitors'];
    
    for (const table of tables) {
      const tableCheck = await Database.query(`
        SELECT COUNT(*) as count FROM information_schema.tables 
        WHERE table_schema = ? AND table_name = ?
      `, [process.env.DB_NAME || 'church_attendance', table]);
      
      if (tableCheck[0].count > 0) {
        console.log(`   ✅ ${table} table exists`);
      } else {
        console.log(`   ❌ ${table} table does not exist`);
      }
    }
    console.log('');
    
    // Test 3: Check table schemas
    console.log('3. Checking table schemas...');
    
    // Check attendance_sessions schema
    const sessionsSchema = await Database.query(`
      DESCRIBE attendance_sessions
    `);
    console.log('   attendance_sessions columns:');
    sessionsSchema.forEach(col => {
      console.log(`     - ${col.Field}: ${col.Type} ${col.Null === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });
    console.log('');
    
    // Check attendance_records schema
    const recordsSchema = await Database.query(`
      DESCRIBE attendance_records
    `);
    console.log('   attendance_records columns:');
    recordsSchema.forEach(col => {
      console.log(`     - ${col.Field}: ${col.Type} ${col.Null === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });
    console.log('');
    
    // Check visitors schema
    const visitorsSchema = await Database.query(`
      DESCRIBE visitors
    `);
    console.log('   visitors columns:');
    visitorsSchema.forEach(col => {
      console.log(`     - ${col.Field}: ${col.Type} ${col.Null === 'NO' ? 'NOT NULL' : 'NULL'}`);
    });
    console.log('');
    
    // Test 4: Check if there are any gathering types
    console.log('4. Checking gathering types...');
    const gatheringTypes = await Database.query(`
      SELECT id, name FROM gathering_types WHERE is_active = true
    `);
    console.log(`   Found ${gatheringTypes.length} active gathering types:`);
    gatheringTypes.forEach(gt => {
      console.log(`     - ID: ${gt.id}, Name: ${gt.name}`);
    });
    console.log('');
    
    // Test 5: Check if there are any individuals
    console.log('5. Checking individuals...');
    const individuals = await Database.query(`
      SELECT COUNT(*) as count FROM individuals WHERE is_active = true
    `);
    console.log(`   Found ${individuals[0].count} active individuals`);
    console.log('');
    
    // Test 6: Test the exact query that might be failing
    console.log('6. Testing attendance session creation...');
    try {
      const testSession = await Database.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, recorded_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE recorded_by = VALUES(recorded_by), updated_at = NOW()
      `, [7, '2025-07-20', 1]);
      console.log('   ✅ Attendance session creation works');
      
      // Clean up test data
      await Database.query('DELETE FROM attendance_sessions WHERE gathering_type_id = 7 AND session_date = "2025-07-20"');
      console.log('   ✅ Test data cleaned up');
    } catch (error) {
      console.log('   ❌ Attendance session creation failed:', error.message);
    }
    console.log('');
    
    console.log('✅ Database and API tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Full error:', error);
  }
}

testAttendanceAPI(); 