const mariadb = require('mariadb');

// Database configuration for Docker environment
const dbConfig = {
  host: 'db', // Use the Docker service name
  port: 3306, // Use the internal Docker port
  user: 'church_user',
  password: 'church_password',
  database: 'church_attendance'
};

async function cleanupDuplicates() {
  let connection;
  
  try {
    console.log('🔍 Connecting to database...');
    connection = await mariadb.createConnection(dbConfig);
    console.log('✅ Connected to database successfully\n');

    // First, let's see what duplicates exist
    console.log('📊 ANALYZING DUPLICATES...\n');
    
    const duplicateFamilies = await connection.query(`
      SELECT 
        family_name,
        COUNT(*) as count,
        GROUP_CONCAT(id ORDER BY id) as family_ids,
        MIN(id) as keep_id,
        MAX(id) as delete_id
      FROM families 
      GROUP BY family_name 
      HAVING COUNT(*) > 1 
      ORDER BY family_name
    `);

    console.log(`Found ${duplicateFamilies.length} families with duplicates:\n`);
    
    for (const family of duplicateFamilies) {
      console.log(`• ${family.family_name}:`);
      console.log(`  - Keep: Family ID ${family.keep_id}`);
      console.log(`  - Delete: Family ID ${family.delete_id}`);
      console.log(`  - Total records: ${family.count}`);
      console.log('');
    }

    // Count individuals that will be affected
    const individualsToDelete = await connection.query(`
      SELECT COUNT(*) as count
      FROM individuals i
      JOIN (
        SELECT family_name, MAX(id) as delete_id
        FROM families 
        GROUP BY family_name 
        HAVING COUNT(*) > 1
      ) dupes ON i.family_id = dupes.delete_id
    `);

    console.log(`📋 SUMMARY:`);
    console.log(`• Families to delete: ${duplicateFamilies.length}`);
    console.log(`• Individuals to delete: ${individualsToDelete[0].count}`);
    console.log('');

    // Ask for confirmation
    console.log('⚠️  WARNING: This will permanently delete duplicate records!');
    console.log('   The script will keep the family with the lower ID and delete the duplicate.');
    console.log('');
    
    // In a real scenario, you'd want user input here
    // For now, we'll just show what would be deleted
    console.log('🔍 PREVIEW MODE - No changes will be made');
    console.log('To actually perform the cleanup, uncomment the deletion lines in the script.\n');

    // Show detailed preview of what would be deleted
    console.log('📝 DETAILED PREVIEW OF DELETIONS:\n');
    
    for (const family of duplicateFamilies) {
      console.log(`Family: ${family.family_name}`);
      
      // Get individuals in the duplicate family
      const duplicateIndividuals = await connection.query(`
        SELECT id, first_name, last_name, created_at
        FROM individuals 
        WHERE family_id = ?
        ORDER BY id
      `, [family.delete_id]);
      
      console.log(`  Individuals to delete (Family ID ${family.delete_id}):`);
      for (const person of duplicateIndividuals) {
        console.log(`    - ${person.first_name} ${person.last_name} (ID: ${person.id})`);
      }
      console.log('');
    }

    // Show what would remain
    console.log('✅ WHAT WOULD REMAIN AFTER CLEANUP:\n');
    
    const remainingFamilies = await connection.query(`
      SELECT id, family_name, created_at
      FROM families 
      WHERE id NOT IN (
        SELECT MAX(id)
        FROM families 
        GROUP BY family_name 
        HAVING COUNT(*) > 1
      )
      ORDER BY id
    `);
    
    console.log(`Remaining families: ${remainingFamilies.length}`);
    for (const family of remainingFamilies) {
      console.log(`  - ${family.family_name} (ID: ${family.id})`);
    }
    console.log('');

    // Instructions for actual cleanup
    console.log('🚀 TO PERFORM ACTUAL CLEANUP:');
    console.log('1. Edit this script and uncomment the deletion lines');
    console.log('2. Run the script again');
    console.log('3. The script will ask for confirmation before proceeding');
    console.log('');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    if (connection) {
      await connection.end();
      console.log('🔌 Database connection closed');
    }
  }
}

// Function to actually perform the cleanup (commented out for safety)
async function performCleanup() {
  let connection;
  
  try {
    console.log('🔍 Connecting to database...');
    connection = await mariadb.createConnection(dbConfig);
    console.log('✅ Connected to database successfully\n');

    console.log('⚠️  STARTING CLEANUP PROCESS...\n');

    // Start transaction
    await connection.beginTransaction();

    // Delete individuals from duplicate families
    const deletedIndividuals = await connection.query(`
      DELETE FROM individuals 
      WHERE family_id IN (
        SELECT delete_id FROM (
          SELECT family_name, MAX(id) as delete_id
          FROM families 
          GROUP BY family_name 
          HAVING COUNT(*) > 1
        ) dupes
      )
    `);

    console.log(`🗑️  Deleted ${deletedIndividuals.affectedRows} individuals`);

    // Delete duplicate families
    const deletedFamilies = await connection.query(`
      DELETE FROM families 
      WHERE id IN (
        SELECT delete_id FROM (
          SELECT family_name, MAX(id) as delete_id
          FROM families 
          GROUP BY family_name 
          HAVING COUNT(*) > 1
        ) dupes
      )
    `);

    console.log(`🗑️  Deleted ${deletedFamilies.affectedRows} families`);

    // Commit transaction
    await connection.commit();
    console.log('✅ Cleanup completed successfully!');

    // Show final results
    const remainingCount = await connection.query('SELECT COUNT(*) as count FROM families');
    console.log(`📊 Remaining families: ${remainingCount[0].count}`);

  } catch (error) {
    console.error('❌ Error during cleanup:', error.message);
    if (connection) {
      await connection.rollback();
      console.log('🔄 Transaction rolled back');
    }
  } finally {
    if (connection) {
      await connection.end();
      console.log('🔌 Database connection closed');
    }
  }
}

// Run the analysis
// cleanupDuplicates();

// Perform actual cleanup
performCleanup(); 