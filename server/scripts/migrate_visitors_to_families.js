#!/usr/bin/env node

/**
 * Migrate Visitors to Families Script
 * This script migrates existing visitors from the old visitors table to the new family-based system
 * where visitors are stored as families with familyType = 'visitor' and individuals with is_visitor = true
 */

const Database = require('../config/database');

async function migrateVisitorsToFamilies() {
  console.log('🔄 Starting visitor migration to family-based system...\n');

  try {
    // Start transaction
    await Database.query('START TRANSACTION');

    // Get all unique visitors from the visitors table
    const uniqueVisitors = await Database.query(`
      SELECT DISTINCT 
        name, 
        visitor_type, 
        visitor_family_group, 
        notes, 
        MAX(last_attended) as last_attended
      FROM visitors 
      WHERE session_id IS NOT NULL
      GROUP BY name, visitor_type, visitor_family_group, notes
      ORDER BY last_attended DESC
    `);

    console.log(`📋 Found ${uniqueVisitors.length} unique visitors to migrate`);

    let migratedCount = 0;
    let skippedCount = 0;

    for (const visitor of uniqueVisitors) {
      try {
        // Parse visitor name to extract people
        const nameParts = visitor.name.trim().split(' & ');
        const people = nameParts.map(namePart => {
          const personParts = namePart.trim().split(' ');
          const firstName = personParts[0] || 'Unknown';
          const lastName = personParts.slice(1).join(' ') || 'Unknown';
          return { firstName, lastName };
        });

        // Check if this visitor family already exists
        const existingFamily = await Database.query(`
          SELECT f.id, f.family_name 
          FROM families f
          JOIN individuals i ON f.id = i.family_id
          WHERE f.familyType = 'visitor' 
            AND i.is_visitor = true
            AND (
              f.family_name = ? OR
              (i.first_name = ? AND i.last_name = ?)
            )
        `, [visitor.name, people[0].firstName, people[0].lastName]);

        if (existingFamily.length > 0) {
          console.log(`⏭️  Skipping ${visitor.name} - already exists as family ${existingFamily[0].id}`);
          skippedCount++;
          continue;
        }

        // Create visitor family
        const familyName = people.length > 1 ? visitor.name : `${people[0].firstName} ${people[0].lastName}`;
        const visitorType = visitor.visitor_type === 'potential_regular' ? 'local' : 'traveller';
        const familyIdentifier = `Visitor Type: ${visitorType}${visitor.notes ? `. Notes: ${visitor.notes}` : ''}`;

        const familyResult = await Database.query(`
          INSERT INTO families (family_name, familyType, family_identifier, lastAttended, created_by)
          VALUES (?, 'visitor', ?, ?, 1)
        `, [familyName, familyIdentifier, visitor.last_attended]);

        const familyId = Number(familyResult.insertId);

        // Create individuals for each person
        for (const person of people) {
          // Check if individual already exists
          const existingIndividual = await Database.query(`
            SELECT id FROM individuals 
            WHERE first_name = ? AND last_name = ? AND is_visitor = true
          `, [person.firstName, person.lastName]);

          if (existingIndividual.length === 0) {
            // Create new individual
            await Database.query(`
              INSERT INTO individuals (first_name, last_name, family_id, is_visitor, is_active, created_by)
              VALUES (?, ?, ?, true, true, 1)
            `, [person.firstName, person.lastName, familyId]);
          } else {
            // Update existing individual to link to this family
            await Database.query(`
              UPDATE individuals 
              SET family_id = ?, is_visitor = true, is_active = true
              WHERE id = ?
            `, [familyId, existingIndividual[0].id]);
          }
        }

        console.log(`✅ Migrated ${visitor.name} to family ${familyId}`);
        migratedCount++;

      } catch (error) {
        console.error(`❌ Error migrating ${visitor.name}:`, error.message);
        // Continue with next visitor
      }
    }

    console.log(`\n📊 Migration Summary:`);
    console.log(`   ✅ Migrated: ${migratedCount} visitors`);
    console.log(`   ⏭️  Skipped: ${skippedCount} visitors (already existed)`);
    console.log(`   📋 Total processed: ${uniqueVisitors.length} visitors`);

    // Commit transaction
    await Database.query('COMMIT');
    console.log('\n🎉 Migration completed successfully!');

  } catch (error) {
    // Rollback transaction
    await Database.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

// Run migration if called directly
if (require.main === module) {
  migrateVisitorsToFamilies()
    .then(() => {
      console.log('Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateVisitorsToFamilies }; 