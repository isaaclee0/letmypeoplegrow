const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const connectionStore = require('./connectionStore');
const {
  PCO_RECONNECT_REQUIRED,
  getOrMigrateCredentials,
  migrateLegacyCredentials,
  ensureFreshCredentials,
  getValidCredentials,
} = require('./pcoCredentialMigration');

async function withCredentialKey(callback) {
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
  try {
    return await callback();
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = previous;
  }
}

async function insertAdmin(churchId, email) {
  const result = await Database.queryForChurch(
    churchId,
    "INSERT INTO users (church_id, email, role) VALUES (?, ?, 'admin')",
    [churchId, email]
  );
  return result.insertId;
}

async function seedLegacyTokens(churchId, userId, tokens) {
  await Database.queryForChurch(
    churchId,
    `INSERT INTO user_preferences (user_id, preference_key, preference_value, church_id)
     VALUES (?, 'planning_center_tokens', ?, ?)`,
    [userId, JSON.stringify(tokens), churchId]
  );
}

async function countLegacyRows(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT COUNT(*) AS n FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens'`,
    [churchId]
  );
  return rows[0].n;
}

async function countConnectionRows(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT COUNT(*) AS n FROM integration_connections WHERE church_id = ? AND provider = 'planning_center'`,
    [churchId]
  );
  return rows[0].n;
}

test('one distinct legacy credential is encrypted and migrated at first access', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'admin@example.test');
    await seedLegacyTokens(churchId, adminId, {
      access_token: 'at-1', refresh_token: 'rt-1', expires_at: Date.now() + 3600_000,
    });

    const credentials = await getOrMigrateCredentials(churchId);
    assert.deepEqual(credentials, { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: credentials.expiresAt });

    // Encrypted onto integration_connections, exactly one row.
    assert.equal(await countConnectionRows(churchId), 1);
    const rawRows = await Database.queryForChurch(
      churchId, `SELECT * FROM integration_connections WHERE church_id = ? AND provider = 'planning_center'`, [churchId]
    );
    assert.equal(JSON.stringify(rawRows[0]).includes('at-1'), false);
    assert.equal(JSON.stringify(rawRows[0]).includes('rt-1'), false);
    assert.equal(rawRows[0].connected_by, adminId);

    // Legacy row cleaned up so a later disconnect can't be "resurrected" by it.
    assert.equal(await countLegacyRows(churchId), 0);

    // Second read hits the now-encrypted row directly, no re-migration needed.
    const again = await getOrMigrateCredentials(churchId);
    assert.deepEqual(again, credentials);
  }));
});

test('two identical legacy token rows collapse safely into one connection', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const admin1 = await insertAdmin(churchId, 'admin1@example.test');
    const admin2 = await insertAdmin(churchId, 'admin2@example.test');
    const tokens = { access_token: 'same-at', refresh_token: 'same-rt', expires_at: Date.now() + 3600_000 };
    await seedLegacyTokens(churchId, admin1, tokens);
    await seedLegacyTokens(churchId, admin2, tokens);

    const credentials = await getOrMigrateCredentials(churchId);
    assert.deepEqual(credentials, { accessToken: 'same-at', refreshToken: 'same-rt', expiresAt: tokens.expires_at });
    assert.equal(await countConnectionRows(churchId), 1);
    assert.equal(await countLegacyRows(churchId), 0);
  }));
});

test('two different legacy token rows return PCO_RECONNECT_REQUIRED and do not guess', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const admin1 = await insertAdmin(churchId, 'admin1@example.test');
    const admin2 = await insertAdmin(churchId, 'admin2@example.test');
    await seedLegacyTokens(churchId, admin1, { access_token: 'at-a', refresh_token: 'rt-a', expires_at: Date.now() + 3600_000 });
    await seedLegacyTokens(churchId, admin2, { access_token: 'at-b', refresh_token: 'rt-b', expires_at: Date.now() + 3600_000 });

    await assert.rejects(migrateLegacyCredentials(churchId), (err) => {
      assert.equal(err.code, PCO_RECONNECT_REQUIRED);
      assert.equal(/at-a|at-b|rt-a|rt-b/.test(err.message), false, 'error message must not leak token values');
      return true;
    });
    await assert.rejects(getOrMigrateCredentials(churchId), (err) => err.code === PCO_RECONNECT_REQUIRED);

    // Refuses to guess: nothing written, nothing deleted.
    assert.equal(await countConnectionRows(churchId), 0);
    assert.equal(await countLegacyRows(churchId), 2);
  }));
});

test('refresh writes exactly one church connection row and never touches user_preferences', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'admin@example.test');
    await connectionStore.upsertConnection({
      churchId,
      provider: 'planning_center',
      authType: 'oauth',
      credentials: { accessToken: 'stale-at', refreshToken: 'stale-rt', expiresAt: Date.now() - 1000 },
      connectedBy: adminId,
      metadata: { accountName: 'Example Church' },
    });
    // A stray legacy row (e.g. left over from before this church was migrated,
    // or never cleaned up for some other reason) must never be written to.
    await seedLegacyTokens(churchId, adminId, { access_token: 'legacy-at', refresh_token: 'legacy-rt', expires_at: Date.now() + 3600_000 });

    let refreshCalls = 0;
    const requestRefresh = async (refreshTokenValue) => {
      refreshCalls++;
      assert.equal(refreshTokenValue, 'stale-rt');
      return { accessToken: 'fresh-at', refreshToken: 'fresh-rt', expiresAt: Date.now() + 7200_000 };
    };

    const stored = await getOrMigrateCredentials(churchId); // reads the connection row directly, no migration needed
    const refreshed = await ensureFreshCredentials(churchId, stored, requestRefresh);

    assert.equal(refreshCalls, 1);
    assert.deepEqual(refreshed, { accessToken: 'fresh-at', refreshToken: 'fresh-rt', expiresAt: refreshed.expiresAt });

    // Exactly one connection row, holding the refreshed token.
    assert.equal(await countConnectionRows(churchId), 1);
    assert.deepEqual(await connectionStore.getCredentials(churchId, 'planning_center'), refreshed);

    // connected_by/metadata preserved across the refresh.
    const connection = await connectionStore.getConnection(churchId, 'planning_center');
    assert.deepEqual(connection.metadata, { accountName: 'Example Church' });

    // The legacy row (for an arbitrary user) is completely untouched by refresh.
    const legacyRows = await Database.queryForChurch(
      churchId,
      `SELECT preference_value FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens'`,
      [churchId]
    );
    assert.equal(legacyRows.length, 1);
    const legacyTokens = JSON.parse(legacyRows[0].preference_value);
    assert.equal(legacyTokens.access_token, 'legacy-at');
    assert.equal(legacyTokens.refresh_token, 'legacy-rt');
  }));
});

test('no refreshed token is ever written back to an arbitrary user preference row', async () => {
  // Simulates the exact hazard the legacy design had: two admins, two rows.
  // Even after collapsing/migrating and refreshing, user_preferences must end
  // up completely empty — never re-populated by a refresh.
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const admin1 = await insertAdmin(churchId, 'admin1@example.test');
    const tokens = { access_token: 'at-1', refresh_token: 'rt-1', expires_at: Date.now() - 1000 };
    await seedLegacyTokens(churchId, admin1, tokens);

    const requestRefresh = async () => ({ accessToken: 'rotated-at', refreshToken: 'rotated-rt', expiresAt: Date.now() + 7200_000 });
    const refreshed = await getValidCredentials(churchId, requestRefresh);

    assert.deepEqual(refreshed, { accessToken: 'rotated-at', refreshToken: 'rotated-rt', expiresAt: refreshed.expiresAt });
    assert.equal(await countLegacyRows(churchId), 0);
    assert.equal(await countConnectionRows(churchId), 1);
    assert.deepEqual(await connectionStore.getCredentials(churchId, 'planning_center'), refreshed);
  }));
});

test('concurrent refresh callers for the same church share one in-flight refresh', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    await connectionStore.upsertConnection({
      churchId,
      provider: 'planning_center',
      authType: 'oauth',
      credentials: { accessToken: 'stale-at', refreshToken: 'stale-rt', expiresAt: Date.now() - 1000 },
    });

    let refreshCalls = 0;
    const requestRefresh = async () => {
      refreshCalls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: `fresh-at-${refreshCalls}`, refreshToken: `fresh-rt-${refreshCalls}`, expiresAt: Date.now() + 7200_000 };
    };

    const stored = await getOrMigrateCredentials(churchId);
    const [a, b] = await Promise.all([
      ensureFreshCredentials(churchId, stored, requestRefresh),
      ensureFreshCredentials(churchId, stored, requestRefresh),
    ]);

    assert.equal(refreshCalls, 1, 'both concurrent callers should share a single in-flight refresh');
    assert.deepEqual(a, b);
    assert.equal(await countConnectionRows(churchId), 1);
  }));
});

test('getOrMigrateCredentials returns null when there is no connection and no legacy tokens', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    assert.equal(await getOrMigrateCredentials(churchId), null);
  }));
});

test('a different church cannot trigger or observe another church migration', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchIdA) => {
    const churchIdB = `${churchIdA}_other`;
    Database.getChurchDb(churchIdB);
    const adminA = await insertAdmin(churchIdA, 'admin@example.test');
    await seedLegacyTokens(churchIdA, adminA, { access_token: 'at-a', refresh_token: 'rt-a', expires_at: Date.now() + 3600_000 });

    assert.equal(await getOrMigrateCredentials(churchIdB), null);
    assert.equal(await countLegacyRows(churchIdB), 0);
    assert.equal(await countConnectionRows(churchIdB), 0);
    // Church A's legacy row is untouched by the church B read.
    assert.equal(await countLegacyRows(churchIdA), 1);
  }));
});
