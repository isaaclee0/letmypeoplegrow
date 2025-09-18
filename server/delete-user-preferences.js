#!/usr/bin/env node

/**
 * Script to delete user preferences for a specific email address
 * Usage: node delete-user-preferences.js <email>
 * 
 * This script can be used for testing to clear user preferences
 * and test different scenarios with a clean slate.
 */

const mariadb = require('mariadb');

// Database configuration - using Docker container settings
const dbConfig = {
  host: 'db', // Docker service name
  port: 3306, // Internal Docker port
  user: 'church_user',
  password: 'church_password',
  database: 'church_attendance',
  acquireTimeout: 60000,
  timeout: 60000,
  connectionLimit: 10,
};

async function deleteUserPreferences(email) {
  let conn;
  
  try {
    console.log(`🔍 Looking up user with email: ${email}`);
    
    // Connect to database
    conn = await mariadb.createConnection(dbConfig);
    console.log('✅ Connected to database');
    
    // First, find the user ID
    const userQuery = 'SELECT id, email, church_id FROM users WHERE email = ?';
    const users = await conn.query(userQuery, [email]);
    
    if (users.length === 0) {
      console.log(`❌ No user found with email: ${email}`);
      return;
    }
    
    const user = users[0];
    console.log(`👤 Found user: ID=${user.id}, Email=${user.email}, Church ID=${user.church_id}`);
    
    // Check existing preferences
    const preferencesQuery = 'SELECT preference_key, preference_value, created_at, updated_at FROM user_preferences WHERE user_id = ?';
    const preferences = await conn.query(preferencesQuery, [user.id]);
    
    if (preferences.length === 0) {
      console.log('ℹ️  No preferences found for this user');
      return;
    }
    
    console.log(`📋 Found ${preferences.length} preferences:`);
    preferences.forEach(pref => {
      console.log(`   - ${pref.preference_key}: ${pref.preference_value} (updated: ${pref.updated_at})`);
    });
    
    // Delete all preferences for this user
    const deleteQuery = 'DELETE FROM user_preferences WHERE user_id = ?';
    const result = await conn.query(deleteQuery, [user.id]);
    
    console.log(`🗑️  Deleted ${result.affectedRows} preference records for user ${email}`);
    console.log('✅ User preferences deletion completed successfully');
    
  } catch (error) {
    console.error('❌ Error deleting user preferences:', error);
    throw error;
  } finally {
    if (conn) {
      await conn.end();
      console.log('🔌 Database connection closed');
    }
  }
}

// Main execution
async function main() {
  const email = process.argv[2];
  
  if (!email) {
    console.error('❌ Please provide an email address');
    console.log('Usage: node delete-user-preferences.js <email>');
    console.log('Examples:');
    console.log('  node delete-user-preferences.js isaac+test1@leemail.com.au');
    console.log('  node delete-user-preferences.js admin@example.com');
    process.exit(1);
  }
  
  try {
    await deleteUserPreferences(email);
  } catch (error) {
    console.error('❌ Script failed:', error.message);
    process.exit(1);
  }
}

// Run the script
main();
