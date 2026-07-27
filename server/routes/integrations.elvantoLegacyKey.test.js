'use strict';

// Route-level coverage for the encrypted, church-scoped credential lookup
// shared by the retained Elvanto gathering endpoints. User-preference
// migration is deliberately not part of this boundary anymore.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { resolveElvantoApiKeyOrRespond } = require('./integrations');
const connectionStore = require('../services/peopleSync/connectionStore');
const credentialCipher = require('../services/peopleSync/credentialCipher');

function realCipherError(envValue, action) {
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = envValue;
  try {
    action();
    throw new Error('expected the real cipher call to throw, but it did not');
  } catch (error) {
    return error;
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = previous;
  }
}

function buildServer(user) {
  const app = express();
  app.use((req, res, next) => { req.user = user; next(); });
  app.get('/test', async (req, res) => {
    const apiKey = await resolveElvantoApiKeyOrRespond(req, res);
    if (apiKey) res.json({ apiKey });
  });
  return http.createServer(app);
}

async function withServer(user, callback) {
  const server = buildServer(user);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    return await callback(`http://127.0.0.1:${server.address().port}/test`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function withMockedCredentials(fn, callback) {
  const original = connectionStore.getCredentials;
  connectionStore.getCredentials = fn;
  try {
    return await callback();
  } finally {
    connectionStore.getCredentials = original;
  }
}

test('gathering credential lookup reads the encrypted church connection', async () => {
  const calls = [];
  await withMockedCredentials(async (...args) => { calls.push(args); return { apiKey: 'k-1' }; }, async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 200);
      assert.equal(body.apiKey, 'k-1');
    });
  });
  assert.deepEqual(calls, [['church1', 'elvanto']]);
});

test('gathering credential lookup responds 401 when no encrypted connection exists', async () => {
  await withMockedCredentials(async () => null, async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 401);
      assert.match(body.error, /not connected/i);
    });
  });
});

test('gathering credential lookup reports a missing encryption key as server configuration, not disconnection', async () => {
  const realError = realCipherError('', () => credentialCipher.encryptCredential({ probe: true }));
  assert.equal(realError.code, credentialCipher.INTEGRATION_CREDENTIALS_KEY_INVALID);

  await withMockedCredentials(async () => { throw realError; }, async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 500);
      assert.match(body.error, /not fully configured/i);
    });
  });
});

test('gathering credential lookup reports a rotated encryption key distinctly', async () => {
  const keyA = require('node:crypto').randomBytes(32).toString('base64');
  const keyB = require('node:crypto').randomBytes(32).toString('base64');
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = keyA;
  const encrypted = credentialCipher.encryptCredential({ apiKey: 'k-1' });
  process.env.INTEGRATION_CREDENTIALS_KEY = keyB;
  let realError;
  try {
    credentialCipher.decryptCredential(encrypted);
    assert.fail('expected decryption under a different key to fail');
  } catch (error) {
    realError = error;
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = previous;
  }
  assert.equal(realError.code, credentialCipher.INTEGRATION_CREDENTIAL_DECRYPT_FAILED);

  await withMockedCredentials(async () => { throw realError; }, async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 500);
      assert.match(body.error, /rotated or changed/i);
    });
  });
});

test('gathering credential lookup does not leak unexpected storage errors', async () => {
  await withMockedCredentials(async () => { throw new Error('encrypted row internal detail'); }, async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 500);
      assert.equal(/internal detail/.test(JSON.stringify(body)), false);
    });
  });
});
