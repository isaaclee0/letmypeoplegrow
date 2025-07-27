#!/usr/bin/env node

/**
 * Fix Visitor Data Script
 * This script identifies individuals who were created as visitors but don't have
 * the is_visitor flag properly set, and updates them.
 */

const Database = require('../config/database');

async function fixVisitorData() {
  console.log('🔧 Fixing visitor data in database...\n');

  try {
    // First, ensure the is_visitor column exists
    try {
      await Database.query(`
        ALTER TABLE individuals 
        ADD COLUMN is_visitor BOOLEAN DEFAULT false AFTER is_active
      `);
      console.log('✅ Added is_visitor column');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('✅ is_visitor column already exists');
      } else {
        throw err;
      }
    }

    // Strategy 1: Find individuals who match visitor names
    console.log('🔍 Finding individuals who match visitor entries...');
    const matchingVisitors = await Database.query(`
      SELECT DISTINCT i.id, i.first_name, i.last_name, v.name as visitor_name
      FROM individuals i
      JOIN visitors v ON (
        CONCAT(i.first_name, ' ', i.last_name) = v.name OR
        v.name LIKE CONCAT('%', i.first_name, '%') OR
        v.name LIKE CONCAT('%', i.last_name, '%')
      )
      WHERE i.is_visitor = false OR i.is_visitor IS NULL
    `);

    if (matchingVisitors.length > 0) {
      console.log(`📋 Found ${matchingVisitors.length} individuals matching visitor records:`);
      matchingVisitors.forEach(match => {
        console.log(`   - ${match.first_name} ${match.last_name} (matches visitor: ${match.visitor_name})`);
      });

      const matchingIds = matchingVisitors.map(v => v.id);
      await Database.query(`
        UPDATE individuals 
        SET is_visitor = true 
        WHERE id IN (${matchingIds.map(() => '?').join(',')})
      `, matchingIds);

      console.log(`✅ Updated ${matchingVisitors.length} matching individuals\n`);
    } else {
      console.log('✅ No matching visitor individuals found\n');
    }

    // Strategy 2: Find individuals not in any gathering lists (likely visitors)
    console.log('🔍 Finding individuals not assigned to any gatherings...');
    const unassignedIndividuals = await Database.query(`
      SELECT i.id, i.first_name, i.last_name, i.created_at
      FROM individuals i
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      WHERE gl.individual_id IS NULL 
        AND (i.is_visitor = false OR i.is_visitor IS NULL)
        AND i.created_at > DATE_SUB(NOW(), INTERVAL 6 MONTH)
      ORDER BY i.created_at DESC
    `);

    if (unassignedIndividuals.length > 0) {
      console.log(`📋 Found ${unassignedIndividuals.length} unassigned individuals (created in last 6 months):`);
      unassignedIndividuals.forEach(individual => {
        console.log(`   - ${individual.first_name} ${individual.last_name} (created: ${individual.created_at})`);
      });

      const unassignedIds = unassignedIndividuals.map(i => i.id);
      await Database.query(`
        UPDATE individuals 
        SET is_visitor = true 
        WHERE id IN (${unassignedIds.map(() => '?').join(',')})
      `, unassignedIds);

      console.log(`✅ Updated ${unassignedIndividuals.length} unassigned individuals\n`);
    } else {
      console.log('✅ No unassigned individuals found\n');
    }

    // Strategy 3: Find individuals with "Unknown" as last name (common for visitors)
    console.log('🔍 Finding individuals with "Unknown" surnames...');
    const unknownSurnameIndividuals = await Database.query(`
      SELECT id, first_name, last_name
      FROM individuals
      WHERE last_name = 'Unknown' 
        AND (is_visitor = false OR is_visitor IS NULL)
    `);

    if (unknownSurnameIndividuals.length > 0) {
      console.log(`📋 Found ${unknownSurnameIndividuals.length} individuals with "Unknown" surname:`);
      unknownSurnameIndividuals.forEach(individual => {
        console.log(`   - ${individual.first_name} ${individual.last_name}`);
      });

      const unknownIds = unknownSurnameIndividuals.map(i => i.id);
      await Database.query(`
        UPDATE individuals 
        SET is_visitor = true 
        WHERE id IN (${unknownIds.map(() => '?').join(',')})
      `, unknownIds);

      console.log(`✅ Updated ${unknownSurnameIndividuals.length} "Unknown" surname individuals\n`);
    } else {
      console.log('✅ No "Unknown" surname individuals found\n');
    }

    // Final summary
    console.log('📊 Final summary:');
    const totalVisitors = await Database.query(`
      SELECT COUNT(*) as count FROM individuals WHERE is_visitor = true
    `);
    const totalRegulars = await Database.query(`
      SELECT COUNT(*) as count FROM individuals WHERE is_visitor = false OR is_visitor IS NULL
    `);

    console.log(`   - Total visitors: ${totalVisitors[0].count}`);
    console.log(`   - Total regular attendees: ${totalRegulars[0].count}`);

    console.log('\n🎉 Visitor data cleanup completed!');
    console.log('\nNext steps:');
    console.log('1. Test attendance page to verify visitors appear correctly');
    console.log('2. If results look good, commit and deploy the changes');

  } catch (error) {
    console.error('❌ Error fixing visitor data:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

// Run the script if called directly
if (require.main === module) {
  fixVisitorData();
}

module.exports = { fixVisitorData }; 