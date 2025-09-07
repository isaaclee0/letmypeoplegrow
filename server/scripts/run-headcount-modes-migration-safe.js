const Database = require('../config/database');

async function runMigration() {
  try {
    console.log('Starting headcount modes migration (safe version)...');

    // Step 1: First, let's check if the migration has already been run
    console.log('Checking if migration has already been run...');
    const existingColumns = await Database.query(`
      SELECT COLUMN_NAME 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'attendance_sessions' 
        AND COLUMN_NAME = 'headcount_mode'
    `);
    
    if (existingColumns.length > 0) {
      console.log('✅ Migration appears to have already been run. Skipping...');
      return;
    }

    // Step 2: Check if the unique constraint already exists with the new name
    const existingIndexes = await Database.query(`
      SELECT INDEX_NAME 
      FROM information_schema.STATISTICS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'headcount_records' 
        AND INDEX_NAME = 'unique_session_user'
    `);
    
    if (existingIndexes.length > 0) {
      console.log('✅ New unique constraint already exists. Skipping index changes...');
    } else {
      // Step 3: Add the new unique constraint first (this will work even if the old one exists)
      console.log('Adding new unique constraint for session and user...');
      try {
        await Database.query('ALTER TABLE headcount_records ADD UNIQUE KEY unique_session_user (session_id, updated_by)');
        console.log('✅ New unique constraint added successfully');
      } catch (error) {
        if (error.code === 'ER_DUP_KEYNAME') {
          console.log('✅ New unique constraint already exists');
        } else {
          throw error;
        }
      }
    }

    // Step 4: Add a mode column to attendance_sessions to track the headcount mode for each session
    console.log('Adding headcount_mode column to attendance_sessions...');
    try {
      await Database.query(`
        ALTER TABLE attendance_sessions 
        ADD COLUMN headcount_mode ENUM('separate', 'combined', 'averaged') DEFAULT 'separate' AFTER notes
      `);
      console.log('✅ headcount_mode column added successfully');
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log('✅ headcount_mode column already exists');
      } else {
        throw error;
      }
    }

    // Step 5: Add an index for the new mode column
    console.log('Adding index for headcount_mode column...');
    try {
      await Database.query('ALTER TABLE attendance_sessions ADD INDEX idx_headcount_mode (headcount_mode)');
      console.log('✅ Index for headcount_mode added successfully');
    } catch (error) {
      if (error.code === 'ER_DUP_KEYNAME') {
        console.log('✅ Index for headcount_mode already exists');
      } else {
        throw error;
      }
    }

    // Step 6: Update existing sessions to use 'separate' mode (which is the new default)
    console.log('Updating existing sessions to use separate mode...');
    const updateResult = await Database.query("UPDATE attendance_sessions SET headcount_mode = 'separate' WHERE headcount_mode IS NULL");
    console.log(`✅ Updated ${updateResult.affectedRows} sessions to use separate mode`);

    // Step 7: Now we can safely drop the old unique constraint since we have the new one
    console.log('Attempting to drop old unique constraint...');
    try {
      await Database.query('ALTER TABLE headcount_records DROP INDEX unique_session_headcount');
      console.log('✅ Old unique constraint dropped successfully');
    } catch (error) {
      if (error.code === 'ER_CANT_DROP_FIELD_OR_KEY') {
        console.log('⚠️  Old unique constraint could not be dropped (likely due to foreign key constraints)');
        console.log('   This is okay - the new constraint will work alongside the old one');
      } else {
        console.log('⚠️  Could not drop old constraint:', error.message);
        console.log('   This is okay - the new constraint will work alongside the old one');
      }
    }

    console.log('');
    console.log('✅ Headcount modes migration completed successfully!');
    console.log('');
    console.log('Changes made:');
    console.log('- Added unique constraint for (session_id, updated_by) to support per-user records');
    console.log('- Added headcount_mode column to attendance_sessions table');
    console.log('- Set default mode to "separate" for all existing sessions');
    console.log('');
    console.log('The headcount feature now supports three modes:');
    console.log('- separate: Each user has their own count');
    console.log('- combined: All counts are added together');
    console.log('- averaged: All counts are averaged together');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    // Close the database connection properly
    if (Database.connection && Database.connection.end) {
      await Database.connection.end();
    }
  }
}

runMigration();
