/*
  Usage:
    node server/scripts/wipeChurchPeopleAndFamilies.js <church_id>

  Deletes all individuals, families, and their engagement history for the given church_id.
  Most dependent rows are removed via cascading FKs; RESTRICT-protected engagement
  audit rows are intentionally removed first because this script is a destructive wipe.
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

      await conn.query('DELETE FROM pastoral_insight_states WHERE church_id = ?', [churchId]);
      await conn.query('DELETE FROM engagement_decline_deliveries WHERE church_id = ?', [churchId]);
      await conn.query('DELETE FROM engagement_tier_transitions WHERE church_id = ?', [churchId]);
      await conn.query('DELETE FROM engagement_decline_events WHERE church_id = ?', [churchId]);
      await conn.query('DELETE FROM engagement_evaluation_state WHERE church_id = ?', [churchId]);
      await conn.query('DELETE FROM engagement_tier_state WHERE church_id = ?', [churchId]);

      // Delete individuals after their protected audit history.
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
