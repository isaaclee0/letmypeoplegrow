const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const {
  upsertConnection,
  getConnection,
  getCredentials,
  markValidated,
  updateMetadataCache,
  disconnectConnection,
} = require('./connectionStore');
const takeoutRouter = require('../../routes/takeout');

async function withCredentialKey(callback) {
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.INTEGRATION_CREDENTIALS_KEY;
    } else {
      process.env.INTEGRATION_CREDENTIALS_KEY = previous;
    }
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

test('stores encrypted credentials and returns an exact credential-free status projection', async () => {
  // Catches plaintext persistence or a status read that starts returning a
  // whole database row, including encrypted credential material.
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const adminId = await insertAdmin(churchId, 'first-admin@example.test');
    const result = await upsertConnection({
      churchId,
      provider: 'elvanto',
      authType: 'api_key',
      credentials: { apiKey: 'church-secret-value' },
      connectedBy: adminId,
    });

    const rows = await Database.queryForChurch(
      churchId,
      'SELECT * FROM integration_connections WHERE church_id = ? AND provider = ?',
      [churchId, 'elvanto']
    );
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows[0]).includes('church-secret-value'), false);
    assert.deepEqual(await getCredentials(churchId, 'elvanto'), { apiKey: 'church-secret-value' });
    assert.deepEqual(await getConnection(churchId, 'elvanto'), {
      provider: 'elvanto',
      authType: 'api_key',
      connectionStatus: 'connected',
      connectedAt: result.connectedAt,
      lastValidatedAt: null,
      lastErrorCode: null,
      metadata: {},
      metadataCachedAt: null,
    });
  }));
});

test('a second admin replaces the church connection instead of creating a user-owned duplicate', async () => {
  // Catches accidentally scoping connections by connected_by rather than the
  // church/provider uniqueness boundary.
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    const firstAdminId = await insertAdmin(churchId, 'first-admin@example.test');
    const secondAdminId = await insertAdmin(churchId, 'second-admin@example.test');
    await upsertConnection({
      churchId,
      provider: 'elvanto',
      authType: 'api_key',
      credentials: { apiKey: 'first-secret' },
      connectedBy: firstAdminId,
    });
    await upsertConnection({
      churchId,
      provider: 'elvanto',
      authType: 'api_key',
      credentials: { apiKey: 'replacement-secret' },
      connectedBy: secondAdminId,
    });

    const rows = await Database.queryForChurch(
      churchId,
      'SELECT connected_by FROM integration_connections WHERE church_id = ? AND provider = ?',
      [churchId, 'elvanto']
    );
    assert.deepEqual(rows, [{ connected_by: secondAdminId }]);
    assert.deepEqual(await getCredentials(churchId, 'elvanto'), { apiKey: 'replacement-secret' });
  }));
});

test('a different church cannot read another church connection', async () => {
  // Catches omitting church_id from either the status or credential lookup.
  await withCredentialKey(() => withTestChurchDb(async (churchIdA) => {
    const churchIdB = `${churchIdA}_other`;
    Database.getChurchDb(churchIdB);
    await upsertConnection({
      churchId: churchIdA,
      provider: 'elvanto',
      authType: 'api_key',
      credentials: { apiKey: 'church-a-secret' },
    });

    assert.equal(await getConnection(churchIdB, 'elvanto'), null);
    assert.equal(await getCredentials(churchIdB, 'elvanto'), null);
  }));
});

test('disconnect deletes only the requested provider for the requested church', async () => {
  // Catches a broad church-level delete that disconnects unrelated providers.
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    await upsertConnection({
      churchId,
      provider: 'elvanto',
      authType: 'api_key',
      credentials: { apiKey: 'elvanto-secret' },
    });
    await upsertConnection({
      churchId,
      provider: 'planning_center',
      authType: 'oauth',
      credentials: { accessToken: 'pco-secret' },
    });

    assert.equal(await disconnectConnection(churchId, 'elvanto'), true);
    assert.equal(await getConnection(churchId, 'elvanto'), null);
    assert.equal((await getConnection(churchId, 'planning_center')).provider, 'planning_center');
  }));
});

test('validation updates only safe status fields', async () => {
  // Catches validation writes that overwrite or expose credential material.
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    await upsertConnection({
      churchId,
      provider: 'elvanto',
      authType: 'api_key',
      credentials: { apiKey: 'validation-secret' },
      metadata: { connectionLabel: 'Main account' },
    });

    const status = await markValidated(churchId, 'elvanto', {
      connectionStatus: 'invalid',
      lastErrorCode: 'ELVANTO_AUTH',
    });
    assert.equal(status.connectionStatus, 'invalid');
    assert.equal(status.lastErrorCode, 'ELVANTO_AUTH');
    assert.ok(status.lastValidatedAt);
    assert.equal(JSON.stringify(status).includes('validation-secret'), false);
    assert.deepEqual(await getCredentials(churchId, 'elvanto'), { apiKey: 'validation-secret' });
  }));
});

test('metadata cache preserves safe connection metadata and rejects credential keys recursively', async () => {
  // Catches shallow-only filtering, especially credentials nested in arrays,
  // and replacement of safe connection labels by a metadata refresh.
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    await upsertConnection({
      churchId,
      provider: 'elvanto',
      authType: 'api_key',
      credentials: { apiKey: 'stored-secret' },
      metadata: { connectionLabel: 'Main account' },
    });

    const updated = await updateMetadataCache(churchId, 'elvanto', {
      groups: [{ id: 'group-1', details: { name: 'Youth' } }],
    });
    assert.equal(updated.metadata.connectionLabel, 'Main account');
    assert.deepEqual(updated.metadata.syncMetadata, {
      groups: [{ id: 'group-1', details: { name: 'Youth' } }],
    });
    assert.ok(updated.metadataCachedAt);

    await assert.rejects(
      updateMetadataCache(churchId, 'elvanto', {
        groups: [{ id: 'group-2', nested: [{ authorization: 'Bearer secret' }] }],
      }),
      /credential/i
    );
    assert.deepEqual((await getConnection(churchId, 'elvanto')).metadata.syncMetadata, {
      groups: [{ id: 'group-1', details: { name: 'Youth' } }],
    });
  }));
});

test('connection validation metadata cannot contain credential values', async () => {
  // Catches persisting provider validation payloads that contain secret keys.
  await withCredentialKey(() => withTestChurchDb(async (churchId) => {
    await assert.rejects(
      upsertConnection({
        churchId,
        provider: 'elvanto',
        authType: 'api_key',
        credentials: { apiKey: 'stored-secret' },
        metadata: { validation: { apiKey: 'must-not-persist' } },
      }),
      /credential/i
    );
    assert.equal(await getConnection(churchId, 'elvanto'), null);
  }));
});

test('export CSV redacts encrypted credential columns and values', () => {
  // Catches either takeout/admin exporter serializing the encrypted payload,
  // its nonce/tag, or key-version material from integration_connections.
  const csv = takeoutRouter.rowsToCsv([{
    provider: 'elvanto',
    connection_status: 'connected',
    credential_ciphertext: 'ciphertext-secret',
    credential_nonce: 'nonce-secret',
    credential_auth_tag: 'auth-tag-secret',
    credential_key_version: 1,
  }]);

  assert.equal(csv, 'provider,connection_status\nelvanto,connected\n');
  assert.equal(csv.includes('ciphertext-secret'), false);
  assert.equal(csv.includes('nonce-secret'), false);
  assert.equal(csv.includes('auth-tag-secret'), false);
});

test('export CSV omits legacy credential preference rows', () => {
  // Catches column-only redaction leaking legacy secrets stored in the
  // preference_value column under a sensitive preference_key.
  const csv = takeoutRouter.rowsToCsv([
    { preference_key: 'theme', preference_value: 'dark' },
    { preference_key: 'elvanto_api_key', preference_value: 'legacy-elvanto-secret' },
    { preference_key: 'planning_center_tokens', preference_value: 'legacy-pco-secret' },
  ]);

  assert.equal(csv, 'preference_key,preference_value\ntheme,dark\n');
  assert.equal(csv.includes('legacy-elvanto-secret'), false);
  assert.equal(csv.includes('legacy-pco-secret'), false);
});
