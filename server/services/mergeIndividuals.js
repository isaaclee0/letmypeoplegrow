// These helpers run on the caller's transaction. The route validates participants
// and rehomes engagement history on that same connection before deleting people.
function conflict(code, message) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

const PERSON_REFERENCES = [
  ['attendance_records', 'individual_id'],
  ['gathering_lists', 'individual_id'],
  ['external_person_links', 'individual_id'],
  ['people_sync_match_exclusions', 'individual_id'],
  ['kiosk_checkins', 'individual_id'],
  ['absence_dismissals', 'individual_id'],
  ['contact_notifications', 'individual_id'],
  ['engagement_decline_events', 'individual_id'],
  ['engagement_evaluation_state', 'individual_id'],
  ['engagement_tier_state', 'individual_id'],
  ['engagement_tier_transitions', 'individual_id'],
  ['pastoral_insight_states', 'subject_id'],
];

async function assertReferencesBelongToChurch(conn, churchId, involvedIds) {
  // Integrity checks deliberately look outside churchId: legacy FKs reference
  // individuals(id) alone, so a cascade could otherwise delete another church's row.
  for (const [table, column] of PERSON_REFERENCES) {
    const rows = await conn.query(
      `SELECT 1 FROM ${table} WHERE ${column} IN (?) AND (church_id IS NULL OR church_id <> ?) LIMIT 1`,
      [involvedIds, churchId],
    );
    if (rows.length) throw conflict('CROSS_CHURCH_MERGE_REFERENCE', 'A related record belongs to a different church. No people were merged.');
  }
  // Also defend relationships whose own church_id looks correct but whose
  // session/gathering/family belongs elsewhere in a malformed legacy database.
  const relationships = [
    ['attendance_records', 'individual_id', 'attendance_sessions', 'session_id'],
    ['gathering_lists', 'individual_id', 'gathering_types', 'gathering_type_id'],
    ['kiosk_checkins', 'individual_id', 'gathering_types', 'gathering_type_id'],
    ['absence_dismissals', 'individual_id', 'gathering_types', 'gathering_type_id'],
    ['individuals', 'id', 'families', 'family_id'],
  ];
  for (const [table, column, parent, parentColumn] of relationships) {
    const rows = await conn.query(
      `SELECT 1 FROM ${table} r JOIN ${parent} p ON p.id = r.${parentColumn}
       WHERE r.church_id = ? AND r.${column} IN (?) AND (p.church_id IS NULL OR p.church_id <> ?) LIMIT 1`,
      [churchId, involvedIds, churchId],
    );
    if (rows.length) throw conflict('CROSS_CHURCH_MERGE_REFERENCE', 'A related record belongs to a different church. No people were merged.');
  }
  for (const [table, eventColumn] of [
    ['engagement_decline_deliveries', 'event_id'],
    ['pastoral_insight_states', 'decline_event_id'],
    ['engagement_tier_transitions', 'decline_event_id'],
  ]) {
    const rows = await conn.query(
      `SELECT 1 FROM ${table} r JOIN engagement_decline_events e ON e.id = r.${eventColumn}
       WHERE e.church_id = ? AND e.individual_id IN (?) AND r.church_id <> ? LIMIT 1`,
      [churchId, involvedIds, churchId],
    );
    if (rows.length) throw conflict('CROSS_CHURCH_MERGE_REFERENCE', 'Engagement history references a different church. No people were merged.');
  }
}

async function compatibleProviderIdentities(conn, churchId, people) {
  const ids = people.map(person => person.id);
  const links = await conn.query('SELECT * FROM external_person_links WHERE church_id = ? AND individual_id IN (?) ORDER BY id', [churchId, ids]);
  const identities = new Map();
  const addIdentity = (provider, id) => {
    if (!id) return;
    if (identities.has(provider) && identities.get(provider) !== String(id)) {
      const name = provider === 'planning_center' ? 'Planning Center' : 'Elvanto';
      throw conflict('INCOMPATIBLE_PROVIDER_IDENTITIES', `These records link to different ${name} people. Correct the provider links in sync review before merging.`);
    }
    identities.set(provider, String(id));
  };
  for (const link of links) addIdentity(link.provider, link.external_person_id);
  for (const person of people) addIdentity('planning_center', person.planning_center_id);
  for (const [provider, externalId] of identities) {
    const outsideLinks = await conn.query(
      `SELECT 1 FROM external_person_links WHERE church_id = ? AND provider = ? AND external_person_id = ? AND individual_id NOT IN (?)`,
      [churchId, provider, externalId, ids],
    );
    const outsideLegacy = provider === 'planning_center' ? await conn.query(
      'SELECT 1 FROM individuals WHERE church_id = ? AND planning_center_id = ? AND id NOT IN (?)', [churchId, externalId, ids],
    ) : [];
    if (outsideLinks.length || outsideLegacy.length) {
      throw conflict('INCOMPATIBLE_PROVIDER_IDENTITIES', 'A provider identity is linked to another person outside this merge. Correct the provider links in sync review first.');
    }
  }
  return { identities, links };
}

const attendanceStrength = row => row.present === 1 ? 2 : row.present === 0 ? 1 : 0;

async function writeMergedAttendance(conn, row) {
  // There are no foreign keys to attendance_records. Reinsert the same row ID
  // so its unconditional AFTER UPDATE timestamp trigger does not turn a merge
  // into a new attendance observation and overwrite the original evidence time.
  await conn.query(`INSERT OR REPLACE INTO attendance_records
    (id, session_id, individual_id, present, eligible_at_snapshot, people_type_at_time, updated_by, updated_at, church_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [row.id, row.session_id, row.individual_id, row.present, row.eligible_at_snapshot,
    row.people_type_at_time, row.updated_by, row.updated_at, row.church_id]);
}

async function rehomeAttendance(conn, { churchId, keepId, deleteIds }) {
  const records = await conn.query('SELECT * FROM attendance_records WHERE church_id = ? AND individual_id IN (?) ORDER BY id', [churchId, deleteIds]);
  for (const row of records) {
    const [existing] = await conn.query('SELECT * FROM attendance_records WHERE church_id = ? AND individual_id = ? AND session_id = ?', [churchId, keepId, row.session_id]);
    if (!existing) {
      await writeMergedAttendance(conn, { ...row, individual_id: keepId });
      continue;
    }
    const stronger = attendanceStrength(row) > attendanceStrength(existing)
      || (attendanceStrength(row) === attendanceStrength(existing) && row.updated_at > existing.updated_at);
    const evidence = stronger ? row : existing;
    await writeMergedAttendance(conn, {
      ...existing,
      present: evidence.present,
      eligible_at_snapshot: Number(Boolean(row.eligible_at_snapshot || existing.eligible_at_snapshot)),
      people_type_at_time: evidence.people_type_at_time ?? existing.people_type_at_time ?? row.people_type_at_time,
      updated_by: evidence.updated_by,
      updated_at: evidence.updated_at,
    });
    await conn.query('DELETE FROM attendance_records WHERE church_id = ? AND id = ?', [churchId, row.id]);
  }
}

async function rehomeGatherings(conn, { churchId, keepId, deleteIds, mergeAssignments }) {
  if (mergeAssignments) {
    const rows = await conn.query('SELECT * FROM gathering_lists WHERE church_id = ? AND individual_id IN (?) ORDER BY id', [churchId, deleteIds]);
    for (const row of rows) {
      const [existing] = await conn.query('SELECT id, added_by_sync_batch_id, added_by_pco_batch_id FROM gathering_lists WHERE church_id = ? AND individual_id = ? AND gathering_type_id = ?', [churchId, keepId, row.gathering_type_id]);
      if (!existing) {
        await conn.query('UPDATE gathering_lists SET individual_id = ? WHERE church_id = ? AND id = ?', [keepId, churchId, row.id]);
      } else if (row.added_by_sync_batch_id == null && row.added_by_pco_batch_id == null
        && (existing.added_by_sync_batch_id != null || existing.added_by_pco_batch_id != null)) {
        // Manual membership on either person must protect the merged assignment
        // from unattended removal. Legacy PCO ownership counts as sync ownership;
        // clear both columns and retain the manual addition's original provenance.
        await conn.query(`UPDATE gathering_lists
          SET added_by_sync_batch_id = NULL, added_by_pco_batch_id = NULL, added_by = ?, added_at = ?
          WHERE church_id = ? AND id = ?`, [row.added_by, row.added_at, churchId, existing.id]);
      }
    }
  }
  await conn.query('DELETE FROM gathering_lists WHERE church_id = ? AND individual_id IN (?)', [churchId, deleteIds]);
}

async function rehomeMatchExclusions(conn, { churchId, keepId, deleteIds }) {
  const rows = await conn.query('SELECT * FROM people_sync_match_exclusions WHERE church_id = ? AND individual_id IN (?) ORDER BY id', [churchId, deleteIds]);
  for (const row of rows) {
    const [existing] = await conn.query(
      'SELECT * FROM people_sync_match_exclusions WHERE church_id = ? AND provider = ? AND external_person_id = ? AND individual_id = ?',
      [churchId, row.provider, row.external_person_id, keepId],
    );
    if (!existing) {
      await conn.query('UPDATE people_sync_match_exclusions SET individual_id = ? WHERE church_id = ? AND id = ?', [keepId, churchId, row.id]);
    } else {
      await conn.query('DELETE FROM people_sync_match_exclusions WHERE church_id = ? AND id = ?', [churchId, row.id]);
    }
  }
}

async function rehomeDismissals(conn, { churchId, keepId, deleteIds }) {
  const rows = await conn.query('SELECT * FROM absence_dismissals WHERE church_id = ? AND individual_id IN (?) ORDER BY id', [churchId, deleteIds]);
  for (const row of rows) {
    const [existing] = await conn.query('SELECT * FROM absence_dismissals WHERE church_id = ? AND individual_id = ? AND gathering_type_id = ?', [churchId, keepId, row.gathering_type_id]);
    if (!existing) {
      await conn.query('UPDATE absence_dismissals SET individual_id = ? WHERE church_id = ? AND id = ?', [keepId, churchId, row.id]);
    } else {
      if (row.created_at > existing.created_at || (row.created_at === existing.created_at && row.dismissed_at_streak > existing.dismissed_at_streak)) {
        await conn.query('UPDATE absence_dismissals SET dismissed_at_streak = ?, dismissed_by = ?, created_at = ? WHERE church_id = ? AND id = ?', [row.dismissed_at_streak, row.dismissed_by, row.created_at, churchId, existing.id]);
      }
      await conn.query('DELETE FROM absence_dismissals WHERE church_id = ? AND id = ?', [churchId, row.id]);
    }
  }
}

async function rehomeProviderIdentities(conn, { churchId, keepId, deleteIds }, people, { identities, links }) {
  for (const link of links) {
    if (Number(link.individual_id) !== keepId) {
      await conn.query('UPDATE external_person_links SET individual_id = ?, updated_at = datetime(\'now\') WHERE church_id = ? AND id = ?', [keepId, churchId, link.id]);
    }
  }
  const planningCenterId = identities.get('planning_center');
  if (!planningCenterId) return;
  const linked = links.find(link => link.provider === 'planning_center');
  if (!linked) {
    await conn.query(`INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source)
      VALUES (?, 'planning_center', ?, ?, 'legacy_backfill')`, [churchId, planningCenterId, keepId]);
  }
  const providerPeople = people.filter(person => person.id === linked?.individual_id
    || person.planning_center_id === planningCenterId);
  // A merge is not a fresh provider read: retain known notes and do not upgrade
  // a background-check flag when either copy has an explicit negative value.
  const hasMedicalNotes = Number(providerPeople.some(person => person.pco_has_medical_notes));
  const backgroundCheck = providerPeople.some(person => person.pco_background_check_cleared === 0) ? 0
    : providerPeople.some(person => person.pco_background_check_cleared === 1) ? 1 : null;
  // Clear the duplicate's compatibility column before assigning the unique ID.
  await conn.query('UPDATE individuals SET planning_center_id = NULL WHERE church_id = ? AND id IN (?)', [churchId, deleteIds]);
  await conn.query(`UPDATE individuals SET planning_center_id = ?, pco_link_declined = 0,
      pco_has_medical_notes = ?, pco_background_check_cleared = ? WHERE church_id = ? AND id = ?`,
  [planningCenterId, hasMedicalNotes, backgroundCheck, churchId, keepId]);
}

async function mergeIndividualReferencesWithConnection(conn, options) {
  const { churchId, keepId, deleteIds } = options;
  const involvedIds = [keepId, ...deleteIds];
  await assertReferencesBelongToChurch(conn, churchId, involvedIds);
  const people = await conn.query('SELECT * FROM individuals WHERE church_id = ? AND id IN (?)', [churchId, involvedIds]);
  const providerIdentities = await compatibleProviderIdentities(conn, churchId, people);
  await rehomeAttendance(conn, options);
  await rehomeGatherings(conn, options);
  await rehomeMatchExclusions(conn, options);
  await rehomeDismissals(conn, options);
  for (const table of ['kiosk_checkins', 'contact_notifications']) {
    await conn.query(`UPDATE ${table} SET individual_id = ? WHERE church_id = ? AND individual_id IN (?)`, [keepId, churchId, deleteIds]);
  }
  await rehomeProviderIdentities(conn, options, people, providerIdentities);
  const [attendance] = await conn.query(`SELECT MAX(s.session_date) AS last_date FROM attendance_records r
    JOIN attendance_sessions s ON s.id = r.session_id AND s.church_id = r.church_id
    WHERE r.church_id = ? AND r.individual_id = ? AND r.present = 1`, [churchId, keepId]);
  const lastDate = [...people.map(person => person.last_attendance_date), attendance.last_date].filter(Boolean).sort().at(-1) || null;
  await conn.query('UPDATE individuals SET last_attendance_date = ? WHERE church_id = ? AND id = ?', [lastDate, churchId, keepId]);
}

module.exports = { mergeIndividualReferencesWithConnection };
