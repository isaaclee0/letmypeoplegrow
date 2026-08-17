'use strict';

const Database = require('../../config/database');

const DEFAULT_ENGAGEMENT_SETTINGS = Object.freeze({
  coreMinimum: 60,
  casualMinimum: 20,
  tiers: Object.freeze({
    core: Object.freeze({ label: 'Core', colour: '#16A34A' }),
    casual: Object.freeze({ label: 'Casual', colour: '#D97706' }),
    irregular: Object.freeze({ label: 'Irregular', colour: '#DC2626' }),
  }),
});

const TIER_KEYS = Object.freeze(['core', 'casual', 'irregular']);
const VALID_GATHERING_ROLES = new Set(['primary', 'community', 'other', null]);
const CSS_HEX_COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

class EngagementSettingsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngagementSettingsValidationError';
    this.code = 'INVALID_ENGAGEMENT_SETTINGS';
    this.status = 400;
  }
}

function invalid(message) {
  throw new EngagementSettingsValidationError(message);
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('A complete engagement settings object is required.');
  }

  const { coreMinimum, casualMinimum, tiers, gatheringRoles } = input;
  if (!Number.isInteger(coreMinimum) || !Number.isInteger(casualMinimum)
      || casualMinimum < 0 || coreMinimum > 100 || casualMinimum >= coreMinimum) {
    invalid('Tier thresholds must be integer percentages satisfying 0 <= casual < core <= 100.');
  }
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) {
    invalid('All three tier definitions are required.');
  }

  const normalizedTiers = {};
  for (const key of TIER_KEYS) {
    const tier = tiers[key];
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
      invalid(`The ${key} tier definition is required.`);
    }
    if (typeof tier.label !== 'string' || tier.label.trim() === '') {
      invalid(`The ${key} tier label must not be empty.`);
    }
    if (typeof tier.colour !== 'string' || !CSS_HEX_COLOUR.test(tier.colour)) {
      invalid(`The ${key} tier colour must be a valid CSS hex colour.`);
    }
    normalizedTiers[key] = { label: tier.label.trim(), colour: tier.colour };
  }

  if (!Array.isArray(gatheringRoles)) {
    invalid('The complete gathering role list is required.');
  }
  const seenIds = new Set();
  const normalizedRoles = gatheringRoles.map((assignment) => {
    if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)
        || !Number.isInteger(assignment.gatheringTypeId) || assignment.gatheringTypeId <= 0
        || !VALID_GATHERING_ROLES.has(assignment.role)) {
      invalid('Each gathering role must contain a valid gatheringTypeId and role.');
    }
    if (seenIds.has(assignment.gatheringTypeId)) {
      invalid('The gathering role list must not contain duplicate gathering IDs.');
    }
    seenIds.add(assignment.gatheringTypeId);
    return { gatheringTypeId: assignment.gatheringTypeId, role: assignment.role };
  });

  return { coreMinimum, casualMinimum, tiers: normalizedTiers, gatheringRoles: normalizedRoles };
}

function settingsFromRow(row) {
  if (!row) {
    return {
      coreMinimum: DEFAULT_ENGAGEMENT_SETTINGS.coreMinimum,
      casualMinimum: DEFAULT_ENGAGEMENT_SETTINGS.casualMinimum,
      tiers: {
        core: { ...DEFAULT_ENGAGEMENT_SETTINGS.tiers.core },
        casual: { ...DEFAULT_ENGAGEMENT_SETTINGS.tiers.casual },
        irregular: { ...DEFAULT_ENGAGEMENT_SETTINGS.tiers.irregular },
      },
      calculationRulesVersion: 1,
    };
  }
  return {
    coreMinimum: row.coreMinimum,
    casualMinimum: row.casualMinimum,
    tiers: {
      core: { label: row.coreLabel, colour: row.coreColour },
      casual: { label: row.casualLabel, colour: row.casualColour },
      irregular: { label: row.irregularLabel, colour: row.irregularColour },
    },
    calculationRulesVersion: row.calculationRulesVersion,
  };
}

async function loadSettingsRow(query, churchId) {
  const rows = await query(
    `SELECT
       core_minimum AS coreMinimum,
       casual_minimum AS casualMinimum,
       core_label AS coreLabel,
       core_colour AS coreColour,
       casual_label AS casualLabel,
       casual_colour AS casualColour,
       irregular_label AS irregularLabel,
       irregular_colour AS irregularColour,
       calculation_rules_version AS calculationRulesVersion
     FROM engagement_settings
     WHERE church_id = ?
     LIMIT 1`,
    [churchId],
  );
  return rows[0] || null;
}

async function loadGatheringRoles(query, churchId) {
  return query(
    `SELECT id AS gatheringTypeId, engagement_role AS role
     FROM gathering_types
     WHERE church_id = ?
     ORDER BY id`,
    [churchId],
  );
}

async function loadAssignmentPreview(query, churchId) {
  const rows = await query(
    `SELECT
       COUNT(DISTINCT CASE WHEN gt.engagement_role = 'primary' THEN i.id END)
         AS primaryAssigned,
       COUNT(DISTINCT CASE WHEN gt.engagement_role = 'community' THEN i.id END)
         AS communityAssigned,
       COUNT(DISTINCT i.id) AS activeRegulars
     FROM individuals i
     LEFT JOIN gathering_lists gl
       ON gl.individual_id = i.id
      AND gl.church_id = ?
     LEFT JOIN gathering_types gt
       ON gt.id = gl.gathering_type_id
      AND gt.church_id = ?
      AND gt.is_active = 1
      AND gt.attendance_type = 'standard'
     WHERE i.church_id = ?
       AND i.is_active = 1
       AND i.people_type = 'regular'`,
    [churchId, churchId, churchId],
  );
  const row = rows[0] || { primaryAssigned: 0, communityAssigned: 0, activeRegulars: 0 };
  return {
    primaryAssigned: row.primaryAssigned,
    communityAssigned: row.communityAssigned,
    primaryNotAssigned: row.activeRegulars - row.primaryAssigned,
  };
}

async function getEngagementSettings(churchId) {
  if (!churchId) throw new Error('A church ID is required to read engagement settings.');
  const query = (sql, params) => Database.queryForChurch(churchId, sql, params);
  const [row, gatheringRoles, assignmentPreview] = await Promise.all([
    loadSettingsRow(query, churchId),
    loadGatheringRoles(query, churchId),
    loadAssignmentPreview(query, churchId),
  ]);
  return { ...settingsFromRow(row), gatheringRoles, assignmentPreview };
}

async function updateEngagementSettings(churchId, actorId, input) {
  if (!churchId) throw new Error('A church ID is required to update engagement settings.');
  void actorId;
  const normalized = validateInput(input);

  await Database.transactionForChurch(churchId, async (connection) => {
    const query = (sql, params) => connection.query(sql, params);
    const [currentRow, currentRoles] = await Promise.all([
      loadSettingsRow(query, churchId),
      loadGatheringRoles(query, churchId),
    ]);
    const churchGatheringIds = new Set(currentRoles.map((assignment) => assignment.gatheringTypeId));
    const submittedIds = new Set(normalized.gatheringRoles.map((assignment) => assignment.gatheringTypeId));
    if (churchGatheringIds.size !== submittedIds.size
        || [...churchGatheringIds].some((id) => !submittedIds.has(id))) {
      invalid('Gathering roles must provide exactly one assignment for every church gathering.');
    }

    const current = settingsFromRow(currentRow);
    const currentRoleById = new Map(
      currentRoles.map((assignment) => [assignment.gatheringTypeId, assignment.role]),
    );
    const rulesChanged = current.coreMinimum !== normalized.coreMinimum
      || current.casualMinimum !== normalized.casualMinimum
      || normalized.gatheringRoles.some(
        (assignment) => currentRoleById.get(assignment.gatheringTypeId) !== assignment.role,
      );
    const calculationRulesVersion = current.calculationRulesVersion + (rulesChanged ? 1 : 0);

    await query(
      `INSERT INTO engagement_settings
         (church_id, core_minimum, casual_minimum,
          core_label, core_colour, casual_label, casual_colour,
          irregular_label, irregular_colour, calculation_rules_version,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(church_id) DO UPDATE SET
         core_minimum = excluded.core_minimum,
         casual_minimum = excluded.casual_minimum,
         core_label = excluded.core_label,
         core_colour = excluded.core_colour,
         casual_label = excluded.casual_label,
         casual_colour = excluded.casual_colour,
         irregular_label = excluded.irregular_label,
         irregular_colour = excluded.irregular_colour,
         calculation_rules_version = excluded.calculation_rules_version,
         updated_at = datetime('now')`,
      [
        churchId,
        normalized.coreMinimum,
        normalized.casualMinimum,
        normalized.tiers.core.label,
        normalized.tiers.core.colour,
        normalized.tiers.casual.label,
        normalized.tiers.casual.colour,
        normalized.tiers.irregular.label,
        normalized.tiers.irregular.colour,
        calculationRulesVersion,
      ],
    );

    for (const assignment of normalized.gatheringRoles) {
      const result = await query(
        `UPDATE gathering_types
         SET engagement_role = ?, updated_at = datetime('now')
         WHERE id = ? AND church_id = ?`,
        [assignment.role, assignment.gatheringTypeId, churchId],
      );
      if (result.affectedRows !== 1) {
        invalid('A gathering role no longer belongs to this church.');
      }
    }
  });

  return getEngagementSettings(churchId);
}

module.exports = {
  DEFAULT_ENGAGEMENT_SETTINGS,
  EngagementSettingsValidationError,
  getEngagementSettings,
  updateEngagementSettings,
};
