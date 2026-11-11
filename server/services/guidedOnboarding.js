const Database = require('../config/database');

const GUIDED_VERSION = 2;
const stateValidators = {
  step: (value) => ['gathering', 'gathering-created', 'people', 'invite'].includes(value),
  provider: (value) => [null, 'elvanto', 'planning_center'].includes(value),
  mode: (value) => ['sync', 'import'].includes(value),
  peopleMethod: (value) => ['person', 'csv', 'copy-paste'].includes(value),
  lastGatheringId: (value) => Number.isSafeInteger(value) && value > 0,
  inviteDeferred: (value) => typeof value === 'boolean',
};

function isGuidedState(state) {
  return !!state && typeof state === 'object' && !Array.isArray(state) &&
    Object.hasOwn(state, 'step') &&
    Object.entries(state).every(([key, value]) =>
      Object.hasOwn(stateValidators, key) && stateValidators[key](value));
}

function readGuidedState(savedState) {
  if (savedState) {
    try {
      const state = JSON.parse(savedState);
      if (isGuidedState(state)) return state;
    } catch {
      // Invalid stored progress can be rebuilt from the current church records.
    }
  }
  return { step: 'gathering' };
}

async function getOnboardingStatus(churchId, userId, query = Database.queryForChurch.bind(Database, churchId)) {
  const [settings] = await query('SELECT * FROM church_settings WHERE church_id = ? LIMIT 1', [churchId]);
  const [progress] = await query(
    'SELECT * FROM onboarding_progress WHERE user_id = ? AND church_id = ?',
    [userId, churchId],
  );
  const [{ gatheringCount, standardGatheringCount, populatedFamilyCount }] = await query(
    `SELECT COUNT(*) AS gatheringCount,
            COUNT(CASE WHEN COALESCE(attendance_type, 'standard') = 'standard' THEN 1 END) AS standardGatheringCount,
            (
              SELECT COUNT(*) FROM families AS family
              WHERE family.church_id = ?
                AND EXISTS (
                  SELECT 1 FROM individuals AS member
                  WHERE member.family_id = family.id AND member.church_id = family.church_id
                    AND member.is_active = 1
                )
            ) AS populatedFamilyCount
     FROM gathering_types
     WHERE church_id = ? AND is_active = 1`,
    [churchId, churchId],
  );
  const version = settings?.onboarding_version ?? 0;
  const completed = settings ? settings.onboarding_completed : false;
  const { guided_state, ...legacyProgress } = progress ?? {};
  return {
    completed,
    settings: settings ?? null,
    progress: progress ? legacyProgress : null,
    guided: {
      version,
      required: version === GUIDED_VERSION && !completed,
      state: readGuidedState(guided_state),
      gatheringCount,
      standardGatheringCount,
      populatedFamilyCount,
      canFinish: gatheringCount > 0 && (standardGatheringCount === 0 || populatedFamilyCount > 0),
    },
  };
}

function startGuidedOnboarding(churchId, userId) {
  return Database.transactionForChurch(churchId, async ({ query }) => {
    const { settings, guided } = await getOnboardingStatus(churchId, userId, query);
    if (guided.version === GUIDED_VERSION) return { guided };

    const result = query(
      `UPDATE church_settings SET onboarding_version = ?, onboarding_completed = 0, updated_at = datetime('now')
       WHERE church_id = ? AND onboarding_version = 0
         AND NOT EXISTS (SELECT 1 FROM gathering_types WHERE church_id = ?)
         AND NOT EXISTS (SELECT 1 FROM individuals WHERE church_id = ?)
         AND NOT EXISTS (SELECT 1 FROM families WHERE church_id = ?)
         AND NOT EXISTS (SELECT 1 FROM attendance_sessions WHERE church_id = ?)`,
      [GUIDED_VERSION, churchId, churchId, churchId, churchId, churchId],
    );
    if (!result.affectedRows) {
      return {
        status: 409,
        code: 'GUIDED_ONBOARDING_UNAVAILABLE',
        error: settings ? 'Guided setup is available for empty churches.' : 'Church settings could not be found.',
      };
    }
    return { guided: { ...guided, version: GUIDED_VERSION, required: true } };
  });
}

function saveGuidedProgress(churchId, userId, state) {
  if (!isGuidedState(state)) {
    return { status: 400, code: 'INVALID_GUIDED_ONBOARDING_STATE', error: 'Invalid guided setup state.' };
  }

  return Database.transactionForChurch(churchId, async ({ query }) => {
    const { guided } = await getOnboardingStatus(churchId, userId, query);
    if (!guided.required) {
      return {
        status: 409,
        code: 'GUIDED_ONBOARDING_UNAVAILABLE',
        error: 'Guided setup is not in progress.',
      };
    }
    if (state.lastGatheringId !== undefined) {
      const [gathering] = query(
        'SELECT id FROM gathering_types WHERE id = ? AND church_id = ?',
        [state.lastGatheringId, churchId],
      );
      if (!gathering) {
        return { status: 400, code: 'INVALID_GUIDED_ONBOARDING_STATE', error: 'The selected gathering could not be found.' };
      }
    }

    const result = query(
      `INSERT INTO onboarding_progress (user_id, church_id, guided_state)
       VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET guided_state = excluded.guided_state, updated_at = datetime('now')
       WHERE onboarding_progress.church_id = excluded.church_id`,
      [userId, churchId, JSON.stringify(state)],
    );
    if (!result.affectedRows) {
      return { status: 409, code: 'GUIDED_ONBOARDING_UNAVAILABLE', error: 'Guided setup progress could not be saved.' };
    }
    return { guided: { ...guided, state } };
  });
}

function completeOnboarding(churchId, userId) {
  return Database.transactionForChurch(churchId, async ({ query }) => {
    const { guided } = await getOnboardingStatus(churchId, userId, query);
    if (guided.required && !guided.canFinish) {
      return {
        status: 409,
        code: 'GUIDED_ONBOARDING_INCOMPLETE',
        error: guided.gatheringCount === 0
          ? 'Create a gathering before finishing setup.'
          : 'Add at least one family with an active member before finishing setup.',
      };
    }

    query(
      `UPDATE church_settings SET onboarding_completed = 1, updated_at = datetime('now')
       WHERE church_id = ? AND COALESCE(onboarding_completed, 0) = 0`,
      [churchId],
    );
    return { guided: { ...guided, required: false } };
  });
}

module.exports = { getOnboardingStatus, startGuidedOnboarding, saveGuidedProgress, completeOnboarding };
