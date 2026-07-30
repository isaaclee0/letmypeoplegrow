// Centralizes Planning Center OAuth credential storage on the encrypted,
// church-scoped integration_connections table (see connectionStore.js),
// replacing the legacy per-admin user_preferences row this codebase used
// before Task 10 (preference_key = 'planning_center_tokens', keyed by
// user_id — see the "known rough edge" this fixes, documented in CLAUDE.md:
// getTokensForChurch used to grab whichever admin's row came back from a
// LIMIT 1, no ORDER BY query, with no way to tell whether that was the only
// row or one of several disagreeing ones).
//
// Two responsibilities live here:
//   1. One-time migration of legacy user_preferences tokens the first time a
//      church's PCO credentials are read after this change ships.
//   2. A single, per-church-mutex'd refresh-and-persist path, so every caller
//      that needs a fresh access token (routes/integrations.js's various PCO
//      endpoints, the scheduled sync, check-in import) shares one in-flight
//      refresh instead of each independently calling PCO's rotating-refresh-
//      token endpoint and racing to persist the result.
//
// Nothing in this module ever logs a token value, and no path here writes a
// refreshed (or migrated) credential back into user_preferences — only into
// the encrypted integration_connections row for that church.
const Database = require('../../config/database');
const connectionStore = require('./connectionStore');

const PCO_RECONNECT_REQUIRED = 'PCO_RECONNECT_REQUIRED';

// Refresh proactively once less than this much life is left on the access
// token — matches the margin the pre-Task-10 implementation used.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

class PcoReconnectRequiredError extends Error {
  constructor(churchId) {
    super(
      'Multiple different Planning Center connections were found for this church ' +
      '(likely from more than one admin connecting independently before this migration). ' +
      'Refusing to guess which is authoritative — reconnect Planning Center to continue.'
    );
    this.name = 'PcoReconnectRequiredError';
    this.code = PCO_RECONNECT_REQUIRED;
    this.churchId = churchId;
  }
}

class PcoAuthorityConnectionRequiredError extends Error {
  constructor() {
    super('Planning Center is your authoritative people source or is pending authority review. Choose another source before disconnecting.');
    this.name = 'PcoAuthorityConnectionRequiredError';
    this.code = 'PCO_AUTHORITY_CONNECTION_REQUIRED';
    this.status = 409;
  }
}

// Every Planning Center credential mutation for a church uses this queue:
// legacy migration, OAuth replacement, refresh persistence, and disconnect.
// Refresh tokens rotate, so ordering only refresh-vs-refresh is insufficient:
// a late response for the old token must not overwrite a newer OAuth connect
// or reinsert a row an admin just deleted.
const credentialMutationQueues = new Map();

async function withCredentialMutation(churchId, operation) {
  const previous = credentialMutationQueues.get(churchId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  credentialMutationQueues.set(churchId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (credentialMutationQueues.get(churchId) === current) {
      credentialMutationQueues.delete(churchId);
    }
  }
}

function parseLegacyTokens(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Legacy shape (PCO's own wire format, snake_case) -> the canonical camelCase
// shape stored (encrypted) in integration_connections and returned by every
// function in this module.
function toCanonicalCredentials(legacyTokens) {
  if (!legacyTokens || !legacyTokens.access_token) return null;
  return {
    accessToken: legacyTokens.access_token,
    refreshToken: legacyTokens.refresh_token || null,
    expiresAt: typeof legacyTokens.expires_at === 'number' ? legacyTokens.expires_at : null,
  };
}

// Fixed key order (object literal above is always built the same way) makes
// this a stable fingerprint for exact-match deduping — never logged on its
// own since it embeds the actual token values.
function credentialFingerprint(credentials) {
  return JSON.stringify([credentials.accessToken, credentials.refreshToken, credentials.expiresAt]);
}

// Reads every legacy per-admin user_preferences row for this church. If they
// all agree on the same credential value, collapses them onto a single
// encrypted integration_connections row and deletes the legacy rows (this is
// a migration, not a duplication — leaving the legacy rows behind would let a
// later disconnect, which only clears integration_connections, "resurrect"
// the connection from stale legacy data on next access). If two DIFFERENT
// admins hold two DIFFERENT tokens for the same church, refuses to guess
// which is authoritative and throws PcoReconnectRequiredError instead —
// nothing is written or deleted in that case, leaving the ambiguous legacy
// data intact for a human (an explicit reconnect writes a definitive fresh
// row directly, sidestepping the ambiguity).
async function migrateLegacyCredentialsUnlocked(churchId) {
  // Another serialized mutation may have installed a definitive OAuth
  // connection while this migration was waiting. Never replace it with a
  // legacy per-user value.
  const existing = await connectionStore.getCredentials(churchId, 'planning_center');
  if (existing) return existing;

  const rows = await Database.queryForChurch(
    churchId,
    `SELECT user_id, preference_value FROM user_preferences
      WHERE church_id = ? AND preference_key = 'planning_center_tokens'`,
    [churchId]
  );
  if (!rows.length) return null;

  const distinct = new Map(); // fingerprint -> { credentials, userId }
  for (const row of rows) {
    const credentials = toCanonicalCredentials(parseLegacyTokens(row.preference_value));
    if (!credentials) continue;
    distinct.set(credentialFingerprint(credentials), { credentials, userId: row.user_id });
  }
  if (distinct.size === 0) return null;

  if (distinct.size > 1) {
    throw new PcoReconnectRequiredError(churchId);
  }

  const [{ credentials, userId }] = distinct.values();
  await connectionStore.upsertConnection({
    churchId,
    provider: 'planning_center',
    authType: 'oauth',
    credentials,
    connectedBy: userId || null,
  });

  await Database.queryForChurch(
    churchId,
    `DELETE FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens'`,
    [churchId]
  );

  return credentials;
}

async function migrateLegacyCredentials(churchId) {
  return withCredentialMutation(churchId, () =>
    Database.transactionForChurch(churchId, () => migrateLegacyCredentialsUnlocked(churchId))
  );
}

// Single read entry point: prefer the encrypted church connection; fall back
// to a one-time migration from legacy data. Returns null if there is no PCO
// connection at all (never connected, or already disconnected). Throws
// PcoReconnectRequiredError if legacy rows exist but disagree.
async function getOrMigrateCredentials(churchId) {
  const existing = await connectionStore.getCredentials(churchId, 'planning_center');
  if (existing) return existing;
  return migrateLegacyCredentials(churchId);
}

function isExpiringSoon(credentials, now = Date.now()) {
  return !!(credentials.expiresAt && now >= (credentials.expiresAt - REFRESH_MARGIN_MS));
}

// Reads back the fields a refresh must preserve (who connected it, any
// cached metadata) so persisting a refreshed token via connectionStore's
// upsert — which always rewrites connected_by/metadata — doesn't clobber
// them. Deliberately bypasses connectionStore's redacted getConnection()
// (which never exposes connected_by) since this is same-file, same-table,
// non-credential data.
async function readPreservedConnectionFields(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT connected_by, metadata FROM integration_connections
      WHERE church_id = ? AND provider = 'planning_center'`,
    [churchId]
  );
  if (!rows.length) return { connectedBy: null, metadata: {} };
  let metadata = {};
  try {
    metadata = rows[0].metadata ? JSON.parse(rows[0].metadata) : {};
  } catch (_) {
    metadata = {};
  }
  return { connectedBy: rows[0].connected_by, metadata };
}

// churchId -> Promise<credentials|null>. Ensures concurrent callers for the
// same church (e.g. a scheduled batch sync and a concurrent check-in import)
// share one in-flight refresh rather than each independently calling PCO's
// rotating-refresh-token endpoint — the second caller to land would
// otherwise persist a token PCO already rotated away from.
const refreshInFlight = new Map();

// Ensures `credentials` are valid, refreshing (and persisting the result to
// the SAME church-scoped integration_connections row) if they are expiring
// soon. `requestRefresh(refreshTokenValue)` must resolve to
// `{ accessToken, refreshToken, expiresAt }` or a falsy value on failure —
// callers (planningCenterSync.js) inject the real PCO HTTP call; tests inject
// a fake so this module never makes a network call itself.
async function ensureFreshCredentials(churchId, credentials, requestRefresh, { forceRefresh = false } = {}) {
  if (!credentials || !credentials.refreshToken) return credentials || null;
  if (!forceRefresh && !isExpiringSoon(credentials)) return credentials;
  if (typeof requestRefresh !== 'function') {
    throw new Error('ensureFreshCredentials requires a requestRefresh(refreshToken) function');
  }

  if (refreshInFlight.has(churchId)) return refreshInFlight.get(churchId);

  const promise = (async () => {
    // Snapshot the credential generation under the mutation queue, then
    // release it before calling PCO. A slow or stalled token endpoint must
    // never prevent an admin from reconnecting or disconnecting.
    const currentCredentials = await withCredentialMutation(churchId, () =>
      Database.transactionForChurch(churchId, () =>
        connectionStore.getCredentials(churchId, 'planning_center')
      )
    );
    if (!currentCredentials) return null;
    if (credentialFingerprint(currentCredentials) !== credentialFingerprint(credentials)) {
      return currentCredentials;
    }

    let fresh;
    let refreshError;
    try {
      fresh = await requestRefresh(currentCredentials.refreshToken);
    } catch (error) {
      refreshError = error;
    }

    return withCredentialMutation(churchId, () =>
      Database.transactionForChurch(churchId, async () => {
        // Cross-process CAS: another server process may have reconnected or
        // disconnected this church while the network refresh was in flight.
        // Re-read inside the write transaction and persist only if the exact
        // credential generation we refreshed is still current. This check
        // also makes a newer reconnect/disconnect win over a stale error.
        const latestCredentials = await connectionStore.getCredentials(churchId, 'planning_center');
        if (!latestCredentials) return null;
        if (credentialFingerprint(latestCredentials) !== credentialFingerprint(currentCredentials)) {
          return latestCredentials;
        }

        if (refreshError) throw refreshError;
        if (!fresh || !fresh.accessToken) {
          // Refresh failed (e.g. refresh token revoked). If the access token
          // is already past its real expiry there's nothing usable left;
          // otherwise hand back what remains usable until PCO rejects it.
          const trulyExpired = currentCredentials.expiresAt && Date.now() >= currentCredentials.expiresAt;
          return trulyExpired ? null : currentCredentials;
        }

        const refreshed = {
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken || currentCredentials.refreshToken,
          expiresAt: fresh.expiresAt,
        };
        const { connectedBy, metadata } = await readPreservedConnectionFields(churchId);
        await connectionStore.upsertConnection({
          churchId,
          provider: 'planning_center',
          authType: 'oauth',
          credentials: refreshed,
          connectedBy,
          metadata,
        });
        return refreshed;
      })
    );
  })();

  refreshInFlight.set(churchId, promise);
  try {
    return await promise;
  } finally {
    refreshInFlight.delete(churchId);
  }
}

// OAuth callback write. Kept here so reconnect participates in the same
// per-church mutation order as an already-running refresh.
async function replaceConnection({ churchId, credentials, connectedBy, metadata = {} }) {
  return withCredentialMutation(churchId, () =>
    Database.transactionForChurch(churchId, () => connectionStore.upsertConnection({
      churchId,
      provider: 'planning_center',
      authType: 'oauth',
      credentials,
      connectedBy,
      metadata,
    }))
  );
}

// Disconnect checks active AND pending authority in the same church
// transaction that deletes credentials. The transaction shares the database
// lock with reviewed authority activation, so either disconnect wins before
// activation or activation wins and disconnect is rejected; active PCO can
// never be committed without a connection because of this race.
async function disconnectConnection(churchId) {
  return withCredentialMutation(churchId, () => Database.transactionForChurch(churchId, async (conn) => {
    const [authority] = await conn.query(
      `SELECT authority_provider, pending_authority_provider
         FROM people_sync_settings
        WHERE church_id = ?
        LIMIT 1`,
      [churchId]
    );
    if (authority?.authority_provider === 'planning_center' ||
        authority?.pending_authority_provider === 'planning_center') {
      throw new PcoAuthorityConnectionRequiredError();
    }

    const result = await conn.query(
      `DELETE FROM integration_connections
        WHERE church_id = ? AND provider = 'planning_center'`,
      [churchId]
    );
    await conn.query(
      `DELETE FROM user_preferences
        WHERE church_id = ? AND preference_key = 'planning_center_tokens'`,
      [churchId]
    );
    return result.affectedRows > 0;
  }));
}

// Convenience: read-or-migrate, then ensure freshness. The one call most
// callers actually want.
async function getValidCredentials(churchId, requestRefresh, { forceRefresh = false } = {}) {
  const stored = await getOrMigrateCredentials(churchId);
  if (!stored) return null;
  return ensureFreshCredentials(churchId, stored, requestRefresh, { forceRefresh });
}

module.exports = {
  PCO_RECONNECT_REQUIRED,
  PcoReconnectRequiredError,
  getOrMigrateCredentials,
  migrateLegacyCredentials,
  ensureFreshCredentials,
  getValidCredentials,
  replaceConnection,
  disconnectConnection,
  PcoAuthorityConnectionRequiredError,
};
