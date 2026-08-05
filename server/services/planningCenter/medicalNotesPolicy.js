const Database = require('../../config/database');

const MEDICAL_NOTE_ICONS = new Set([
  'person', 'star', 'heart', 'sparkles', 'fire', 'sun',
  'moon', 'bolt', 'music', 'flag', 'trophy', 'book',
]);
const ALLOWED_BY_MINIMUM = Object.freeze({
  admin: new Set(['admin']),
  coordinator: new Set(['admin', 'coordinator']),
  attendance_taker: new Set(['admin', 'coordinator', 'attendance_taker']),
});
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function policyError(code, message = 'Invalid medical-note indicator settings') {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.status = 400;
  return error;
}

function roleCanViewMedicalNotes(minimumRole, userRole) {
  return ALLOWED_BY_MINIMUM[minimumRole]?.has(userRole) === true;
}

function normalizeMedicalNoteColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR.test(value.trim())) {
    throw policyError('MEDICAL_NOTES_COLOR_INVALID');
  }
  return value.trim().toLowerCase();
}

function normalizeMedicalNotesInput(input = {}) {
  const enabled = input.enabled === true;
  const minimumRole = input.minimumRole;
  if (!Object.hasOwn(ALLOWED_BY_MINIMUM, minimumRole)) {
    throw policyError('MEDICAL_NOTES_ROLE_INVALID');
  }
  if (!Array.isArray(input.gatheringTypeIds)) {
    throw policyError('MEDICAL_NOTES_GATHERINGS_INVALID');
  }
  const gatheringTypeIds = [...new Set(input.gatheringTypeIds.map(Number))].sort((a, b) => a - b);
  if (gatheringTypeIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw policyError('MEDICAL_NOTES_GATHERINGS_INVALID');
  }
  const badgeIcon = input.badgeIcon == null || input.badgeIcon === '' ? null : String(input.badgeIcon);
  const badgeColor = input.badgeColor == null || input.badgeColor === '' ? null : normalizeMedicalNoteColor(input.badgeColor);
  if (badgeIcon !== null && !MEDICAL_NOTE_ICONS.has(badgeIcon)) {
    throw policyError('MEDICAL_NOTES_ICON_INVALID');
  }
  if (enabled && gatheringTypeIds.length === 0) throw policyError('MEDICAL_NOTES_GATHERINGS_REQUIRED');
  if (enabled && !badgeIcon) throw policyError('MEDICAL_NOTES_ICON_REQUIRED');
  if (enabled && !badgeColor) throw policyError('MEDICAL_NOTES_COLOR_REQUIRED');
  return {
    enabled,
    minimumRole,
    gatheringTypeIds,
    badgeIcon,
    badgeColor,
    adoptExistingAppearance: input.adoptExistingAppearance === true,
  };
}

function safeParseResult(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

async function getMedicalNotesSettings(churchId) {
  const rows = await Database.queryForChurch(churchId,
    `SELECT planning_center_medical_notes_enabled AS enabled,
            planning_center_medical_notes_minimum_role AS minimumRole,
            planning_center_medical_notes_badge_icon AS badgeIcon,
            planning_center_medical_notes_badge_color AS badgeColor,
            planning_center_medical_notes_last_refreshed_at AS lastRefreshedAt,
            planning_center_medical_notes_last_refresh_result AS lastRefreshResult
       FROM church_settings WHERE church_id = ?`, [churchId]);
  const row = rows[0] || {};
  const gatherings = await Database.queryForChurch(churchId,
    `SELECT gathering_type_id AS id FROM planning_center_medical_note_gatherings
      WHERE church_id = ? ORDER BY gathering_type_id`, [churchId]);
  return {
    enabled: row.enabled === 1,
    minimumRole: row.minimumRole || 'admin',
    gatheringTypeIds: gatherings.map(({ id }) => Number(id)),
    badgeIcon: row.badgeIcon || null,
    badgeColor: row.badgeColor || null,
    lastRefreshedAt: row.lastRefreshedAt || null,
    lastRefreshResult: safeParseResult(row.lastRefreshResult),
  };
}

async function listAdoptableBadgeAppearances(churchId) {
  const rows = await Database.queryForChurch(churchId,
    `SELECT badge_icon AS icon, LOWER(badge_color) AS color, COUNT(*) AS count
       FROM individuals
      WHERE church_id = ?
        AND TRIM(COALESCE(badge_icon, '')) <> ''
        AND badge_color IS NOT NULL
        AND (badge_text IS NULL OR TRIM(badge_text) = '')
      GROUP BY badge_icon, LOWER(badge_color)`, [churchId]);
  return rows.flatMap((row) => {
    if (!MEDICAL_NOTE_ICONS.has(row.icon)) return [];
    try {
      return [{ icon: row.icon, color: normalizeMedicalNoteColor(row.color), count: Number(row.count) }];
    } catch (_) {
      return [];
    }
  }).sort((a, b) => b.count - a.count || a.icon.localeCompare(b.icon) || a.color.localeCompare(b.color));
}

async function saveMedicalNotesSettings(churchId, actor = {}, rawInput) {
  const input = normalizeMedicalNotesInput(rawInput);
  const adoptedCount = await Database.transactionForChurch(churchId, async (conn) => {
    if (input.gatheringTypeIds.length) {
      const placeholders = input.gatheringTypeIds.map(() => '?').join(',');
      const [{ count }] = await conn.query(
        `SELECT COUNT(*) AS count FROM gathering_types
          WHERE church_id = ? AND is_active = 1 AND attendance_type = 'standard'
            AND id IN (${placeholders})`, [churchId, ...input.gatheringTypeIds]);
      if (Number(count) !== input.gatheringTypeIds.length) {
        throw policyError('MEDICAL_NOTES_GATHERING_INVALID');
      }
    }

    let affectedCount = 0;
    if (input.adoptExistingAppearance) {
      const params = [churchId, input.badgeIcon, input.badgeColor];
      const predicate = `church_id = ? AND badge_icon = ? AND LOWER(badge_color) = ?
        AND (badge_text IS NULL OR TRIM(badge_text) = '')`;
      const [countRow] = await conn.query(`SELECT COUNT(*) AS count FROM individuals WHERE ${predicate}`, params);
      affectedCount = Number(countRow.count);
      await conn.query(`UPDATE individuals SET badge_icon = NULL, badge_color = NULL WHERE ${predicate}`, params);
    }

    await conn.query(
      `UPDATE church_settings SET
         planning_center_medical_notes_enabled = ?,
         planning_center_medical_notes_minimum_role = ?,
         planning_center_medical_notes_badge_icon = ?,
         planning_center_medical_notes_badge_color = ?
       WHERE church_id = ?`,
      [input.enabled ? 1 : 0, input.minimumRole, input.badgeIcon, input.badgeColor, churchId]
    );
    await conn.query('DELETE FROM planning_center_medical_note_gatherings WHERE church_id = ?', [churchId]);
    for (const gatheringTypeId of input.gatheringTypeIds) {
      await conn.query(
        'INSERT INTO planning_center_medical_note_gatherings (church_id, gathering_type_id) VALUES (?, ?)',
        [churchId, gatheringTypeId]
      );
    }
    if (!input.enabled) {
      await conn.query('UPDATE individuals SET pco_has_medical_notes = 0 WHERE church_id = ?', [churchId]);
    }
    if (input.adoptExistingAppearance) {
      await conn.query(
        `INSERT INTO audit_log
          (user_id, action, entity_type, new_values, ip_address, user_agent, church_id)
         VALUES (?, 'ADOPT_PCO_MEDICAL_BADGE', 'church_settings', ?, ?, ?, ?)`,
        [actor.userId || null, JSON.stringify({ icon: input.badgeIcon, color: input.badgeColor, affectedCount }),
          actor.ipAddress || null, actor.userAgent || null, churchId]
      );
    }
    return affectedCount;
  });
  return { settings: await getMedicalNotesSettings(churchId), adoptedCount };
}

async function disableMedicalNotesWithConnection(conn, churchId) {
  await conn.query('UPDATE church_settings SET planning_center_medical_notes_enabled = 0 WHERE church_id = ?', [churchId]);
  await conn.query('UPDATE individuals SET pco_has_medical_notes = 0 WHERE church_id = ?', [churchId]);
}

async function isMedicalNotesRefreshEnabled(churchId) {
  const rows = await Database.queryForChurch(churchId,
    'SELECT planning_center_medical_notes_enabled AS enabled FROM church_settings WHERE church_id = ?', [churchId]);
  return rows[0]?.enabled === 1;
}

async function isUnattendedMedicalNotesRefreshEnabled(churchId) {
  const rows = await Database.queryForChurch(churchId,
    `SELECT planning_center_medical_notes_enabled AS medicalEnabled,
            planning_center_sync_enabled AS syncEnabled
       FROM church_settings WHERE church_id = ?`, [churchId]);
  return rows[0]?.medicalEnabled === 1 && rows[0]?.syncEnabled === 1;
}

async function getMedicalNotesVisibility(churchId, userRole) {
  const settings = await getMedicalNotesSettings(churchId);
  const authorized = settings.enabled && roleCanViewMedicalNotes(settings.minimumRole, userRole);
  let indicator = null;
  if (authorized && MEDICAL_NOTE_ICONS.has(settings.badgeIcon)) {
    try { indicator = { icon: settings.badgeIcon, color: normalizeMedicalNoteColor(settings.badgeColor) }; } catch (_) {}
  }
  return { enabled: settings.enabled, authorized, indicator, gatheringTypeIds: settings.gatheringTypeIds };
}

module.exports = {
  MEDICAL_NOTE_ICONS,
  roleCanViewMedicalNotes,
  normalizeMedicalNoteColor,
  normalizeMedicalNotesInput,
  getMedicalNotesSettings,
  listAdoptableBadgeAppearances,
  saveMedicalNotesSettings,
  disableMedicalNotesWithConnection,
  isMedicalNotesRefreshEnabled,
  isUnattendedMedicalNotesRefreshEnabled,
  getMedicalNotesVisibility,
};
