#!/usr/bin/env node

/**
 * Test script to verify attendance isolation by church_id
 * This script checks that attendance sessions are properly isolated by church
 */

const Database = require('./config/database');

async function testAttendanceIsolation() {
  console.log('🧪 Testing attendance isolation...');
  
  try {
    // Check if the new unique constraint exists
    console.log('📋 Checking attendance_sessions table structure...');
    const tableStructure = await Database.query('DESCRIBE attendance_sessions');
    console.log('Table structure:', tableStructure.map(col => `${col.Field} (${col.Type})`));
    
    // Check indexes
    console.log('\n📋 Checking indexes...');
    const indexes = await Database.query('SHOW INDEX FROM attendance_sessions');
    const uniqueIndexes = indexes.filter(idx => idx.Non_unique === 0);
    console.log('Unique indexes:', uniqueIndexes.map(idx => `${idx.Key_name}: ${idx.Column_name}`));
    
    // Check if the new constraint exists
    const hasCorrectConstraint = uniqueIndexes.some(idx => 
      idx.Key_name === 'unique_session_with_church'
    );
    
    if (hasCorrectConstraint) {
      console.log('✅ Correct unique constraint found: unique_session_with_church');
    } else {
      console.log('❌ Missing correct unique constraint. Expected: unique_session_with_church');
      
      // Show all constraints for debugging
      console.log('All unique constraints found:');
      uniqueIndexes.forEach(idx => {
        console.log(`  - ${idx.Key_name}: ${idx.Column_name} (Seq: ${idx.Seq_in_index})`);
      });
    }
    
    // Test theoretical scenario: Multiple churches with same gathering type and date
    console.log('\n🔍 Testing session isolation scenario...');
    
    // Check if there are any existing sessions that might conflict
    const potentialConflicts = await Database.query(`
      SELECT gathering_type_id, session_date, COUNT(*) as session_count, GROUP_CONCAT(church_id) as church_ids
      FROM attendance_sessions 
      GROUP BY gathering_type_id, session_date 
      HAVING COUNT(*) > 1
    `);
    
    if (potentialConflicts.length > 0) {
      console.log('⚠️  Found potential conflicts (multiple sessions for same gathering+date):');
      potentialConflicts.forEach(conflict => {
        console.log(`  - Gathering ${conflict.gathering_type_id}, Date ${conflict.session_date}: ${conflict.session_count} sessions (churches: ${conflict.church_ids})`);
      });
    } else {
      console.log('✅ No session conflicts found - each gathering+date combination is unique per church');
    }
    
    // Check attendance_records table as well
    console.log('\n📋 Checking attendance_records table structure...');
    const recordsStructure = await Database.query('DESCRIBE attendance_records');
    const hasChurchIdInRecords = recordsStructure.some(col => col.Field === 'church_id');
    
    if (hasChurchIdInRecords) {
      console.log('✅ attendance_records table has church_id column');
    } else {
      console.log('❌ attendance_records table missing church_id column');
    }
    
    console.log('\n🎉 Attendance isolation test completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    process.exit(0);
  }
}

// Run the test
testAttendanceIsolation();
