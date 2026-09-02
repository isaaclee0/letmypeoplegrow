/*
  Usage:
    node server/scripts/wipeChurchPeopleAndFamilies.js <church_id>

  Deletes all individuals, families, and their engagement history for the given church_id.
  Most dependent rows are removed via cascading FKs; RESTRICT-protected engagement
  audit rows are intentionally removed first because this script is a destructive wipe.
*/

const Database = require('../config/database');

function crossChurchTierReferenceError() {
  return Object.assign(
    new Error('CROSS_CHURCH_TIER_REFERENCE: tier rows carry a different church ID.'),
    { code: 'CROSS_CHURCH_TIER_REFERENCE' },
  );
}

async function assertNoCrossChurchTierReferences(conn, churchId) {
  // Intentionally inspect non-matching child church IDs before parent deletion.
  const [result] = await conn.query(
    `SELECT EXISTS(
       SELECT 1
       FROM engagement_tier_state state
       JOIN individuals person ON person.id = state.individual_id
       WHERE person.church_id = ? AND state.church_id <> ?
     ) OR EXISTS(
       SELECT 1
       FROM engagement_tier_transitions transition_row
       JOIN individuals person ON person.id = transition_row.individual_id
       WHERE person.church_id = ? AND transition_row.church_id <> ?
     ) AS hasForeignTierReferences`,
    [churchId, churchId, churchId, churchId],
  );
  if (Number(result.hasForeignTierReferences) === 1) {
    throw crossChurchTierReferenceError();
  }
}

async function main() {
  const churchId = process.argv[2] || process.env.CHURCH_ID;
  if (!churchId) {
    console.error('Error: church_id is required. Pass as argv[2] or set CHURCH_ID env var.');
    process.exit(1);
  }

  console.log(`⚠️  Wiping people and families for church_id='${churchId}'`);

  try {
    Database.initialize();
    await Database.transactionForChurch(churchId, async (conn) => {
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

      await assertNoCrossChurchTierReferences(conn, churchId);

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
