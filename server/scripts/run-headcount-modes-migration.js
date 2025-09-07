const Database = require('../config/database');

async function runMigration() {
  try {
    console.log('Starting headcount modes migration...');

    // Step 1: Drop the existing unique constraint
    console.log('Dropping existing unique constraint...');
    await Database.query('ALTER TABLE headcount_records DROP INDEX unique_session_headcount');

    // Step 2: Add a new unique constraint that allows multiple records per session (one per user)
    console.log('Adding new unique constraint for session and user...');
    await Database.query('ALTER TABLE headcount_records ADD UNIQUE KEY unique_session_user (session_id, updated_by)');

    // Step 3: Add a mode column to attendance_sessions to track the headcount mode for each session
    console.log('Adding headcount_mode column to attendance_sessions...');
    await Database.query(`
      ALTER TABLE attendance_sessions 
      ADD COLUMN headcount_mode ENUM('separate', 'combined', 'averaged') DEFAULT 'separate' AFTER notes
    `);

    // Step 4: Add an index for the new mode column
    console.log('Adding index for headcount_mode column...');
    await Database.query('ALTER TABLE attendance_sessions ADD INDEX idx_headcount_mode (headcount_mode)');

    // Step 5: Update existing sessions to use 'separate' mode (which is the new default)
    console.log('Updating existing sessions to use separate mode...');
    await Database.query("UPDATE attendance_sessions SET headcount_mode = 'separate' WHERE headcount_mode IS NULL");

    console.log('✅ Headcount modes migration completed successfully!');
    console.log('');
    console.log('Changes made:');
    console.log('- Modified headcount_records table to support per-user records');
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
    await Database.close();
  }
}

runMigration();
