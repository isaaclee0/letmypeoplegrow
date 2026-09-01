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

function completeInput(gatheringRoles, overrides = {}) {
  return {
    coreMinimum: overrides.coreMinimum ?? DEFAULT_ENGAGEMENT_SETTINGS.coreMinimum,
    casualMinimum: overrides.casualMinimum ?? DEFAULT_ENGAGEMENT_SETTINGS.casualMinimum,
    tiers: overrides.tiers || structuredClone(DEFAULT_ENGAGEMENT_SETTINGS.tiers),
    gatheringRoles,
  };
}

async function measureDatabaseQueries(operation) {
  const originalExecuteQuery = Database._executeQuery;
  let queryCount = 0;
  Database._executeQuery = (...args) => {
    queryCount += 1;
    return originalExecuteQuery.call(Database, ...args);
  };
  try {
    return { result: await operation(), queryCount };
  } finally {
    Database._executeQuery = originalExecuteQuery;
  }
}

test('defaults leave every gathering unclassified without inferring from its name', async () => {
  await withTestChurchDb(async (churchId) => {
    const sundayId = await seedGathering(churchId, 'Sunday Primary Worship');
    const communityId = await seedGathering(churchId, 'Community Group');
    const regularId = await seedIndividual(churchId, 'Active');
    await seedIndividual(churchId, 'Visitor', { peopleType: 'local_visitor' });
    await seedIndividual(churchId, 'Archived', { isActive: 0 });
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?)`,
      [sundayId, regularId, churchId],
    );

    const settings = await getEngagementSettings(churchId);

    assert.deepEqual(
      {
        coreMinimum: settings.coreMinimum,
        casualMinimum: settings.casualMinimum,
        tiers: settings.tiers,
        calculationRulesVersion: settings.calculationRulesVersion,
      },
      { ...DEFAULT_ENGAGEMENT_SETTINGS, calculationRulesVersion: 1 },
    );
    assert.deepEqual(settings.gatheringRoles, [
      { gatheringTypeId: sundayId, name: 'Sunday Primary Worship', attendanceType: 'standard', isActive: true, role: null },
      { gatheringTypeId: communityId, name: 'Community Group', attendanceType: 'standard', isActive: true, role: null },
    ]);
    assert.deepEqual(settings.assignmentPreview, {
      primaryAssigned: 0,
      communityAssigned: 0,
      primaryNotAssigned: 1,
    });
  });
});

test('an atomic update persists complete roles and previews active standard-gathering assignments', async () => {
  await withTestChurchDb(async (churchId) => {
    const primaryId = await seedGathering(churchId, 'Sunday');
    const communityId = await seedGathering(churchId, 'Small Group');
    const headcountId = await seedGathering(churchId, 'Festival', { attendanceType: 'headcount' });
    const inactiveId = await seedGathering(churchId, 'Old Service', { isActive: 0 });
    const primaryPerson = await seedIndividual(churchId, 'Primary');
    const communityPerson = await seedIndividual(churchId, 'Community');
    const unassignedPerson = await seedIndividual(churchId, 'Unassigned');
    await Database.query(
      `INSERT INTO gathering_lists (gathering_type_id, individual_id, church_id)
       VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
      [
        primaryId, primaryPerson, churchId,
        communityId, communityPerson, churchId,
        headcountId, unassignedPerson, churchId,
        inactiveId, unassignedPerson, churchId,
      ],
    );

    const { settings: updated, rulesChanged } = await updateEngagementSettings(churchId, 41, completeInput([
      { gatheringTypeId: primaryId, role: 'primary' },
      { gatheringTypeId: communityId, role: 'community' },
      { gatheringTypeId: headcountId, role: 'primary' },
      { gatheringTypeId: inactiveId, role: 'other' },
    ], {
      coreMinimum: 70,
      casualMinimum: 30,
      tiers: {
        core: { label: 'Committed', colour: '#0f0' },
        casual: { label: 'Connected', colour: '#D97706CC' },
        irregular: { label: 'Occasional', colour: '#dc2626' },
      },
    }));

    assert.equal(rulesChanged, true);
    assert.equal(updated.calculationRulesVersion, 2);
    assert.deepEqual(updated.assignmentPreview, {
      primaryAssigned: 1,
      communityAssigned: 1,
      primaryNotAssigned: 2,
    });
    assert.equal(updated.tiers.core.label, 'Committed');
    assert.deepEqual(updated.gatheringRoles, [
      { gatheringTypeId: primaryId, name: 'Sunday', attendanceType: 'standard', isActive: true, role: 'primary' },
      { gatheringTypeId: communityId, name: 'Small Group', attendanceType: 'standard', isActive: true, role: 'community' },
      { gatheringTypeId: headcountId, name: 'Festival', attendanceType: 'headcount', isActive: true, role: 'primary' },
      { gatheringTypeId: inactiveId, name: 'Old Service', attendanceType: 'standard', isActive: false, role: 'other' },
    ]);
    const storedRoles = await Database.query(
      `SELECT id, engagement_role AS role FROM gathering_types
       WHERE church_id = ? ORDER BY id`,
      [churchId],
    );
    assert.deepEqual(storedRoles, [
      { id: primaryId, role: 'primary' },
      { id: communityId, role: 'community' },
      { id: headcountId, role: 'primary' },
      { id: inactiveId, role: 'other' },
    ]);
  });
});

test('updates a large gathering-role set with bounded database queries', async (t) => {
  await withTestChurchDb(async (churchId) => {
    const db = Database.getChurchDb(churchId);
    const gatheringIds = db.transaction(() => {
      const insert = db.prepare(
        `INSERT INTO gathering_types
           (name, attendance_type, is_active, engagement_role, church_id)
         VALUES (?, 'standard', 1, NULL, ?)`,
      );
      return Array.from({ length: 100 }, (_, index) => Number(
        insert.run(`Gathering ${index + 1}`, churchId).lastInsertRowid,
      ));
    })();
    const gatheringRoles = gatheringIds.map((gatheringTypeId, index) => ({
      gatheringTypeId,
      role: index % 2 === 0 ? 'primary' : 'community',
    }));

    const measured = await measureDatabaseQueries(() => updateEngagementSettings(
      churchId,
      41,
      completeInput(gatheringRoles),
    ));

    assert.equal(measured.result.rulesChanged, true);
    assert.equal(measured.result.settings.gatheringRoles.length, 100);
    assert.ok(
      measured.queryCount <= 7,
      `expected bounded settings queries, received ${measured.queryCount}`,
    );
    t.diagnostic(`measured ${measured.queryCount} settings queries for 100 gatherings`);
  });
});

test('thresholds must be ordered integer percentages within bounds', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringId = await seedGathering(churchId, 'Sunday');
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
        updateEngagementSettings(churchId, 1, completeInput(
          [{ gatheringTypeId: gatheringId, role: null }],
          { casualMinimum, coreMinimum },
        )),
        (error) => error.code === 'INVALID_ENGAGEMENT_SETTINGS',
      );
    }
  });
});

test('tier labels must be non-empty and colours must be CSS hex colours', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringId = await seedGathering(churchId, 'Sunday');
    for (const invalidTier of [
      { label: '   ', colour: '#16A34A' },
      { label: 'Core', colour: 'green' },
      { label: 'Core', colour: '#12' },
      { label: 'Core', colour: '#12345' },
      { label: 'Core', colour: '#GGGGGG' },
    ]) {
      await assert.rejects(
        updateEngagementSettings(churchId, 1, completeInput(
          [{ gatheringTypeId: gatheringId, role: null }],
          { tiers: { ...structuredClone(DEFAULT_ENGAGEMENT_SETTINGS.tiers), core: invalidTier } },
        )),
        (error) => error.code === 'INVALID_ENGAGEMENT_SETTINGS',
      );
    }
  });
});

test('the role list rejects duplicates, omissions, and gathering IDs outside the church', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withTestChurchDb(async (churchId) => {
    const firstId = await seedGathering(churchId, 'First');
    const secondId = await seedGathering(churchId, 'Second');
    await Database.query(
      `INSERT INTO gathering_types (id, name, church_id) VALUES (9999, 'Foreign', 'another_church')`,
    );
    const invalidLists = [
      [
        { gatheringTypeId: firstId, role: 'primary' },
        { gatheringTypeId: firstId, role: 'community' },
      ],
      [{ gatheringTypeId: firstId, role: 'primary' }],
      [
        { gatheringTypeId: firstId, role: 'primary' },
        { gatheringTypeId: secondId, role: 'community' },
        { gatheringTypeId: 9999, role: 'other' },
      ],
    ];

    for (const gatheringRoles of invalidLists) {
      await assert.rejects(
        updateEngagementSettings(churchId, 1, completeInput(gatheringRoles)),
        (error) => error.code === 'INVALID_ENGAGEMENT_SETTINGS',
      );
    }
    assert.deepEqual(
      await Database.query(
        `SELECT engagement_role AS role FROM gathering_types
         WHERE church_id = ? ORDER BY id`,
        [churchId],
      ),
      [{ role: null }, { role: null }],
    );
  });
});

test('a database failure rolls back tier settings and every gathering role', async (t) => {
  t.mock.method(console, 'error', () => {});
  await withTestChurchDb(async (churchId) => {
    const firstId = await seedGathering(churchId, 'First');
    const secondId = await seedGathering(churchId, 'Second');
    await Database.executeMultipleStatements(`
      CREATE TRIGGER reject_second_engagement_role
      BEFORE UPDATE OF engagement_role ON gathering_types
      WHEN NEW.id = ${secondId}
      BEGIN
        SELECT RAISE(ABORT, 'forced role failure');
      END;
    `);

    await assert.rejects(
      updateEngagementSettings(churchId, 1, completeInput([
        { gatheringTypeId: firstId, role: 'primary' },
        { gatheringTypeId: secondId, role: 'community' },
      ], { coreMinimum: 75 })),
      /forced role failure/,
    );

    assert.deepEqual(
      await Database.query(
        `SELECT engagement_role AS role FROM gathering_types
         WHERE church_id = ? ORDER BY id`,
        [churchId],
      ),
      [{ role: null }, { role: null }],
    );
    assert.deepEqual(
      await Database.query('SELECT * FROM engagement_settings WHERE church_id = ?', [churchId]),
      [],
    );
  });
});

test('rules version changes for thresholds or roles, but not labels or colours', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringId = await seedGathering(churchId, 'Sunday');
    const roles = [{ gatheringTypeId: gatheringId, role: null }];
    const labelsChanged = completeInput(roles, {
      tiers: {
        ...structuredClone(DEFAULT_ENGAGEMENT_SETTINGS.tiers),
        core: { label: 'Committed', colour: '#16A34A' },
      },
    });
    let result = await updateEngagementSettings(churchId, 1, labelsChanged);
    assert.equal(result.rulesChanged, false);
    assert.equal(result.settings.calculationRulesVersion, 1);

    const coloursChanged = structuredClone(labelsChanged);
    coloursChanged.tiers.casual.colour = '#CA5';
    result = await updateEngagementSettings(churchId, 1, coloursChanged);
    assert.equal(result.rulesChanged, false);
    assert.equal(result.settings.calculationRulesVersion, 1);

    const thresholdsChanged = structuredClone(coloursChanged);
    thresholdsChanged.coreMinimum = 65;
    result = await updateEngagementSettings(churchId, 1, thresholdsChanged);
    assert.equal(result.rulesChanged, true);
    assert.equal(result.settings.calculationRulesVersion, 2);
    result = await updateEngagementSettings(churchId, 1, thresholdsChanged);
    assert.equal(result.rulesChanged, false);
    assert.equal(result.settings.calculationRulesVersion, 2);

    const roleChanged = structuredClone(thresholdsChanged);
    roleChanged.gatheringRoles[0].role = 'primary';
    result = await updateEngagementSettings(churchId, 1, roleChanged);
    assert.equal(result.rulesChanged, true);
    assert.equal(result.settings.calculationRulesVersion, 3);
    result = await updateEngagementSettings(churchId, 1, roleChanged);
    assert.equal(result.rulesChanged, false);
    assert.equal(result.settings.calculationRulesVersion, 3);
  });
});

test('updates use the explicit church when ambient context is mismatched or absent', async () => {
  await withTestChurchDb(async (churchId) => {
    const gatheringId = await seedGathering(churchId, 'Sunday');
    const primaryInput = completeInput([
      { gatheringTypeId: gatheringId, role: 'primary' },
    ]);

    const mismatchedResult = await Database.setChurchContext('wrong_church_context', () =>
      updateEngagementSettings(churchId, 1, primaryInput));
    assert.equal(mismatchedResult.settings.gatheringRoles[0].role, 'primary');

    const noContextInput = structuredClone(primaryInput);
    noContextInput.gatheringRoles[0].role = 'community';
    const noContextResult = await Database.setChurchContext(undefined, () =>
      updateEngagementSettings(churchId, 1, noContextInput));
    assert.equal(noContextResult.settings.gatheringRoles[0].role, 'community');

    const [stored] = await Database.queryForChurch(
      churchId,
      `SELECT engagement_role AS role FROM gathering_types
       WHERE id = ? AND church_id = ?`,
      [gatheringId, churchId],
    );
    assert.equal(stored.role, 'community');
  });
});
