#!/usr/bin/env node
/**
 * Script to update a church's ID from old format to new format
 * This script updates all related tables with foreign key references
 * 
 * Usage (inside Docker container): node update-church-id.js "enjoychurch" "enjoy church"
 * Usage (from host): ./docker-update-church-id.sh "enjoychurch" "enjoy church"
 */

// Determine if we're running inside the server directory or from project root
const path = require('path');
const fs = require('fs');

let Database, generateSimpleChurchId, generateSecureChurchId;

if (fs.existsSync('./config/database.js')) {
  // Running from server directory (inside container)
  Database = require('./config/database');
  const { generateSimpleChurchId: genSimple, generateSecureChurchId: genSecure } = require('./utils/churchIdGenerator');
  generateSimpleChurchId = genSimple;
  generateSecureChurchId = genSecure;
} else {
  // Running from project root
  Database = require('./server/config/database');
  const { generateSimpleChurchId: genSimple, generateSecureChurchId: genSecure } = require('./server/utils/churchIdGenerator');
  generateSimpleChurchId = genSimple;
  generateSecureChurchId = genSecure;
}

async function updateChurchId(oldChurchId, churchName) {
  try {
    console.log(`🔄 Starting church ID update for: ${oldChurchId} -> new ID based on "${churchName}"`);
    
    // Generate new church ID based on environment
    const newChurchId = process.env.NODE_ENV === 'production' 
      ? await generateSecureChurchId(churchName)
      : await generateSimpleChurchId(churchName);
    
    console.log(`✨ Generated new church ID: ${newChurchId}`);
    
    // Start transaction to ensure all updates succeed or fail together
    await Database.transaction(async (conn) => {
      
      // Tables that reference church_id (in dependency order)
      const tables = [
        'api_access_logs',
        'api_keys', 
        'attendance_records',
        'attendance_sessions',
        'audit_log',
        'families',
        'gathering_lists',
        'gathering_types',
        'individuals',
        'notifications',
        'notification_rules',
        'onboarding_progress',
        'otc_codes',
        'user_gathering_assignments',
        'user_invitations',
        'users',
        'church_settings' // Update this last
      ];
      
      for (const table of tables) {
        const result = await conn.query(
          `UPDATE ${table} SET church_id = ? WHERE church_id = ?`,
          [newChurchId, oldChurchId]
        );
        
        if (result.affectedRows > 0) {
          console.log(`✅ Updated ${result.affectedRows} records in ${table}`);
        } else {
          console.log(`ℹ️  No records found in ${table}`);
        }
      }
      
      console.log(`🎉 Successfully updated church ID from "${oldChurchId}" to "${newChurchId}"`);
    });
    
  } catch (error) {
    console.error('❌ Error updating church ID:', error);
    throw error;
  }
}

// Command line interface
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.log('Usage: node update-church-id.js <old-church-id> <church-name>');
    console.log('Example: node update-church-id.js "enjoychurch" "enjoy church"');
    process.exit(1);
  }
  
  const [oldChurchId, churchName] = args;
  
  try {
    // Verify the old church ID exists
    const existing = await Database.query(
      'SELECT church_name FROM church_settings WHERE church_id = ?',
      [oldChurchId]
    );
    
    if (existing.length === 0) {
      console.error(`❌ Church with ID "${oldChurchId}" not found`);
      process.exit(1);
    }
    
    console.log(`📋 Found church: ${existing[0].church_name}`);
    console.log(`🔄 Will update to use name: "${churchName}"`);
    
    // Ask for confirmation
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const answer = await new Promise(resolve => {
      readline.question('Are you sure you want to proceed? (yes/no): ', resolve);
    });
    
    readline.close();
    
    if (answer.toLowerCase() !== 'yes') {
      console.log('👋 Operation cancelled');
      process.exit(0);
    }
    
    await updateChurchId(oldChurchId, churchName);
    console.log('✅ Church ID update completed successfully!');
    
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  } finally {
    await Database.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { updateChurchId };
