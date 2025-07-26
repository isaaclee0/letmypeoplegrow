const Database = require('../config/database');

async function fixMigrations() {
  try {
    console.log('🗄️  Fixing migration issues...');
    
    // Delete failed migration records
    const result = await Database.query(
      'DELETE FROM migrations WHERE status = "failed"'
    );
    
    console.log(`✅ Reset ${result.affectedRows} failed migrations`);
    console.log('');
    console.log('🔄 Next steps:');
    console.log('1. Go to the web interface at /app/migrations');
    console.log('2. Run the pending migrations');
    console.log('3. The individuals list should now work properly');
    console.log('');
    console.log('📝 Migration changes:');
    console.log('- 002_add_contact_fields: Now only adds is_visitor flag (no phone/email)');
    console.log('- 003_enhance_visitors_table: Enhances visitors table');
    console.log('- 004_add_visitor_flag: Removed (merged into 002)');
    
  } catch (error) {
    console.error('❌ Failed to fix migrations:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  fixMigrations()
    .then(() => {
      console.log('🎉 Migration fix completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Migration fix failed:', error);
      process.exit(1);
    });
}

module.exports = { fixMigrations }; 