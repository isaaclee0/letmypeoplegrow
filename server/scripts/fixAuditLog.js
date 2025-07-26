const Database = require('../config/database');
const fs = require('fs');
const path = require('path');

async function fixAuditLogTable() {
  try {
    console.log('🔧 Fixing audit_log table structure...');
    
    // Read the SQL migration file
    const sqlPath = path.join(__dirname, 'fix_audit_log.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');
    
    // Split the SQL into individual statements
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));
    
    // Execute each statement
    for (const statement of statements) {
      if (statement.trim()) {
        console.log(`Executing: ${statement.substring(0, 50)}...`);
        await Database.query(statement);
      }
    }
    
    // Show the final table structure
    console.log('\n📋 Final audit_log table structure:');
    const tableStructure = await Database.query('DESCRIBE audit_log');
    console.table(tableStructure);
    
    console.log('✅ audit_log table structure fixed successfully!');
    
  } catch (error) {
    console.error('❌ Failed to fix audit_log table:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  fixAuditLogTable()
    .then(() => {
      console.log('🎉 Migration completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { fixAuditLogTable }; 