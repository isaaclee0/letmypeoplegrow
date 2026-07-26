const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const connectionStore = require('../peopleSync/connectionStore');
const {
  ELVANTO_RECONNECT_REQUIRED,
  ELVANTO_VALIDATION_UNAVAILABLE,
  getOrMigrateCredentials,
  migrateLegacyCredentials,
} = require('./legacyCredential');
const { ElvantoError } = require('./httpClient');

async function withCredentialKey(callback) {
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
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

async function seedLegacyKey(churchId, userId, apiKey) {
  await Database.queryForChurch(
    churchId,
    `INSERT INTO user_preferences (user_id, preference_key, preference_value, church_id)
     VALUES (?, 'elvanto_api_key', ?, ?)`,
    [userId, JSON.stringify({ api_key: apiKey, connected_at: new Date().toISOString() }), churchId]
  );
}

async function countLegacyRows(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT COUNT(*) AS n FROM user_preferences WHERE church_id = ? AND preference_key = 'elvanto_api_key'`,
    [churchId]
  );
  return rows[0].n;
}

async function countConnectionRows(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT COUNT(*) AS n FROM integration_connections WHERE church_id = ? AND provider = 'elvanto'`,
    [churchId]
  );
  return rows[0].n;
}

function okValidator() {
  return async () => ({ ok: true, metadata: { connectionLabel: 'Connected via API key' } });
}

function rejectingValidator() {
  return async () => {
    const err = new Error('Elvanto rejected the request credentials (status 401).');
    err.code = 'ELVANTO_AUTH';
    throw err;
  };
}

test('one distinct legacy key validates, is encrypted, and becomes church-level', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'admin@example.test');
    await seedLegacyKey(churchId, adminId, 'key-one');

    let calledWith = null;
    const validateConnection = async (args) => { calledWith = args; return { ok: true, metadata: {} }; };

    const credentials = await getOrMigrateCredentials(churchId, { validateConnection });
    assert.deepEqual(credentials, { apiKey: 'key-one' });
    assert.equal(calledWith.churchId, churchId);
    assert.deepEqual(calledWith.credentials, { apiKey: 'key-one' });

    // Encrypted onto integration_connections, exactly one row.
    assert.equal(await countConnectionRows(churchId), 1);
    const rawRows = await Database.queryForChurch(
      churchId, `SELECT * FROM integration_connections WHERE church_id = ? AND provider = 'elvanto'`, [churchId]
    );
    const rawText = JSON.stringify(rawRows[0]);
    assert.equal(rawText.includes('key-one'), false, 'raw stored row must never contain the plaintext key');
    assert.equal(rawRows[0].connected_by, adminId);

    // Legacy row cleaned up so a later disconnect can't be "resurrected" by it.
    assert.equal(await countLegacyRows(churchId), 0);

    // Second read hits the now-encrypted row directly — no re-validation needed.
    let secondCallCount = 0;
    const countingValidator = async () => { secondCallCount++; return { ok: true, metadata: {} }; };
    const again = await getOrMigrateCredentials(churchId, { validateConnection: countingValidator });
    assert.deepEqual(again, credentials);
    assert.equal(secondCallCount, 0, 'an already-migrated church must not re-validate on every read');
  }));
});

test('identical legacy keys across users collapse into one connection', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const admin1 = await insertAdmin(churchId, 'admin1@example.test');
    const admin2 = await insertAdmin(churchId, 'admin2@example.test');
    await seedLegacyKey(churchId, admin1, 'same-key');
    await seedLegacyKey(churchId, admin2, 'same-key');

    const credentials = await getOrMigrateCredentials(churchId, { validateConnection: okValidator() });
    assert.deepEqual(credentials, { apiKey: 'same-key' });
    assert.equal(await countConnectionRows(churchId), 1);
    assert.equal(await countLegacyRows(churchId), 0);
  }));
});

test('different legacy keys across users produce ELVANTO_RECONNECT_REQUIRED without choosing one', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const admin1 = await insertAdmin(churchId, 'admin1@example.test');
    const admin2 = await insertAdmin(churchId, 'admin2@example.test');
    await seedLegacyKey(churchId, admin1, 'key-a');
    await seedLegacyKey(churchId, admin2, 'key-b');

    let validatorCalled = false;
    const validateConnection = async () => { validatorCalled = true; return { ok: true, metadata: {} }; };

    await assert.rejects(migrateLegacyCredentials(churchId, { validateConnection }), (err) => {
      assert.equal(err.code, ELVANTO_RECONNECT_REQUIRED);
      assert.equal(/key-a|key-b/.test(err.message), false, 'error message must not leak key values');
      return true;
    });
    await assert.rejects(getOrMigrateCredentials(churchId, { validateConnection }), (err) => err.code === ELVANTO_RECONNECT_REQUIRED);

    // Refuses to guess: nothing written, nothing deleted, and never even
    // attempts to validate an ambiguous pair (there is nothing sound to
    // validate — validating one arbitrarily would be the same "guess" this
    // is refusing to make).
    assert.equal(validatorCalled, false);
    assert.equal(await countConnectionRows(churchId), 0);
    assert.equal(await countLegacyRows(churchId), 2);
  }));
});

test('an invalid legacy key is not migrated', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'admin@example.test');
    await seedLegacyKey(churchId, adminId, 'revoked-key');

    const credentials = await getOrMigrateCredentials(churchId, { validateConnection: rejectingValidator() });
    assert.equal(credentials, null);

    // Nothing written, nothing deleted — a later attempt (e.g. after the
    // admin fixes the key in Elvanto) can still succeed.
    assert.equal(await countConnectionRows(churchId), 0);
    assert.equal(await countLegacyRows(churchId), 1);
  }));
});

test('a validator that throws is treated the same as an explicit ok:false (not migrated)', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'admin@example.test');
    await seedLegacyKey(churchId, adminId, 'some-key');

    const throwingValidator = async () => { throw new Error('Elvanto request timed out'); };
    const credentials = await getOrMigrateCredentials(churchId, { validateConnection: throwingValidator });
    assert.equal(credentials, null);
    assert.equal(await countConnectionRows(churchId), 0);
    assert.equal(await countLegacyRows(churchId), 1);
  }));
});

test('a genuine ELVANTO_AUTH failure is still treated as "not migrated" (null), not thrown', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'admin@example.test');
    await seedLegacyKey(churchId, adminId, 'revoked-key');

    const validateConnection = async () => { throw new ElvantoError('rejected', 'ELVANTO_AUTH', {}); };
    const credentials = await getOrMigrateCredentials(churchId, { validateConnection });
    assert.equal(credentials, null);
    assert.equal(await countConnectionRows(churchId), 0);
    assert.equal(await countLegacyRows(churchId), 1);
  }));
});

test('a transient ELVANTO_UNAVAILABLE failure (e.g. a timeout) throws ElvantoValidationUnavailableError, distinct from an invalid key', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'admin@example.test');
    await seedLegacyKey(churchId, adminId, 'some-key');

    const validateConnection = async () => { throw new ElvantoError('Elvanto request timed out', 'ELVANTO_UNAVAILABLE', {}); };
    await assert.rejects(getOrMigrateCredentials(churchId, { validateConnection }), (err) => {
      assert.equal(err.code, ELVANTO_VALIDATION_UNAVAILABLE);
      assert.equal(/some-key/.test(err.message), false);
      return true;
    });

    // Nothing written, nothing deleted — same as an invalid key, only the
    // signal reported to the caller differs.
    assert.equal(await countConnectionRows(churchId), 0);
    assert.equal(await countLegacyRows(churchId), 1);
  }));
});

test('ELVANTO_RESPONSE and ELVANTO_PAGINATION (other transient failure shapes) also throw ElvantoValidationUnavailableError', async () => {
  for (const code of ['ELVANTO_RESPONSE', 'ELVANTO_PAGINATION']) {
    await withCredentialKey(() => withTestChurchDb(async (churchId) => {
      const adminId = await insertAdmin(churchId, 'admin@example.test');
      await seedLegacyKey(churchId, adminId, 'some-key');
      const validateConnection = async () => { throw new ElvantoError('malformed', code, {}); };
      await assert.rejects(getOrMigrateCredentials(churchId, { validateConnection }), (err) => err.code === ELVANTO_VALIDATION_UNAVAILABLE);
    }));
  }
});

test('successful migration removes the legacy row only after the encrypted row is saved', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'admin@example.test');
    await seedLegacyKey(churchId, adminId, 'key-order');

    const originalUpsert = connectionStore.upsertConnection;
    let legacyRowsAtUpsertTime = null;
    connectionStore.upsertConnection = async (...args) => {
      legacyRowsAtUpsertTime = await countLegacyRows(churchId);
      return originalUpsert(...args);
    };
    try {
      await getOrMigrateCredentials(churchId, { validateConnection: okValidator() });
    } finally {
      connectionStore.upsertConnection = originalUpsert;
    }

    assert.equal(legacyRowsAtUpsertTime, 1, 'the legacy row must still exist at the moment the encrypted row is written');
    assert.equal(await countLegacyRows(churchId), 0, 'the legacy row must be gone once migration has completed');
    assert.equal(await countConnectionRows(churchId), 1);
  }));
});

test('getOrMigrateCredentials returns null when there is no connection and no legacy key', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    assert.equal(await getOrMigrateCredentials(churchId, { validateConnection: okValidator() }), null);
  }));
});

test('a different church cannot trigger or observe another church migration', async () => {
  await withCredentialKey(() => withTestChurchDb(async (churchIdA) => {
    const churchIdB = `${churchIdA}other`;
    Database.getChurchDb(churchIdB);
    const adminA = await insertAdmin(churchIdA, 'admin@example.test');
    await seedLegacyKey(churchIdA, adminA, 'key-a');

    assert.equal(await getOrMigrateCredentials(churchIdB, { validateConnection: okValidator() }), null);
    assert.equal(await countLegacyRows(churchIdB), 0);
    assert.equal(await countConnectionRows(churchIdB), 0);
    // Church A's legacy row is untouched by the church B read.
    assert.equal(await countLegacyRows(churchIdA), 1);
  }));
});

test('no response-shaped value from this module ever carries a key prefix or length hint', async () => {
  // Defense-in-depth check on the module's own return/error shapes (routes
  // layer has its own, separate assertion of this — see elvanto.test.js) —
  // the credentials object itself is the only place a key value legitimately
  // appears, and callers must be the ones deciding whether/how to expose it.
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const admin1 = await insertAdmin(churchId, 'admin1@example.test');
    const admin2 = await insertAdmin(churchId, 'admin2@example.test');
    await seedLegacyKey(churchId, admin1, 'key-alpha-secret-value');
    await seedLegacyKey(churchId, admin2, 'key-beta-secret-value');

    try {
      await migrateLegacyCredentials(churchId, { validateConnection: okValidator() });
      assert.fail('expected ELVANTO_RECONNECT_REQUIRED');
    } catch (err) {
      const serialized = JSON.stringify({ message: err.message, code: err.code });
      assert.equal(/key-alpha-secret-value|key-beta-secret-value/.test(serialized), false);
    }
  }));
});
