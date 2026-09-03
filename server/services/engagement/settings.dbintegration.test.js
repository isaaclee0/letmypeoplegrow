'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const logger = require('../../config/logger');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();

const {
  DEFAULT_ENGAGEMENT_SETTINGS,
  getEngagementSettings,
  updateEngagementSettings,
} = require('./settings');

async function seedGathering(churchId, name, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO gathering_types
       (name, attendance_type, is_active, engagement_role, church_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      name,
      overrides.attendanceType || 'standard',
      overrides.isActive === undefined ? 1 : overrides.isActive,
      overrides.role === undefined ? null : overrides.role,
      churchId,
    ],
  );
  return result.insertId;
}

async function seedIndividual(churchId, name, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO individuals
       (first_name, last_name, people_type, is_active, church_id)
     VALUES (?, 'Person', ?, ?, ?)`,
    [
      name,
      overrides.peopleType || 'regular',
      overrides.isActive === undefined ? 1 : overrides.isActive,
      churchId,
    ],
  );
  return result.insertId;
}

function completeInput(overrides = {}) {
  return {
    coreMinimum: overrides.coreMinimum ?? DEFAULT_ENGAGEMENT_SETTINGS.coreMinimum,
    casualMinimum: overrides.casualMinimum ?? DEFAULT_ENGAGEMENT_SETTINGS.casualMinimum,
    tiers: overrides.tiers || structuredClone(DEFAULT_ENGAGEMENT_SETTINGS.tiers),
    gatheringRoles: overrides.gatheringRoles,
  };
}

test('defaults preserve legacy gathering roles and assignment preview fields', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringId = await seedGathering(churchId, 'Sunday Primary Worship', { role: 'primary' });
    const regularId = await seedIndividual(churchId, 'Active');
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [gatheringId, regularId, churchId],
    );

    const settings = await getEngagementSettings(churchId);

    assert.deepEqual(
      settings,
      {
        ...DEFAULT_ENGAGEMENT_SETTINGS,
        calculationRulesVersion: 1,
        gatheringRoles: [
          {
            gatheringTypeId: gatheringId,
            name: 'Sunday Primary Worship',
            attendanceType: 'standard',
            isActive: true,
            role: 'primary',
          },
        ],
        assignmentPreview: {
          primaryAssigned: 1,
          communityAssigned: 0,
          primaryNotAssigned: 0,
        },
      },
    );
  });
});

test('an update persists threshold and tier styles without modifying gathering roles', async () => {
  await withTestChurchDb(async (churchId) => {
    const primaryId = await seedGathering(churchId, 'Sunday', { role: 'primary' });
    const communityId = await seedGathering(churchId, 'Small Group', { role: 'community' });

    const { settings: updated, rulesChanged } = await updateEngagementSettings(
      churchId,
      41,
      completeInput({
        coreMinimum: 70,
        casualMinimum: 30,
        gatheringRoles: [{ gatheringTypeId: primaryId, role: 'other' }],
        tiers: {
          core: { label: 'Committed', colour: '#0f0' },
          casual: { label: 'Connected', colour: '#D97706CC' },
          irregular: { label: 'Occasional', colour: '#dc2626' },
        },
      }),
    );

    assert.equal(rulesChanged, true);
    assert.equal(updated.calculationRulesVersion, 2);
    assert.equal(updated.coreMinimum, 70);
    assert.equal(updated.casualMinimum, 30);
    assert.equal(updated.tiers.core.label, 'Committed');
    assert.deepEqual(updated.gatheringRoles.map(({ gatheringTypeId, role }) => ({ gatheringTypeId, role })), [
      { gatheringTypeId: primaryId, role: 'primary' },
      { gatheringTypeId: communityId, role: 'community' },
    ]);
    assert.deepEqual(updated.assignmentPreview, {
      primaryAssigned: 0,
      communityAssigned: 0,
      primaryNotAssigned: 0,
    });

    assert.deepEqual(
      await Database.query(
        `SELECT id, engagement_role AS role FROM gathering_types
         WHERE church_id = ? ORDER BY id`,
        [churchId],
      ),
      [
        { id: primaryId, role: 'primary' },
        { id: communityId, role: 'community' },
      ],
    );
  });
});

test('label and colour edits do not advance calculation rules version', async () => {
  await withTestChurchDb(async (churchId) => {
    await updateEngagementSettings(churchId, 1, completeInput());
    const result = await updateEngagementSettings(churchId, 1, completeInput({
      tiers: {
        ...structuredClone(DEFAULT_ENGAGEMENT_SETTINGS.tiers),
        core: { label: 'Committed', colour: '#0f0' },
      },
    }));

    assert.equal(result.rulesChanged, false);
    assert.equal(result.settings.calculationRulesVersion, 1);
  });
});

test('thresholds must be ordered integer percentages within bounds', async () => {
  await withTestChurchDb(async (churchId) => {
    const invalidPairs = [
      [-1, 60],
      [20, 101],
      [60, 60],
      [61, 60],
      [20.5, 60],
      [20, 60.5],
    ];

    for (const [casualMinimum, coreMinimum] of invalidPairs) {
      await assert.rejects(
        updateEngagementSettings(churchId, 1, completeInput({ casualMinimum, coreMinimum })),
        (error) => error.code === 'INVALID_ENGAGEMENT_SETTINGS',
      );
    }
  });
});

test('tier labels must be non-empty and colours must be CSS hex colours', async () => {
  await withTestChurchDb(async (churchId) => {
    for (const invalidTier of [
      { label: '   ', colour: '#16A34A' },
      { label: 'Core', colour: 'green' },
      { label: 'Core', colour: '#12' },
      { label: 'Core', colour: '#12345' },
      { label: 'Core', colour: '#GGGGGG' },
    ]) {
      await assert.rejects(
        updateEngagementSettings(churchId, 1, completeInput({
          tiers: { ...structuredClone(DEFAULT_ENGAGEMENT_SETTINGS.tiers), core: invalidTier },
        })),
        (error) => error.code === 'INVALID_ENGAGEMENT_SETTINGS',
      );
    }
  });
});

test('updates use the explicit church when ambient context is mismatched or absent', async () => {
  await withTestChurchDb(async (churchId) => {
    const mismatchedResult = await Database.setChurchContext('wrong_church_context', () =>
      updateEngagementSettings(churchId, 1, completeInput({ coreMinimum: 65 })));
    assert.equal(mismatchedResult.settings.coreMinimum, 65);

    const noContextResult = await Database.setChurchContext(undefined, () =>
      updateEngagementSettings(churchId, 1, completeInput({ coreMinimum: 70 })));
    assert.equal(noContextResult.settings.coreMinimum, 70);

    const [stored] = await Database.queryForChurch(
      churchId,
      `SELECT core_minimum AS coreMinimum FROM engagement_settings WHERE church_id = ?`,
      [churchId],
    );
    assert.equal(stored.coreMinimum, 70);
  });
});
