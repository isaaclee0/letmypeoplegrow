'use strict';

const { addDateOnly, getChurchDate, loadChurchTimeZone } = require('../utils/churchTime');

const CATEGORIES = [
  { key: 'priority', label: 'Priority follow-up', action: 'Check whether someone has connected; offer a personal invitation.' },
  { key: 'followUp', label: 'Follow up', action: 'Check in warmly before the next gathering.' },
  { key: 'welcome', label: 'Welcome', action: 'Thank them for visiting and invite them back.' },
  { key: 'returned', label: 'Encouraging return', action: 'Welcome them by name and help them meet someone.' },
];
const rank = (category) => CATEGORIES.findIndex(c => c.key === category);
function weekStart(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDateOnly(date, { days: -((day + 6) % 7) });
}
function completedWeekEnd(now, timezone) {
  return addDateOnly(weekStart(getChurchDate(now, timezone)), { days: -1 });
}

// Positive attendance is evidence of a return even when a roster is incomplete.
// Negative evidence requires a held, snapshotted session in the original gathering.
function buildVisitorFollowUp(source, asOf, gatheringIds = []) {
  const start = weekStart(asOf);
  const cutoff = addDateOnly(start, { days: -14 });
  const sessions = source.sessions.filter(s => s.date <= asOf && s.attendanceType === 'standard'
    && s.sessionStatus !== 'cancelled' && !Number(s.excludedFromStats));
  const bySession = new Map(sessions.map(s => [s.id, s]));
  const visitsByPerson = new Map();
  for (const r of source.records) {
    const s = bySession.get(r.sessionId);
    if (!s || !Number(r.present)) continue;
    if (!visitsByPerson.has(r.individualId)) visitsByPerson.set(r.individualId, []);
    visitsByPerson.get(r.individualId).push({ ...s, peopleTypeAtTime: r.peopleTypeAtTime });
  }
  const groups = new Map();
  for (const p of source.people) {
    if (!Number(p.isActive) || p.peopleType === 'traveller_visitor') continue;
    const visits = (visitsByPerson.get(p.id) || []).sort((a,b) => a.date.localeCompare(b.date) || a.id-b.id);
    if (!visits.length) continue;
    const first = visits[0];
    if ((first.peopleTypeAtTime || p.peopleType) !== 'local_visitor') continue;
    if (gatheringIds.length && !visits.some(v => gatheringIds.includes(v.gatheringId))) continue;
    const latest = visits[visits.length-1];
    const visitCount = new Set(visits.map(v => v.date)).size;
    const firstWeek = weekStart(first.date);
    const initialGatherings = new Set(visits.filter(v => v.date === first.date).map(v => v.gatheringId));
    const missedWeeks = new Set(sessions.filter(s => initialGatherings.has(s.gatheringId)
      && s.date >= addDateOnly(firstWeek,{days:7}) && s.date <= addDateOnly(firstWeek,{days:20})
      && s.sessionStatus === 'held' && (Number(s.rosterProvenanceVersion) >= 1 || Number(s.rosterSnapshotted) === 1)
    ).map(s => weekStart(s.date)));
    let category;
    if (first.date >= start) category = 'welcome';
    else if (latest.date >= start && visitCount >= 2 && visitCount <= 3) category = 'returned';
    else if (firstWeek >= cutoff && visitCount === 1 && missedWeeks.size > 0) {
      category = missedWeeks.size >= 2 ? 'priority' : 'followUp';
    }
    if (!category) continue;
    const key = p.familyId ? `family:${p.familyId}` : `person:${p.id}`;
    if (!groups.has(key)) groups.set(key, {
      key, familyId: p.familyId || null, familyName: p.familyName || null, category, members: [],
      caregivers: (source.caregivers || []).filter(c => c.familyId === p.familyId).map(c => c.name),
      contactStatus: 'unknown',
    });
    const group = groups.get(key);
    if (rank(category) < rank(group.category)) group.category = category;
    group.members.push({ individualId: p.id, name: `${p.firstName} ${p.lastName}`, category,
      firstVisitDate: first.date, latestVisitDate: latest.date, firstGatheringName: first.gatheringName,
      latestGatheringName: latest.gatheringName, visitCount,
      missedOpportunities: visitCount === 1 ? missedWeeks.size : 0 });
  }
  return { asOf, weekStart: start, categories: CATEGORIES, groups: [...groups.values()]
    .sort((a,b) => rank(a.category)-rank(b.category) || a.members[0].name.localeCompare(b.members[0].name)) };
}

async function getVisitorFollowUp(churchId, { now = new Date(), gatheringIds = [] } = {}) {
  if (!churchId) throw new Error('Church context is required.');
  const Database = require('../config/database');
  const asOf = completedWeekEnd(now, await loadChurchTimeZone(churchId));
  const query = (sql, params) => Database.queryForChurch(churchId, sql, params);
  const [people, sessions, records, caregivers] = await Promise.all([
    query(`SELECT i.id, i.first_name AS firstName, i.last_name AS lastName, i.people_type AS peopleType,
      i.is_active AS isActive, i.family_id AS familyId, f.family_name AS familyName
      FROM individuals i LEFT JOIN families f ON f.id=i.family_id AND f.church_id=i.church_id
      WHERE i.church_id=?`, [churchId]),
    query(`SELECT s.id, s.session_date AS date, s.gathering_type_id AS gatheringId, gt.name AS gatheringName,
      gt.attendance_type AS attendanceType, s.session_status AS sessionStatus,
      s.excluded_from_stats AS excludedFromStats, s.roster_snapshotted AS rosterSnapshotted,
      s.roster_provenance_version AS rosterProvenanceVersion
      FROM attendance_sessions s JOIN gathering_types gt ON gt.id=s.gathering_type_id AND gt.church_id=s.church_id
      WHERE s.church_id=? AND s.session_date<=? AND gt.attendance_type='standard'`, [churchId, asOf]),
    query(`SELECT ar.individual_id AS individualId, ar.session_id AS sessionId, ar.present,
      ar.people_type_at_time AS peopleTypeAtTime FROM attendance_records ar
      JOIN attendance_sessions s ON s.id=ar.session_id AND s.church_id=ar.church_id
      WHERE ar.church_id=? AND ar.present=1 AND s.session_date<=?`, [churchId, asOf]),
    query(`SELECT fc.family_id AS familyId,
      CASE fc.caregiver_type WHEN 'user' THEN u.first_name || ' ' || u.last_name ELSE c.first_name || ' ' || c.last_name END AS name
      FROM family_caregivers fc
      LEFT JOIN users u ON fc.caregiver_type='user' AND u.id=fc.user_id AND u.church_id=fc.church_id AND u.is_active=1
      LEFT JOIN contacts c ON fc.caregiver_type='contact' AND c.id=fc.contact_id AND c.church_id=fc.church_id AND c.is_active=1
      WHERE fc.church_id=? AND (u.id IS NOT NULL OR c.id IS NOT NULL)`, [churchId]),
  ]);
  return buildVisitorFollowUp({people,sessions,records,caregivers},asOf,gatheringIds);
}

function describeMember(member) {
  const evidence = member.category === 'welcome' ? 'First recorded visit'
    : member.category === 'returned' ? `Visit ${member.visitCount}; returned at ${member.latestGatheringName}`
    : `No return recorded over ${member.missedOpportunities} completed weekly ${member.missedOpportunities === 1 ? 'opportunity' : 'opportunities'}`;
  return `${member.name}: ${evidence}. First: ${member.firstVisitDate} (${member.firstGatheringName}); latest: ${member.latestVisitDate}.`;
}
module.exports = { buildVisitorFollowUp, getVisitorFollowUp, completedWeekEnd, describeMember, CATEGORIES };
