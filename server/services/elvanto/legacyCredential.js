'use strict';

// Elvanto counterpart to server/services/peopleSync/pcoCredentialMigration.js
// (Task 10) — see that module's header note for the general shape this
// mirrors: migrating a legacy, per-admin `user_preferences` credential row
// onto the encrypted, church-scoped `integration_connections` table
// (connectionStore.js) the first time it is read after this feature ships.
//
// Legacy storage (confirmed by reading the pre-Task-16 handlers in
// server/routes/integrations.js — getElvantoApiKey/`/elvanto/connect`/
// `/elvanto/disconnect`): `user_preferences.preference_key = 'elvanto_api_key'`,
// one row PER USER (`UNIQUE(user_id, preference_key)`), `preference_value` a
// JSON blob `{ api_key: string, connected_at: isoString }`.
//
// Differs from PCO's migration in exactly one way that matters: an Elvanto
// API key carries no built-in expiry/refresh-token machinery to lean on —
// there is no independent signal that a legacy key is still good other than
// actually calling Elvanto with it (PCO's migration, by contrast, never
// validates; it trusts the stored token and lets the normal refresh/401
// path discover staleness later). This module therefore validates the sole
// distinct legacy key via the real Elvanto adapter's validateConnection()
// before ever writing it to the encrypted store or deleting the legacy
// row(s) — an invalid legacy key is left completely untouched (nothing
// written, nothing deleted) rather than migrated, so a later attempt (e.g.
// once the admin corrects the key in Elvanto) can still succeed.
//
// Safety properties mirrored exactly from pcoCredentialMigration.js:
//   - distinct legacy values are compared by an exact credential-equality
//     fingerprint, never by picking "the first" or "the newest" row;
//   - two DIFFERENT legacy keys for the same church throw
//     ELVANTO_RECONNECT_REQUIRED and touch nothing (no guessing);
//   - a successful migration only deletes the legacy row(s) AFTER the
//     encrypted connectionStore row has been durably written;
//   - nothing here ever logs, or embeds in an error/message, a raw key
//     value, a prefix, or a length — every error message is a fixed string,
//     never built from the key itself.
const Database = require('../../config/database');
const connectionStore = require('../peopleSync/connectionStore');
const { ElvantoError } = require('./httpClient');

const LEGACY_PREFERENCE_KEY = 'elvanto_api_key';
const ELVANTO_RECONNECT_REQUIRED = 'ELVANTO_RECONNECT_REQUIRED';
const ELVANTO_VALIDATION_UNAVAILABLE = 'ELVANTO_VALIDATION_UNAVAILABLE';

class ElvantoReconnectRequiredError extends Error {
  constructor(churchId) {
    super(
      'Multiple different Elvanto API keys were found for this church ' +
      '(likely from more than one admin connecting independently before this migration). ' +
      'Refusing to guess which is authoritative — reconnect Elvanto to continue.'
    );
    this.name = 'ElvantoReconnectRequiredError';
    this.code = ELVANTO_RECONNECT_REQUIRED;
    this.churchId = churchId;
  }
}

// Thrown (never returned as null) when the sole distinct legacy key could
// not be VERIFIED one way or the other because Elvanto itself was
// unreachable/misbehaving (ELVANTO_UNAVAILABLE/ELVANTO_RESPONSE/
// ELVANTO_PAGINATION — including a plain request timeout, all classified
// this way by httpClient.js) — as opposed to ELVANTO_AUTH, a definitive
// "this key is wrong" verdict. Conflating the two used to report both as a
// flat "not connected", which is misleading (a transient outage is not a
// verdict on the key) and, left unclassified, gets silently retried on
// every single request that needs credentials until it eventually succeeds
// or someone notices. Nothing is migrated either way — only the ERROR
// REPORTED to the caller differs; callers that don't care can still treat
// this the same as an invalid key by catching it and returning null
// themselves.
class ElvantoValidationUnavailableError extends Error {
  constructor(churchId, cause) {
    super('Elvanto could not be reached to verify the legacy API key; try again shortly.');
    this.name = 'ElvantoValidationUnavailableError';
    this.code = ELVANTO_VALIDATION_UNAVAILABLE;
    this.churchId = churchId;
    // Never serialize `.cause` to a client response — it may carry
    // provider-side detail (path/status); it exists purely for server-side
    // logging by whichever caller catches this.
    this.cause = cause;
  }
}

function parseLegacyValue(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Legacy shape (`{ api_key, connected_at }`) -> the canonical credentials
// shape this module (and connectionStore/the real adapter) use everywhere:
// `{ apiKey }`.
function toCanonicalCredentials(legacyValue) {
  const apiKey = legacyValue && typeof legacyValue.api_key === 'string' ? legacyValue.api_key.trim() : '';
  return apiKey ? { apiKey } : null;
}

// Fixed key order (object literal above is always built the same way) makes
// this a stable fingerprint for exact-match deduping — never logged on its
// own since it embeds the actual key value.
function credentialFingerprint(credentials) {
  return JSON.stringify([credentials.apiKey]);
}

// Lazy require: avoids a require-time cycle risk with adapter.js (which does
// not currently require this module, but keeping this lazy matches
// providerRegistry.js's own lazy-require convention for the exact same
// module) and means a test that only exercises the migration/collapse/
// reconnect-required paths (never the "one distinct, must actually
// validate" path) need not load the real HTTP-backed adapter at all.
async function defaultValidateConnection({ churchId, credentials }) {
  const { createElvantoAdapter } = require('./adapter');
  return createElvantoAdapter().validateConnection({ churchId, credentials });
}

// Reads every legacy per-admin user_preferences row for this church. If they
// all agree on the same API key, validates that sole distinct key live
// against Elvanto and — only if valid — collapses them onto a single
// encrypted integration_connections row, then deletes the legacy row(s)
// (this is a migration, not a duplication — leaving legacy rows behind would
// let a later disconnect, which only clears integration_connections,
// "resurrect" the connection from stale legacy data on next access). If two
// DIFFERENT admins hold two DIFFERENT keys for the same church, refuses to
// guess which is authoritative and throws ElvantoReconnectRequiredError
// instead — nothing is written or deleted in that case, leaving the
// ambiguous legacy data intact for a human (an explicit reconnect writes a
// definitive fresh row directly, sidestepping the ambiguity). If the sole
// distinct key fails live validation with a definitive ELVANTO_AUTH verdict,
// nothing is migrated (or deleted) — this returns null exactly as if there
// were no usable legacy credentials, so a caller cannot distinguish "no
// legacy data" from "invalid legacy data" from this return value alone,
// which is deliberate: neither case has anything safe to hand back to a
// caller expecting real, working credentials. If validation instead fails
// because Elvanto itself was unreachable/misbehaving (not a verdict on the
// key), this throws ElvantoValidationUnavailableError instead of returning
// null, so a caller CAN distinguish "definitely bad" from "temporarily
// unknown" if it wants to (e.g. to report 503 instead of "not connected").
async function migrateLegacyCredentials(churchId, { validateConnection = defaultValidateConnection } = {}) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT user_id, preference_value FROM user_preferences
      WHERE church_id = ? AND preference_key = ?`,
    [churchId, LEGACY_PREFERENCE_KEY]
  );
  if (!rows.length) return null;

  const distinct = new Map(); // fingerprint -> { credentials, userId }
  for (const row of rows) {
    const credentials = toCanonicalCredentials(parseLegacyValue(row.preference_value));
    if (!credentials) continue;
    distinct.set(credentialFingerprint(credentials), { credentials, userId: row.user_id });
  }
  if (distinct.size === 0) return null;

  if (distinct.size > 1) {
    throw new ElvantoReconnectRequiredError(churchId);
  }

  const [{ credentials, userId }] = distinct.values();

  let validation = null;
  let validationError = null;
  try {
    validation = await validateConnection({ churchId, credentials });
  } catch (err) {
    validationError = err;
  }
  if (!validation || validation.ok !== true) {
    // Leave everything untouched either way (nothing written, nothing
    // deleted) — not cached as a permanent failure, a later call (e.g. once
    // the admin fixes the key, or once Elvanto is reachable again) may
    // still succeed. But distinguish WHY for a caller that cares: a
    // transient failure (Elvanto unreachable/misbehaving, including a
    // timeout) is not the same fact as a definitive "this key is wrong"
    // (ELVANTO_AUTH), so it is not silently folded into the same "return
    // null" path.
    if (validationError instanceof ElvantoError && validationError.code !== 'ELVANTO_AUTH') {
      throw new ElvantoValidationUnavailableError(churchId, validationError);
    }
    return null;
  }

  await connectionStore.upsertConnection({
    churchId,
    provider: 'elvanto',
    authType: 'api_key',
    credentials,
    connectedBy: userId || null,
    metadata: (validation && validation.metadata) || {},
  });

  await Database.queryForChurch(
    churchId,
    `DELETE FROM user_preferences WHERE church_id = ? AND preference_key = ?`,
    [churchId, LEGACY_PREFERENCE_KEY]
  );

  return credentials;
}

// Single read entry point: prefer the encrypted church connection; fall back
// to a one-time (validated) migration from legacy data. Returns null if
// there is no Elvanto connection at all (never connected, a definitively
// invalid legacy key, or already disconnected). Throws
// ElvantoReconnectRequiredError if legacy rows exist but disagree, or
// ElvantoValidationUnavailableError if the sole distinct legacy key could
// not be verified because Elvanto itself was unreachable.
//
// Note: `connectionStore.getCredentials` itself throws a plain Error (not
// one of this module's typed errors) if INTEGRATION_CREDENTIALS_KEY is
// missing/invalid — server misconfiguration, not a credential-migration
// concern, so this module deliberately does not wrap or reclassify it;
// callers should treat an error that isn't one of this module's own typed
// errors as a possible config problem (see routes/integrations.js's
// resolveElvantoApiKeyOrRespond for the one place that currently does).
async function getOrMigrateCredentials(churchId, overrides = {}) {
  const existing = await connectionStore.getCredentials(churchId, 'elvanto');
  if (existing) return existing;
  return migrateLegacyCredentials(churchId, overrides);
}

module.exports = {
  LEGACY_PREFERENCE_KEY,
  ELVANTO_RECONNECT_REQUIRED,
  ELVANTO_VALIDATION_UNAVAILABLE,
  ElvantoReconnectRequiredError,
  ElvantoValidationUnavailableError,
  migrateLegacyCredentials,
  getOrMigrateCredentials,
};
