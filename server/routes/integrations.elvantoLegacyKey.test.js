'use strict';

// Lightweight (no real DB) route-level tests for
// resolveElvantoApiKeyOrRespond — the helper the nine preserved legacy
// one-shot gathering/people/family import routes in routes/integrations.js
// all share (see the NOTE above `/elvanto/debug-dump` in that file).
//
// A critical bug (found in review of commit 9a5c9b8) reproduced empirically
// with a real DB: a deployment without INTEGRATION_CREDENTIALS_KEY set,
// with a valid legacy key sitting in user_preferences, would have
// getOrMigrateCredentials's encryption call throw a plain Error, which the
// OLD getElvantoApiKey caught and swallowed into a flat `null` — so every
// preserved import route answered a misleading 401 "not connected" even
// though a perfectly good key was sitting right there. Same shape of bug
// existed for ELVANTO_RECONNECT_REQUIRED (swallowed to the same flat 401,
// with the one-shot import routes then a dead end for the admin) and for a
// transient Elvanto outage during migration validation. These tests pin
// resolveElvantoApiKeyOrRespond's actual response for each of those cases
// directly, via a real Express request/response cycle (only the
// legacyCredential module's export is monkey-patched — matching this
// codebase's own established pattern for this, e.g.
// legacyCredential.dbintegration.test.js's own temporary
// connectionStore.upsertConnection monkey-patch).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const { resolveElvantoApiKeyOrRespond } = require('./integrations');
const legacyCredential = require('../services/elvanto/legacyCredential');
const credentialCipher = require('../services/peopleSync/credentialCipher');

// Captures the REAL error credentialCipher.js throws for a given
// INTEGRATION_CREDENTIALS_KEY env value, by actually calling the real
// cipher — rather than hand-writing a string that merely resembles it.
// This is the point: if a future change to credentialCipher.js's error
// wording, code, or type ever drifts from what resolveElvantoApiKeyOrRespond
// branches on, THIS test (which exercises the real linkage) fails — a
// hand-written string could never catch that.
function realCipherError(envValue, action) {
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = envValue;
  try {
    action();
    throw new Error('expected the real cipher call to throw, but it did not');
  } catch (err) {
    return err;
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
    if (!apiKey) return; // a response has already been written
    res.json({ apiKey });
  });
  return http.createServer(app);
}

async function withServer(user, callback) {
  const server = buildServer(user);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}/test`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(url) {
  const res = await fetch(url);
  let body = null;
  try { body = await res.json(); } catch (_) { body = null; }
  return { status: res.status, body };
}

// Temporarily replaces legacyCredential.getOrMigrateCredentials for the
// duration of `callback`, always restoring the real function afterward
// (even if callback throws) — the same monkey-patch-and-restore pattern
// legacyCredential.dbintegration.test.js already uses for
// connectionStore.upsertConnection.
async function withMockedGetOrMigrate(fn, callback) {
  const original = legacyCredential.getOrMigrateCredentials;
  legacyCredential.getOrMigrateCredentials = fn;
  try {
    return await callback();
  } finally {
    legacyCredential.getOrMigrateCredentials = original;
  }
}

test('resolveElvantoApiKeyOrRespond returns the apiKey when connected', async () => {
  await withMockedGetOrMigrate(async () => ({ apiKey: 'k-1' }), async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 200);
      assert.equal(body.apiKey, 'k-1');
    });
  });
});

test('resolveElvantoApiKeyOrRespond responds 401 "not connected" when there is no credential at all', async () => {
  await withMockedGetOrMigrate(async () => null, async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 401);
      assert.match(body.error, /not connected/i);
    });
  });
});

test('resolveElvantoApiKeyOrRespond responds 409 with code ELVANTO_RECONNECT_REQUIRED when legacy keys disagree (not a flat 401 dead end)', async () => {
  await withMockedGetOrMigrate(async () => { throw new legacyCredential.ElvantoReconnectRequiredError('church1'); }, async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 409);
      assert.equal(body.code, 'ELVANTO_RECONNECT_REQUIRED');
    });
  });
});

test('resolveElvantoApiKeyOrRespond responds 503 (not a flat "not connected") when Elvanto is transiently unavailable during migration validation', async () => {
  await withMockedGetOrMigrate(async () => { throw new legacyCredential.ElvantoValidationUnavailableError('church1'); }, async () => {
    await withServer({ church_id: 'church1' }, async (url) => {
      const { status, body } = await requestJson(url);
      assert.equal(status, 503);
      assert.equal(body.code, 'ELVANTO_VALIDATION_UNAVAILABLE');
    });
  });
});

// The critical bug: reproduces the REAL error credentialCipher.js's
// keyBuffer() throws because INTEGRATION_CREDENTIALS_KEY is unset — the
// exact error connectionStore.getCredentials/upsertConnection raise in that
// configuration, reached via getOrMigrateCredentials. Constructed via the
// actual cipher call (not a hand-written string), so a future change to
// that module's error code/type can't silently break this detection
// without this test catching it.
test('resolveElvantoApiKeyOrRespond responds 500 (not a misleading 401) when INTEGRATION_CREDENTIALS_KEY is missing or invalid', async () => {
  const realError = realCipherError('', () => credentialCipher.encryptCredential({ probe: true }));
  assert.equal(realError.code, credentialCipher.INTEGRATION_CREDENTIALS_KEY_INVALID);

  await withMockedGetOrMigrate(
    async () => { throw realError; },
    async () => {
      await withServer({ church_id: 'church1' }, async (url) => {
        const { status, body } = await requestJson(url);
        assert.equal(status, 500);
        assert.match(body.error, /not fully configured/i);
      });
    }
  );
});

// The rotated/mismatched-key case: a WELL-FORMED key that simply isn't the
// one a real row was encrypted with. Constructed by actually encrypting
// under one real key and decrypting under a different one, so this test
// exercises the genuine AES-GCM authentication failure, not a stand-in.
test('resolveElvantoApiKeyOrRespond responds 500 with a rotated-key-specific message when a stored credential fails to decrypt under the current key', async () => {
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
  } catch (err) {
    realError = err;
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = previous;
  }
  assert.equal(realError.code, credentialCipher.INTEGRATION_CREDENTIAL_DECRYPT_FAILED);

  await withMockedGetOrMigrate(
    async () => { throw realError; },
    async () => {
      await withServer({ church_id: 'church1' }, async (url) => {
        const { status, body } = await requestJson(url);
        assert.equal(status, 500);
        assert.match(body.error, /rotated or changed/i);
      });
    }
  );
});

test('resolveElvantoApiKeyOrRespond responds 500 for a genuinely unexpected error, without leaking its raw message', async () => {
  await withMockedGetOrMigrate(
    async () => { throw new Error('table user_preferences has no column named foo (internal detail)'); },
    async () => {
      await withServer({ church_id: 'church1' }, async (url) => {
        const { status, body } = await requestJson(url);
        assert.equal(status, 500);
        assert.equal(/user_preferences|no column|internal detail/.test(JSON.stringify(body)), false);
      });
    }
  );
});
