/*
  Usage:
    node server/scripts/wipeChurchPeopleAndFamilies.js <church_id>

  Deletes all individuals and families for the given church_id.
  Dependent rows in gathering_lists and attendance_records will be removed via cascading FKs.
*/

const Database = require('../config/database');

async function main() {
  const churchId = process.argv[2] || process.env.CHURCH_ID;
  if (!churchId) {
    console.error('Error: church_id is required. Pass as argv[2] or set CHURCH_ID env var.');
    process.exit(1);
  }

  console.log(`⚠️  Wiping people and families for church_id='${churchId}'`);

  try {
    await Database.transaction(async (conn) => {
      // Count before
      const [indCount] = await conn.query(
        'SELECT COUNT(*) AS c FROM individuals WHERE church_id = ?',
        [churchId]
      );
      const [famCount] = await conn.query(
        'SELECT COUNT(*) AS c FROM families WHERE church_id = ?',
        [churchId]
      );
      console.log(`Found ${indCount.c} individuals and ${famCount.c} families to delete`);

      // Delete individuals first (cascades remove gathering_lists and attendance_records)
      const delInd = await conn.query(
        'DELETE FROM individuals WHERE church_id = ?',
        [churchId]
      );
      console.log(`Deleted individuals rows: ${delInd.affectedRows}`);

      // Then delete families (individuals->family_id was ON DELETE SET NULL)
      const delFam = await conn.query(
        'DELETE FROM families WHERE church_id = ?',
        [churchId]
      );
      console.log(`Deleted families rows: ${delFam.affectedRows}`);
    });

    console.log('✅ Wipe completed successfully');
    process.exit(0);
  } catch (err) {
    console.error('❌ Wipe failed:', err.message);
    process.exit(1);
  }
}

main();


