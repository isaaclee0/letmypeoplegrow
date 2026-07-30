const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const repository = require('./matchReviewRepository');

async function seedUser(churchId, email) {
  const result = await Database.queryForChurch(
    churchId,
    "INSERT INTO users (church_id, email, role) VALUES (?, ?, 'admin')",
    [churchId, email]
  );
  return Number(result.insertId);
}

async function seedIndividual(churchId, firstName) {
  const result = await Database.queryForChurch(
    churchId,
    'INSERT INTO individuals (church_id, first_name, last_name) VALUES (?, ?, ?)',
    [churchId, firstName, 'Member']
  );
  return Number(result.insertId);
}

test('match review state is isolated by church and provider', async () => {
  // Catches a lookup that omits either church_id or provider and exposes
  // a different church's decision or the wrong provider's decision.
  await withTestChurchDb(async (churchA) => {
    const churchB = `${churchA}_other`;
    Database.getChurchDb(churchB);
    const [userA, personA] = await Promise.all([
      seedUser(churchA, 'admin-a@example.test'),
      seedIndividual(churchA, 'Ada'),
    ]);
    const userB = await seedUser(churchB, 'admin-b@example.test');
    const personB = await seedIndividual(churchB, 'Grace');

    await repository.upsertExclusion({
      churchId: churchA, provider: 'elvanto', externalPersonId: 'ext-1', individualId: personA, userId: userA,
    });
    await repository.upsertHold({
      churchId: churchA, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'pair_rejected', userId: userA,
    });
    await repository.upsertExclusion({
      churchId: churchB, provider: 'elvanto', externalPersonId: 'ext-1', individualId: personB, userId: userB,
    });

    assert.equal((await repository.listMatchReviewState(churchB, 'planning_center')).exclusions.length, 0);
    assert.deepEqual(await repository.listMatchReviewState(churchA, 'planning_center'), { exclusions: [], holds: [] });
    assert.deepEqual(await repository.listMatchReviewState(churchA, 'elvanto'), {
      exclusions: [{ externalPersonId: 'ext-1', individualId: personA }],
      holds: [{ externalPersonId: 'ext-1', reason: 'pair_rejected' }],
    });
    assert.deepEqual(await repository.listMatchReviewState(churchB, 'elvanto'), {
      exclusions: [{ externalPersonId: 'ext-1', individualId: personB }],
      holds: [],
    });
  });
});

test('match review upserts preserve exact uniqueness and update the recorded author', async () => {
  // Catches overly broad conflict targets, duplicate decision rows, or an
  // upsert that loses the user who most recently recorded the decision.
  await withTestChurchDb(async (churchId) => {
    const [firstUser, secondUser, firstPerson, secondPerson] = await Promise.all([
      seedUser(churchId, 'first@example.test'),
      seedUser(churchId, 'second@example.test'),
      seedIndividual(churchId, 'Ada'),
      seedIndividual(churchId, 'Grace'),
    ]);

    await repository.upsertExclusion({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', individualId: firstPerson, userId: firstUser });
    await repository.upsertExclusion({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', individualId: firstPerson, userId: secondUser });
    await repository.upsertExclusion({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', individualId: secondPerson, userId: firstUser });
    await repository.upsertHold({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'deferred', userId: firstUser });
    await repository.upsertHold({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'pair_rejected', userId: secondUser });

    assert.deepEqual(await repository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [
        { externalPersonId: 'ext-1', individualId: firstPerson },
        { externalPersonId: 'ext-1', individualId: secondPerson },
      ],
      holds: [{ externalPersonId: 'ext-1', reason: 'pair_rejected' }],
    });
    assert.deepEqual(await Database.queryForChurch(
      churchId,
      `SELECT external_person_id, individual_id, created_by
         FROM people_sync_match_exclusions
        WHERE church_id = ? AND provider = ?
        ORDER BY individual_id`,
      [churchId, 'elvanto']
    ), [
      { external_person_id: 'ext-1', individual_id: firstPerson, created_by: secondUser },
      { external_person_id: 'ext-1', individual_id: secondPerson, created_by: firstUser },
    ]);
    assert.deepEqual(await Database.queryForChurch(
      churchId,
      `SELECT external_person_id, reason, created_by
         FROM people_sync_match_holds
        WHERE church_id = ? AND provider = ?`,
      [churchId, 'elvanto']
    ), [{ external_person_id: 'ext-1', reason: 'pair_rejected', created_by: secondUser }]);
  });
});

test('match review deletion removes only its requested exact decision', async () => {
  // Catches deletes that remove every decision for a person or external ID
  // instead of just the specified exclusion or provider-scoped hold.
  await withTestChurchDb(async (churchId) => {
    const [userId, firstPerson, secondPerson] = await Promise.all([
      seedUser(churchId, 'admin@example.test'),
      seedIndividual(churchId, 'Ada'),
      seedIndividual(churchId, 'Grace'),
    ]);
    await repository.upsertExclusion({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', individualId: firstPerson, userId });
    await repository.upsertExclusion({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', individualId: secondPerson, userId });
    await repository.upsertHold({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'deferred', userId });
    await repository.upsertHold({ churchId, provider: 'planning_center', externalPersonId: 'ext-1', reason: 'deferred', userId });

    assert.equal(await repository.deleteExclusion({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', individualId: firstPerson }), true);
    assert.equal(await repository.deleteHold({ churchId, provider: 'elvanto', externalPersonId: 'ext-1' }), true);
    assert.deepEqual(await repository.listMatchReviewState(churchId, 'elvanto'), {
      exclusions: [{ externalPersonId: 'ext-1', individualId: secondPerson }], holds: [],
    });
    assert.deepEqual(await repository.listMatchReviewState(churchId, 'planning_center'), {
      exclusions: [], holds: [{ externalPersonId: 'ext-1', reason: 'deferred' }],
    });
  });
});

test('match review mutations reject invalid provider, IDs, and hold reason', async () => {
  // Catches invalid values reaching the database boundary where they could
  // create ambiguous decisions or inconsistent provider records.
  await withTestChurchDb(async (churchId) => {
    await assert.rejects(
      repository.upsertExclusion({ churchId, provider: 'other', externalPersonId: 'ext-1', individualId: 1 }),
      /unsupported.*provider/i
    );
    await assert.rejects(
      repository.upsertExclusion({ churchId, provider: 'elvanto', externalPersonId: '', individualId: 1 }),
      /external person id/i
    );
    await assert.rejects(
      repository.upsertExclusion({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', individualId: 0 }),
      /individual id/i
    );
    await assert.rejects(
      repository.upsertHold({ churchId, provider: 'elvanto', externalPersonId: 'ext-1', reason: 'other' }),
      /hold reason/i
    );
  });
});
