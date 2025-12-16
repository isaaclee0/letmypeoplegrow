#!/usr/bin/env node

/**
 * Fix Imported People Type Script
 * This script updates all individuals that were imported from Elvanto (or other sources)
 * but don't have a people_type set, setting them to 'regular' so they appear in the PEOPLE view.
 */

const Database = require('../config/database');

async function fixImportedPeopleType() {
  console.log('🔧 Fixing imported people without people_type...\n');

  try {
    // Find all active individuals without a people_type set
    const individualsWithoutType = await Database.query(`
      SELECT id, first_name, last_name, people_type, is_active
      FROM individuals
      WHERE (people_type IS NULL OR people_type = '')
        AND is_active = true
      ORDER BY last_name, first_name
    `);

    // Also check for the specific user mentioned - try multiple variations
    console.log(`\n🔍 Searching for Davis, Michael...`);
    
    // Try exact match
    let davisMichael = await Database.query(`
      SELECT id, first_name, last_name, people_type, is_active, church_id, created_at
      FROM individuals
      WHERE LOWER(first_name) = LOWER('Michael') 
        AND LOWER(last_name) = LOWER('Davis')
      ORDER BY last_name, first_name
    `);

    // If not found, try searching for just "Davis" or "Michael" separately
    if (davisMichael.length === 0) {
      console.log(`   Trying broader search...`);
      const broadSearch = await Database.query(`
        SELECT id, first_name, last_name, people_type, is_active, church_id, created_at
        FROM individuals
        WHERE LOWER(first_name) LIKE '%michael%' 
           OR LOWER(last_name) LIKE '%davis%'
           OR LOWER(first_name) LIKE '%davis%'
           OR LOWER(last_name) LIKE '%michael%'
        ORDER BY last_name, first_name
        LIMIT 20
      `);
      
      if (broadSearch.length > 0) {
        console.log(`   Found ${broadSearch.length} similar name(s):`);
        broadSearch.forEach((person) => {
          console.log(`     - ${person.first_name} ${person.last_name} (ID: ${person.id}, active: ${person.is_active})`);
        });
      }
    }

    // Also check archived/inactive records
    const archivedSearch = await Database.query(`
      SELECT id, first_name, last_name, people_type, is_active, church_id, created_at
      FROM individuals
      WHERE (LOWER(first_name) = LOWER('Michael') AND LOWER(last_name) = LOWER('Davis'))
         OR (LOWER(first_name) LIKE '%michael%' AND LOWER(last_name) LIKE '%davis%')
         OR (LOWER(first_name) LIKE '%davis%' AND LOWER(last_name) LIKE '%michael%')
      ORDER BY last_name, first_name
    `);

    if (archivedSearch.length > 0) {
      console.log(`\n📋 Found ${archivedSearch.length} record(s) matching Davis/Michael (including inactive):`);
      archivedSearch.forEach((person) => {
        console.log(`   - ID: ${person.id}, First: ${person.first_name}, Last: ${person.last_name}`);
        console.log(`     people_type: ${person.people_type || 'NULL'}, is_active: ${person.is_active}, church_id: ${person.church_id}`);
        console.log(`     created_at: ${person.created_at}`);
      });
    } else {
      console.log(`\n⚠️  Davis, Michael not found in database at all.`);
      console.log(`   Possible reasons:`);
      console.log(`   1. The import may have failed silently`);
      console.log(`   2. They may have been deleted`);
      console.log(`   3. The name might be stored completely differently`);
      console.log(`   4. They might be in a different church (church_id mismatch)`);
    }

    if (individualsWithoutType.length === 0) {
      console.log('\n✅ No individuals found without people_type. All good!');
      if (davisMichael.length > 0) {
        console.log('\n💡 If Davis, Michael still doesn\'t appear, check:');
        console.log('   1. Is people_type set to "regular"? (should be "regular" to appear in main view)');
        console.log('   2. Is is_active = true?');
        console.log('   3. Do they have the correct church_id?');
      }
      return;
    }

    console.log(`📋 Found ${individualsWithoutType.length} individual(s) without people_type:\n`);
    individualsWithoutType.forEach((person, index) => {
      console.log(`   ${index + 1}. ${person.first_name} ${person.last_name} (ID: ${person.id})`);
    });

    // Update them to 'regular'
    const result = await Database.query(`
      UPDATE individuals
      SET people_type = 'regular', updated_at = NOW()
      WHERE (people_type IS NULL OR people_type = '')
        AND is_active = true
    `);

    console.log(`\n✅ Updated ${result.affectedRows} individual(s) to people_type = 'regular'`);
    console.log('\n🎉 All imported people should now appear in the PEOPLE view!');

  } catch (error) {
    console.error('❌ Error fixing imported people type:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Run the script
if (require.main === module) {
  fixImportedPeopleType().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { fixImportedPeopleType };

