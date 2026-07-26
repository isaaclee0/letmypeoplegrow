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

// The critical bug: reproduces credentialCipher.js's keyBuffer() throwing
// because INTEGRATION_CREDENTIALS_KEY is unset/invalid — the exact error
// connectionStore.getCredentials/upsertConnection raise in that
// configuration, reached via getOrMigrateCredentials.
test('resolveElvantoApiKeyOrRespond responds 500 (not a misleading 401) when INTEGRATION_CREDENTIALS_KEY is missing or invalid', async () => {
  await withMockedGetOrMigrate(
    async () => { throw new Error('INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key'); },
    async () => {
      await withServer({ church_id: 'church1' }, async (url) => {
        const { status, body } = await requestJson(url);
        assert.equal(status, 500);
        assert.match(body.error, /not fully configured/i);
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
