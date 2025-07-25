require('dotenv').config();
const Database = require('./config/database');
const { generateOTC } = require('./utils/email');

async function testOTCStorage() {
  console.log('🔍 Testing OTC Storage and Retrieval...\n');
  
  try {
    // Test 1: Check database connection
    console.log('1. Testing database connection...');
    const testResult = await Database.query('SELECT 1 as test');
    console.log('   ✅ Database connection successful');
    console.log('');
    
    // Test 2: Check if otc_codes table exists
    console.log('2. Checking otc_codes table...');
    const tableCheck = await Database.query(`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = ? AND table_name = 'otc_codes'
    `, [process.env.DB_NAME || 'church_attendance']);
    
    if (tableCheck[0].count > 0) {
      console.log('   ✅ otc_codes table exists');
    } else {
      console.log('   ❌ otc_codes table does not exist');
      return;
    }
    console.log('');
    
    // Test 3: Check current OTC codes in database
    console.log('3. Checking current OTC codes in database...');
    const existingCodes = await Database.query(`
      SELECT contact_identifier, contact_type, code, expires_at, used, created_at 
      FROM otc_codes 
      ORDER BY created_at DESC 
      LIMIT 5
    `);
    
    console.log(`   Found ${existingCodes.length} OTC codes in database:`);
    existingCodes.forEach((code, index) => {
      console.log(`   ${index + 1}. ${code.contact_identifier} (${code.contact_type}) - Code: ${code.code} - Used: ${code.used} - Expires: ${code.expires_at}`);
    });
    console.log('');
    
    // Test 4: Insert a test OTC code
    console.log('4. Inserting test OTC code...');
    const testCode = generateOTC();
    const testEmail = 'test@example.com';
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    
    const insertResult = await Database.query(`
      INSERT INTO otc_codes (contact_identifier, contact_type, code, expires_at)
      VALUES (?, 'email', ?, ?)
    `, [testEmail, testCode, expiresAt]);
    
    console.log(`   ✅ Test OTC code inserted with ID: ${insertResult.insertId}`);
    console.log(`   Code: ${testCode} for ${testEmail}`);
    console.log('');
    
    // Test 5: Retrieve the test code
    console.log('5. Retrieving test OTC code...');
    const retrievedCode = await Database.query(`
      SELECT id, contact_identifier, contact_type, code, expires_at, used
      FROM otc_codes 
      WHERE id = ?
    `, [insertResult.insertId]);
    
    if (retrievedCode.length > 0) {
      const code = retrievedCode[0];
      console.log('   ✅ Test code retrieved successfully:');
      console.log(`   ID: ${code.id}`);
      console.log(`   Contact: ${code.contact_identifier} (${code.contact_type})`);
      console.log(`   Code: ${code.code}`);
      console.log(`   Expires: ${code.expires_at}`);
      console.log(`   Used: ${code.used}`);
    } else {
      console.log('   ❌ Failed to retrieve test code');
    }
    console.log('');
    
    // Test 6: Test the exact query used in verification
    console.log('6. Testing verification query...');
    const verificationQuery = await Database.query(`
      SELECT id, contact_identifier, contact_type FROM otc_codes 
      WHERE contact_identifier = ? AND contact_type = ? AND code = ? AND used = false AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1
    `, [testEmail, 'email', testCode]);
    
    if (verificationQuery.length > 0) {
      console.log('   ✅ Verification query found the code');
      console.log(`   Found record: ${verificationQuery[0].id}`);
    } else {
      console.log('   ❌ Verification query did not find the code');
      console.log('   This might indicate a timezone or format issue');
    }
    console.log('');
    
    // Clean up test data
    console.log('7. Cleaning up test data...');
    await Database.query('DELETE FROM otc_codes WHERE contact_identifier = ?', [testEmail]);
    console.log('   ✅ Test data cleaned up');
    
  } catch (error) {
    console.error('❌ Error during OTC storage test:', error);
  }
}

testOTCStorage().catch(console.error); 