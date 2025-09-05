const Database = require('../config/database');

async function runMigration() {
  try {
    console.log('Starting headcount migration...');

    // Add new columns to gathering_types table
    console.log('Adding attendance_type column...');
    await Database.query(`
      ALTER TABLE gathering_types 
      ADD COLUMN attendance_type ENUM('standard', 'headcount') DEFAULT 'standard' AFTER frequency
    `);

    console.log('Adding custom_schedule column...');
    await Database.query(`
      ALTER TABLE gathering_types 
      ADD COLUMN custom_schedule JSON DEFAULT NULL AFTER attendance_type
    `);

    console.log('Adding attendance_type index...');
    await Database.query(`
      ALTER TABLE gathering_types 
      ADD INDEX idx_attendance_type (attendance_type)
    `);

    // Create headcount_records table
    console.log('Creating headcount_records table...');
    await Database.query(`
      CREATE TABLE IF NOT EXISTS headcount_records (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        headcount INT NOT NULL DEFAULT 0,
        updated_by INT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        church_id VARCHAR(36) NOT NULL,
        FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_session_headcount (session_id),
        INDEX idx_church_id (church_id),
        INDEX idx_updated_by (updated_by)
      ) ENGINE=InnoDB
    `);

    // Add church_id to gathering_types if it doesn't exist
    console.log('Checking for church_id column...');
    try {
      await Database.query(`
        ALTER TABLE gathering_types 
        ADD COLUMN church_id VARCHAR(36) NOT NULL DEFAULT 'default' AFTER created_by
      `);
      console.log('Added church_id column');
    } catch (error) {
      if (error.message.includes('Duplicate column name')) {
        console.log('church_id column already exists');
      } else {
        throw error;
      }
    }

    try {
      await Database.query(`
        ALTER TABLE gathering_types 
        ADD INDEX idx_church_id (church_id)
      `);
      console.log('Added church_id index');
    } catch (error) {
      if (error.message.includes('Duplicate key name')) {
        console.log('church_id index already exists');
      } else {
        throw error;
      }
    }

    // Update existing gatherings to have standard attendance type
    console.log('Updating existing gatherings...');
    await Database.query(`
      UPDATE gathering_types 
      SET attendance_type = 'standard' 
      WHERE attendance_type IS NULL
    `);

    console.log('Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
