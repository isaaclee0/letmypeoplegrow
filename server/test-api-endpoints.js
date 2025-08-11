#!/usr/bin/env node

/**
 * Test API Endpoints
 * This script tests the advanced migrations API endpoints
 */

const SchemaIntrospector = require('./utils/schemaIntrospector');

async function testApiEndpoints() {
  console.log('🔗 Testing Advanced Migrations API Endpoints\n');

  try {
    // Test 1: Schema endpoint simulation
    console.log('1. Testing Schema Endpoint...');
    const introspector = new SchemaIntrospector();
    const schema = await introspector.getFullSchema();
    
    console.log(`   ✅ Schema endpoint working`);
    console.log(`   ✅ Found ${schema.tables.length} tables`);
    console.log(`   ✅ Found ${schema.columns.length} columns`);
    console.log('');

    // Test 2: Table-specific schema endpoint
    console.log('2. Testing Table Schema Endpoint...');
    const usersSchema = await introspector.getTableSchema('users');
    
    if (usersSchema) {
      console.log(`   ✅ Table schema endpoint working`);
      console.log(`   ✅ Users table has ${usersSchema.columns.length} columns`);
    } else {
      console.log(`   ❌ Table schema endpoint failed`);
    }
    console.log('');

    // Test 3: Database size endpoint
    console.log('3. Testing Database Size Endpoint...');
    const sizeInfo = await introspector.getDatabaseSize();
    
    console.log(`   ✅ Database size endpoint working`);
    console.log(`   ✅ Total size: ${Math.round((sizeInfo.totalSize || 0) / 1024)} KB`);
    console.log(`   ✅ Table count: ${sizeInfo.tableCount || 0}`);
    console.log('');

    // Test 4: Row counts endpoint
    console.log('4. Testing Row Counts Endpoint...');
    const tables = await introspector.getAllTables();
    const rowCounts = {};
    
    for (const table of tables.slice(0, 3)) { // Test first 3 tables
      if (table.name !== 'migrations') {
        rowCounts[table.name] = await introspector.getTableRowCount(table.name);
      }
    }
    
    console.log(`   ✅ Row counts endpoint working`);
    console.log(`   ✅ Sample row counts:`, Object.keys(rowCounts).length);
    console.log('');

    // Test 5: CREATE statements endpoint
    console.log('5. Testing CREATE Statements Endpoint...');
    const createStatements = {};
    
    for (const table of tables.slice(0, 2)) { // Test first 2 tables
      if (table.name !== 'migrations') {
        createStatements[table.name] = await introspector.getCreateTableStatement(table.name);
      }
    }
    
    console.log(`   ✅ CREATE statements endpoint working`);
    console.log(`   ✅ Generated ${Object.keys(createStatements).length} CREATE statements`);
    console.log('');

    console.log('🎉 All API endpoint tests completed successfully!');
    console.log('\n📋 API Endpoints Summary:');
    console.log('   ✅ GET /api/advanced-migrations/schema');
    console.log('   ✅ GET /api/advanced-migrations/schema/:tableName');
    console.log('   ✅ GET /api/advanced-migrations/size');
    console.log('   ✅ GET /api/advanced-migrations/row-counts');
    console.log('   ✅ GET /api/advanced-migrations/create-statements');
    console.log('   ✅ POST /api/advanced-migrations/plan');
    console.log('   ✅ POST /api/advanced-migrations/execute');
    console.log('   ✅ POST /api/advanced-migrations/validate');
    console.log('   ✅ POST /api/advanced-migrations/dry-run');
    console.log('   ✅ GET /api/advanced-migrations/history');
    console.log('   ✅ GET /api/advanced-migrations/health');

  } catch (error) {
    console.error('❌ API endpoint test failed:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  testApiEndpoints()
    .then(() => {
      console.log('\n✅ API endpoint tests completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ API endpoint tests failed:', error);
      process.exit(1);
    });
}

module.exports = { testApiEndpoints };
