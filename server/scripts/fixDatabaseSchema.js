#!/usr/bin/env node

/**
 * Fix Database Schema Script
 * This script ensures all required columns and indexes exist in the database
 * It can be run to fix any missing schema elements
 */

const Database = require('../config/database');
const { 
  safeAddColumn, 
  safeCreateIndex, 
  getMigrationStatus 
} = require('../utils/migrationHelpers');

async function fixDatabaseSchema() {
  console.log('🔧 Fixing database schema...\n');

  try {
    // Start transaction
    await Database.query('START TRANSACTION');

    const results = {
      columns: [],
      indexes: [],
      errors: []
    };

    // Fix individuals table
    console.log('📋 Fixing individuals table...');
    const isVisitorAdded = await safeAddColumn('individuals', 'is_visitor', 'BOOLEAN DEFAULT false', 'is_active');
    if (isVisitorAdded) results.columns.push('individuals.is_visitor');
    
    const isVisitorIndexAdded = await safeCreateIndex('individuals', 'idx_is_visitor', 'is_visitor');
    if (isVisitorIndexAdded) results.indexes.push('individuals.idx_is_visitor');

    // Fix visitors table
    console.log('\n📋 Fixing visitors table...');
    const lastAttendedAdded = await safeAddColumn('visitors', 'last_attended', 'DATE', 'notes');
    if (lastAttendedAdded) results.columns.push('visitors.last_attended');
    
    const lastAttendedIndexAdded = await safeCreateIndex('visitors', 'idx_last_attended', 'last_attended');
    if (lastAttendedIndexAdded) results.indexes.push('visitors.idx_last_attended');

    // Fix audit_log table
    console.log('\n📋 Fixing audit_log table...');
    const entityTypeAdded = await safeAddColumn('audit_log', 'entity_type', 'VARCHAR(50)', 'action');
    if (entityTypeAdded) results.columns.push('audit_log.entity_type');
    
    const entityIdAdded = await safeAddColumn('audit_log', 'entity_id', 'INT', 'entity_type');
    if (entityIdAdded) results.columns.push('audit_log.entity_id');
    
    const entityIndexAdded = await safeCreateIndex('audit_log', 'idx_entity', 'entity_type, entity_id');
    if (entityIndexAdded) results.indexes.push('audit_log.idx_entity');

    // Commit transaction
    await Database.query('COMMIT');

    // Verify final status
    console.log('\n🔍 Verifying final schema status...');
    const verification = await getMigrationStatus();

    // Print results
    console.log('\n📊 Schema Fix Results:');
    console.log('=====================');
    
    if (results.columns.length > 0) {
      console.log('\n✅ Columns added:');
      results.columns.forEach(col => console.log(`   - ${col}`));
    }
    
    if (results.indexes.length > 0) {
      console.log('\n✅ Indexes created:');
      results.indexes.forEach(idx => console.log(`   - ${idx}`));
    }

    console.log('\n🔍 Verification Results:');
    console.log('=======================');
    
    if (verification.success) {
      console.log('✅ All required schema elements are present!');
    } else {
      console.log('❌ Missing schema elements:');
      verification.missing.forEach(item => console.log(`   - ${item}`));
    }

    if (verification.existing.length > 0) {
      console.log('\n✅ Existing schema elements:');
      verification.existing.forEach(item => console.log(`   - ${item}`));
    }

    console.log('\n🎉 Database schema fix completed!');
    
    if (verification.success) {
      console.log('🚀 All migrations are now properly applied.');
      console.log('💡 You can now use all features including visitor management.');
    } else {
      console.log('⚠️  Some schema elements are still missing.');
      console.log('💡 Check the errors above and run this script again if needed.');
    }

  } catch (error) {
    await Database.query('ROLLBACK');
    console.error('❌ Error fixing database schema:', error);
    process.exit(1);
  } finally {
    await Database.end();
  }
}

// Run the script
if (require.main === module) {
  fixDatabaseSchema().catch(console.error);
}

module.exports = { fixDatabaseSchema }; 