const Database = require('../config/database');

async function resetFailedMigrations() {
  try {
    console.log('🗄️  Resetting failed migrations...');
    
    // Delete failed migration records
    const result = await Database.query(
      'DELETE FROM migrations WHERE status = "failed"'
    );
    
    console.log(`✅ Reset ${result.affectedRows} failed migrations`);
    console.log('🔄 You can now run the migrations again through the web interface');
    
  } catch (error) {
    console.error('❌ Failed to reset migrations:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  resetFailedMigrations()
    .then(() => {
      console.log('🎉 Migration reset completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Migration reset failed:', error);
      process.exit(1);
    });
}

module.exports = { resetFailedMigrations }; 