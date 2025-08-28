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
      
      // Check if we need to create a church_settings record first
      const existingSettings = await conn.query(
        'SELECT church_name FROM church_settings WHERE church_id = ?',
        [oldChurchId]
      );
      
      if (existingSettings.length === 0) {
        console.log(`🔧 Creating missing church_settings record for church_id: ${oldChurchId}`);
        await conn.query(
          'INSERT INTO church_settings (church_id, church_name, country_code, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
          [oldChurchId, churchName, 'AU', 'Australia/Sydney']
        );
        console.log(`✅ Created church_settings record`);
      }
      
      // Tables that reference church_id (only include existing ones)
      const allTables = [
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
      
      for (const table of allTables) {
        try {
          // Check if table exists first
          const tableExists = await conn.query(`SHOW TABLES LIKE '${table}'`);
          if (tableExists.length === 0) {
            console.log(`⚠️  Table ${table} does not exist, skipping`);
            continue;
          }
          
          const result = await conn.query(
            `UPDATE ${table} SET church_id = ? WHERE church_id = ?`,
            [newChurchId, oldChurchId]
          );
          
          if (result.affectedRows > 0) {
            console.log(`✅ Updated ${result.affectedRows} records in ${table}`);
          } else {
            console.log(`ℹ️  No records found in ${table}`);
          }
        } catch (tableError) {
          console.log(`⚠️  Error updating ${table}: ${tableError.message}`);
          // Continue with other tables instead of failing completely
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
    // Check if the old church ID exists in church_settings
    const existing = await Database.query(
      'SELECT church_name FROM church_settings WHERE church_id = ?',
      [oldChurchId]
    );
    
    // Check if there are users with this church_id
    const usersWithChurchId = await Database.query(
      'SELECT COUNT(*) as count FROM users WHERE church_id = ?',
      [oldChurchId]
    );
    
    if (existing.length === 0 && usersWithChurchId[0].count === 0) {
      console.error(`❌ Church with ID "${oldChurchId}" not found in any table`);
      process.exit(1);
    }
    
    if (existing.length === 0 && usersWithChurchId[0].count > 0) {
      console.log(`⚠️  Church ID "${oldChurchId}" found in users table but missing from church_settings`);
      console.log(`📋 Found ${usersWithChurchId[0].count} user(s) with this church_id`);
      console.log(`🔄 Will create church_settings record and update to use name: "${churchName}"`);
    } else {
      console.log(`📋 Found church: ${existing[0].church_name}`);
      console.log(`🔄 Will update to use name: "${churchName}"`);
    }
    
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
