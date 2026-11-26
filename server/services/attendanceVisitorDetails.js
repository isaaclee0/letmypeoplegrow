const { createHash } = require('node:crypto');
const {
  getAuthorityWithConnection, getPeopleSyncPolicyWithConnection, getManagedLinks,
  getManagedFamilyIds, isPersonLocked,
} = require('./peopleSync/authority');
const { ensureSessionWithConnection, finalizeStandardSessionWithConnection } = require('./attendanceSessionState');

const visitorTypes = ['local_visitor', 'traveller_visitor'];
function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

async function readVisitorDetails(conn, { churchId, gatheringTypeId, sessionDate, visitorId, recentDates }) {
  // The clicked person selects the household even in an ungrouped or filtered roster.
  const rows = await conn.query(`
    SELECT i.id, i.first_name, i.last_name, i.is_child, i.people_type, i.is_active,
           f.id AS family_id, f.family_name, f.family_notes, f.family_type,
           (EXISTS (SELECT 1 FROM gathering_lists gl WHERE gl.church_id = i.church_id
                     AND gl.individual_id = i.id AND gl.gathering_type_id = ?)
            OR EXISTS (SELECT 1 FROM attendance_records ar JOIN attendance_sessions s
                         ON s.id = ar.session_id AND s.church_id = ar.church_id
                       WHERE ar.church_id = i.church_id AND ar.individual_id = i.id
                         AND s.gathering_type_id = ? AND s.session_date = ?)) AS in_gathering,
           (SELECT MAX(s.session_date) FROM attendance_records ar JOIN attendance_sessions s
              ON s.id = ar.session_id AND s.church_id = ar.church_id
            WHERE ar.church_id = i.church_id AND ar.individual_id = i.id AND ar.present = 1
              AND s.gathering_type_id = ? AND s.excluded_from_stats = 0 AND s.session_date <= ?) AS last_present
    FROM individuals anchor
    JOIN individuals i ON i.church_id = anchor.church_id AND (i.id = anchor.id OR i.family_id = anchor.family_id)
    LEFT JOIN families f ON f.id = i.family_id AND f.church_id = i.church_id
    WHERE anchor.church_id = ? AND anchor.id = ?
    ORDER BY i.id`, [gatheringTypeId, gatheringTypeId, sessionDate, gatheringTypeId, sessionDate, churchId, visitorId]);
  const visitors = rows.filter(row => {
    const dates = row.people_type === 'local_visitor' ? recentDates?.localDates : recentDates?.travellerDates;
    return row.is_active && visitorTypes.includes(row.people_type) && (row.in_gathering || dates?.has(row.last_present));
  });
  const anchor = visitors.find(row => row.id === visitorId);
  if (!anchor) reject(404, 'This person is no longer an editable visitor at this gathering.');

  const { active } = await getAuthorityWithConnection(conn, churchId);
  const { peopleEditingLocked } = await getPeopleSyncPolicyWithConnection(conn, churchId);
  const lockedProvider = peopleEditingLocked ? active : 'none';
  const links = lockedProvider === 'none' ? new Map() : await getManagedLinks(churchId, visitors.map(row => row.id));
  const familyId = anchor.family_id;
  const lockedFamilies = await getManagedFamilyIds(churchId, familyId ? [familyId] : [], lockedProvider);
  const notesEditable = familyId
    ? visitorTypes.includes(anchor.family_type) && rows.every(row => !row.is_active || visitors.includes(row))
    : !isPersonLocked(lockedProvider, links.get(visitorId));
  const familyEditable = notesEditable && !lockedFamilies.has(familyId);
  const details = {
    familyId, familyName: anchor.family_name || '', notes: anchor.family_notes || '',
    peopleType: visitorTypes.includes(anchor.family_type) ? anchor.family_type : anchor.people_type,
    familyEditable, notesEditable,
    people: visitors.map(row => ({
      id: row.id, firstName: row.first_name, lastName: row.last_name === 'Unknown' ? '' : row.last_name,
      isChild: Boolean(row.is_child), locked: isPersonLocked(lockedProvider, links.get(row.id)),
    })),
  };
  const revision = createHash('sha256').update(JSON.stringify([details, visitors.map(row => row.people_type)])).digest('hex');
  return { ...details, revision };
}

async function saveVisitorDetails(conn, context, body) {
  const { churchId, gatheringTypeId, sessionDate, actorId, visitorId, role } = context;
  const previous = visitorId ? await readVisitorDetails(conn, context) : null;
  if (previous && body.revision !== previous.revision) {
    reject(409, 'These details changed since you opened them. Reopen the visitor to see the latest details.');
  }
  const { people, peopleType, familyName, notes } = body;
  const previousPeople = previous?.people || [];
  if (!Array.isArray(people) || !people.length || people.length > Math.max(10, previousPeople.length) ||
      !visitorTypes.includes(peopleType) || typeof notes !== 'string' || typeof familyName !== 'string' ||
      (!previous && !familyName.trim())) {
    reject(400, 'Enter a visitor name and valid family details.');
  }
  if (people.some(p => !p || typeof p.firstName !== 'string' || !p.firstName.trim() ||
      typeof p.lastName !== 'string' || typeof p.isChild !== 'boolean' ||
      (p.id !== undefined && !Number.isSafeInteger(p.id)))) {
    reject(400, 'Check each visitor’s name and age group.');
  }
  const existing = new Map(previousPeople.map(p => [p.id, p]));
  const ids = people.filter(p => p.id !== undefined).map(p => p.id);
  if (ids.length !== existing.size || new Set(ids).size !== ids.length || ids.some(id => !existing.has(id))) {
    reject(400, 'The submitted people do not match this visitor family.');
  }
  const familyChanged = previous && (familyName !== previous.familyName || peopleType !== previous.peopleType);
  const additions = people.filter(p => p.id === undefined);
  if ((role === 'attendance_taker' && peopleType !== (previous?.peopleType || 'local_visitor')) ||
      (previous && ((!previous.notesEditable && notes !== previous.notes) ||
        (!previous.familyEditable && (familyChanged || additions.length))))) {
    reject(403, 'These family details cannot be changed from this gathering.');
  }
  for (const p of people) {
    const old = existing.get(p.id);
    if (old?.locked && (old.firstName !== p.firstName.trim() || old.lastName !== p.lastName.trim() ||
        old.isChild !== p.isChild || peopleType !== previous.peopleType)) {
      reject(403, 'This visitor is managed by your people integration.');
    }
  }

  let familyId = previous?.familyId;
  if (!familyId && (!previous || familyChanged || notes.trim() || additions.length)) {
    const result = await conn.query(`INSERT INTO families (family_name, family_notes, family_type, created_by, church_id)
      VALUES (?, ?, ?, ?, ?)`, [familyName.trim() || people[0].firstName.trim(), notes.trim() || null, peopleType, actorId, churchId]);
    familyId = Number(result.insertId);
  } else if (familyId && (familyChanged || notes !== previous.notes)) {
    await conn.query('UPDATE families SET family_name = ?, family_notes = ?, family_type = ? WHERE id = ? AND church_id = ?',
      [familyName.trim(), notes.trim() || null, peopleType, familyId, churchId]);
  }
  for (const p of people.filter(p => existing.has(p.id))) {
    const old = existing.get(p.id);
    if (p.firstName.trim() === old.firstName && p.lastName.trim() === old.lastName && p.isChild === old.isChild &&
        previous.familyId === familyId && previous.peopleType === peopleType) continue;
    await conn.query(`UPDATE individuals SET first_name = ?, last_name = ?, is_child = ?, family_id = ?,
      people_type = CASE WHEN ? THEN ? ELSE people_type END WHERE id = ? AND church_id = ?`,
      [p.firstName.trim(), p.lastName.trim(), Number(p.isChild), familyId, Number(previous.peopleType !== peopleType), peopleType, p.id, churchId]);
  }

  let firstId = visitorId;
  if (additions.length) {
    const session = await ensureSessionWithConnection(conn, context);
    await finalizeStandardSessionWithConnection(conn, { churchId, gatheringTypeId, sessionId: session.id });
    for (const p of additions) {
      const result = await conn.query(`INSERT INTO individuals
        (first_name, last_name, family_id, is_child, people_type, last_attendance_date, created_by, church_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [p.firstName.trim(), p.lastName.trim(), familyId, Number(p.isChild), peopleType, sessionDate, actorId, churchId]);
      const id = Number(result.insertId);
      firstId ??= id;
      await conn.query('INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id) VALUES (?, ?, ?, ?)',
        [gatheringTypeId, id, actorId, churchId]);
      await conn.query('INSERT INTO attendance_records (session_id, individual_id, present, people_type_at_time, church_id) VALUES (?, ?, 1, ?, ?)',
        [session.id, id, peopleType, churchId]);
    }
    await conn.query('UPDATE families SET last_attended = MAX(COALESCE(last_attended, ?), ?) WHERE id = ? AND church_id = ?',
      [sessionDate, sessionDate, familyId, churchId]);
  }
  return readVisitorDetails(conn, { ...context, visitorId: firstId });
}

module.exports = { readVisitorDetails, saveVisitorDetails };
