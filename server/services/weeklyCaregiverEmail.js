const Database = require('../config/database');
const { sendWeeklyCaregiverDigestEmail } = require('../utils/email');

/**
 * For a given church, build a digest for every caregiver who has at least one
 * assigned family member with a consecutive-absence streak >= threshold.
 *
 * Each digest contains `entries`, where each entry is either:
 *   { type: 'family', familyName, minStreak, members: [{ name, streak, gatheringName }] }
 *   { type: 'individual', name, familyName, streak, gatheringName }
 *
 * Families with 2+ absent members are grouped into a single family entry.
 * Families with only 1 absent member produce an individual entry.
 */
async function generateCaregiverDigests(churchId) {
  // --- 0. Load threshold from church settings ---
  const settingsRows = await Database.query(
    `SELECT church_name, caregiver_absence_threshold FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  if (settingsRows.length === 0) return [];
  const threshold = settingsRows[0].caregiver_absence_threshold ?? 3;

  // --- 1. Gather all caregivers for this church (user + contact) ---
  const userCaregivers = await Database.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, fc.family_id
     FROM family_caregivers fc
     JOIN users u ON fc.user_id = u.id
     WHERE fc.caregiver_type = 'user'
       AND u.church_id = ?
       AND u.email IS NOT NULL`,
    [churchId]
  );

  const contactCaregivers = await Database.query(
    `SELECT c.id, c.first_name, c.last_name, c.email, fc.family_id
     FROM family_caregivers fc
     JOIN contacts c ON fc.contact_id = c.id
     WHERE fc.caregiver_type = 'contact'
       AND c.church_id = ?
       AND c.email IS NOT NULL`,
    [churchId]
  );

  const allCaregivers = [
    ...userCaregivers.map(c => ({ ...c, type: 'user' })),
    ...contactCaregivers.map(c => ({ ...c, type: 'contact' })),
  ];

  if (allCaregivers.length === 0) return [];

  // --- 2. Get all unique family IDs ---
  const familyIds = [...new Set(allCaregivers.map(c => c.family_id))];
  const placeholders = familyIds.map(() => '?').join(',');

  // --- 3. Get regular members for those families ---
  const members = await Database.query(
    `SELECT i.id, i.first_name, i.last_name, i.family_id, f.family_name
     FROM individuals i
     JOIN families f ON f.id = i.family_id
     WHERE i.family_id IN (${placeholders})
       AND i.people_type = 'regular'
       AND i.is_active = 1`,
    familyIds
  );

  if (members.length === 0) return [];

  // --- 4. Get the last 12 standard attendance sessions ---
  const sessions = await Database.query(
    `SELECT s.id, s.session_date, s.gathering_type_id, gt.name AS gathering_name
     FROM attendance_sessions s
     JOIN gathering_types gt ON gt.id = s.gathering_type_id
     WHERE s.church_id = ?
       AND gt.attendance_type = 'standard'
       AND s.excluded_from_stats = 0
     ORDER BY s.session_date DESC
     LIMIT 12`,
    [churchId]
  );

  if (sessions.length === 0) return [];

  const sessionIds = sessions.map(s => s.id);
  const sessionPlaceholders = sessionIds.map(() => '?').join(',');

  // --- 5. Get attendance records for those sessions ---
  const attendanceRows = await Database.query(
    `SELECT individual_id, session_id, present
     FROM attendance_records
     WHERE session_id IN (${sessionPlaceholders})
       AND church_id = ?`,
    [...sessionIds, churchId]
  );

  // Build lookup: individualId → Map<sessionId, present>
  const attendanceByPerson = new Map();
  for (const row of attendanceRows) {
    if (!attendanceByPerson.has(row.individual_id)) {
      attendanceByPerson.set(row.individual_id, new Map());
    }
    attendanceByPerson.get(row.individual_id).set(row.session_id, !!row.present);
  }

  // --- 6. Compute consecutive absence streak per member ---
  // Sessions are sorted DESC (most recent first). We walk forward and count
  // sessions where the member was NOT present (present === false OR no record).
  // We break only on an explicit present=true, matching the Reports page logic.
  const memberStreak = new Map(); // individualId → { streak, gatheringName }
  for (const member of members) {
    const attendance = attendanceByPerson.get(member.id) || new Map();
    let streak = 0;
    let lastGatheringName = null;
    for (const session of sessions) {
      const present = attendance.get(session.id);
      if (present === true) {
        break; // attended — streak ends
      }
      // present === false (explicit absence) or undefined (no record) → count as absent
      streak++;
      if (!lastGatheringName) lastGatheringName = session.gathering_name;
    }
    if (streak >= threshold) {
      memberStreak.set(member.id, { streak, gatheringName: lastGatheringName });
    }
  }

  if (memberStreak.size === 0) return [];

  // --- 7. Build entries per family (grouped or individual) ---
  // familyId → [{ name, streak, gatheringName }]
  const absentByFamily = new Map();
  // Also track the family name for display
  const familyNames = new Map(); // familyId → family_name string
  for (const member of members) {
    const streakInfo = memberStreak.get(member.id);
    if (!streakInfo) continue;
    if (!absentByFamily.has(member.family_id)) {
      absentByFamily.set(member.family_id, []);
      familyNames.set(member.family_id, member.family_name);
    }
    absentByFamily.get(member.family_id).push({
      name: `${member.first_name} ${member.last_name}`,
      streak: streakInfo.streak,
      gatheringName: streakInfo.gatheringName,
    });
  }

  if (absentByFamily.size === 0) return [];

  // Convert to typed entries
  const entriesByFamily = new Map(); // familyId → entry object
  for (const [familyId, absentMembers] of absentByFamily.entries()) {
    const rawName = familyNames.get(familyId) || '';
    // Format "SURNAME, A & B" → "Surname family"
    const parts = rawName.split(',');
    const surnameRaw = (parts[0] || rawName).trim();
    const formattedName = surnameRaw
      ? `${surnameRaw.charAt(0).toUpperCase()}${surnameRaw.slice(1).toLowerCase()} family`
      : 'Family';

    if (absentMembers.length > 1) {
      // Sort members by streak desc within the family
      absentMembers.sort((a, b) => b.streak - a.streak);
      entriesByFamily.set(familyId, {
        type: 'family',
        familyName: formattedName,
        minStreak: Math.min(...absentMembers.map(m => m.streak)),
        members: absentMembers,
      });
    } else {
      entriesByFamily.set(familyId, {
        type: 'individual',
        name: absentMembers[0].name,
        familyName: formattedName,
        streak: absentMembers[0].streak,
        gatheringName: absentMembers[0].gatheringName,
      });
    }
  }

  // --- 8. Group by caregiver, deduplicating by email ---
  const digestByEmail = new Map();

  for (const cg of allCaregivers) {
    if (!cg.email) continue;
    const emailKey = cg.email.toLowerCase();

    const entry = entriesByFamily.get(cg.family_id);
    if (!entry) continue;

    if (!digestByEmail.has(emailKey)) {
      digestByEmail.set(emailKey, {
        caregiver: { email: cg.email, first_name: cg.first_name, last_name: cg.last_name },
        entries: [],
      });
    }

    const digest = digestByEmail.get(emailKey);
    // Deduplicate entries by family name (in case caregiver appears via both user + contact rows)
    const alreadyAdded = digest.entries.some(e => {
      if (entry.type === 'family') return e.type === 'family' && e.familyName === entry.familyName;
      return e.type === 'individual' && e.name === entry.name;
    });
    if (!alreadyAdded) digest.entries.push(entry);
  }

  // Sort entries within each digest: families first (by minStreak), then individuals (by streak)
  for (const digest of digestByEmail.values()) {
    digest.entries.sort((a, b) => {
      const aStreak = a.type === 'family' ? a.minStreak : a.streak;
      const bStreak = b.type === 'family' ? b.minStreak : b.streak;
      return bStreak - aStreak;
    });
  }

  return [...digestByEmail.values()].filter(d => d.entries.length > 0);
}

/**
 * Generate digests and send one email per caregiver.
 * Returns the number of emails sent.
 */
async function sendWeeklyCaregiverDigests(churchId) {
  let sent = 0;
  try {
    const settings = await Database.query(
      `SELECT church_name FROM church_settings WHERE church_id = ? LIMIT 1`,
      [churchId]
    );
    if (settings.length === 0) return 0;
    const churchName = settings[0].church_name;

    const digests = await generateCaregiverDigests(churchId);

    for (const digest of digests) {
      try {
        await sendWeeklyCaregiverDigestEmail(
          digest.caregiver.email,
          digest.caregiver.first_name,
          churchName,
          digest.entries
        );
        sent++;
      } catch (err) {
        console.error(`Caregiver digest: Failed to send to ${digest.caregiver.email}:`, err.message);
      }
    }

    if (sent > 0) {
      console.log(`Caregiver digest: Sent ${sent} email(s) for church ${churchId}`);
    }
  } catch (err) {
    console.error(`Caregiver digest: Error for church ${churchId}:`, err.message);
  }
  return sent;
}

module.exports = { generateCaregiverDigests, sendWeeklyCaregiverDigests };
