const Database = require('../../config/database');
const { encryptCredential, decryptCredential } = require('./credentialCipher');

const FORBIDDEN_METADATA_KEYS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'credential',
  'authorization',
]);
const CONNECTION_STATUSES = new Set(['connected', 'invalid', 'validation_unavailable']);

function assertMetadataSafe(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertMetadataSafe(item);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      throw new Error(`Integration metadata cannot contain credential key "${key}"`);
    }
    assertMetadataSafe(nestedValue);
  }
}

function parseMetadata(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function toSafeConnection(row) {
  if (!row) return null;
  const metadata = parseMetadata(row.metadata);
  assertMetadataSafe(metadata);
  return {
    provider: row.provider,
    authType: row.auth_type,
    connectionStatus: row.connection_status,
    connectedAt: row.connected_at,
    lastValidatedAt: row.last_validated_at,
    lastErrorCode: row.last_error_code,
    metadata,
    metadataCachedAt: row.metadata_cached_at,
  };
}

async function upsertConnection({ churchId, provider, authType, credentials, connectedBy, metadata = {} }) {
  assertMetadataSafe(metadata);
  const encrypted = encryptCredential(credentials);
  await Database.queryForChurch(churchId, `INSERT INTO integration_connections
    (church_id, provider, auth_type, credential_ciphertext, credential_nonce,
     credential_auth_tag, credential_key_version, connection_status, connected_by, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
    ON CONFLICT(church_id, provider) DO UPDATE SET
      auth_type = excluded.auth_type,
      credential_ciphertext = excluded.credential_ciphertext,
      credential_nonce = excluded.credential_nonce,
      credential_auth_tag = excluded.credential_auth_tag,
      credential_key_version = excluded.credential_key_version,
      connection_status = 'connected', connected_by = excluded.connected_by,
      connected_at = datetime('now'), last_validated_at = NULL, last_error_code = NULL,
      metadata = excluded.metadata, metadata_cached_at = NULL, updated_at = datetime('now')`, [
    churchId, provider, authType,
    encrypted.credential_ciphertext, encrypted.credential_nonce,
    encrypted.credential_auth_tag, encrypted.credential_key_version,
    connectedBy || null, JSON.stringify(metadata),
  ]);
  return getConnection(churchId, provider);
}

async function getConnection(churchId, provider) {
  const rows = await Database.queryForChurch(churchId, `SELECT
      provider, auth_type, connection_status, connected_at, last_validated_at,
      last_error_code, metadata, metadata_cached_at
    FROM integration_connections
    WHERE church_id = ? AND provider = ?`, [churchId, provider]);
  return toSafeConnection(rows[0]);
}

async function getCredentials(churchId, provider) {
  const rows = await Database.queryForChurch(churchId, `SELECT
      credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version
    FROM integration_connections
    WHERE church_id = ? AND provider = ?`, [churchId, provider]);
  return rows[0] ? decryptCredential(rows[0]) : null;
}

async function markValidated(
  churchId,
  provider,
  { connectionStatus = 'connected', lastErrorCode = null } = {}
) {
  if (!CONNECTION_STATUSES.has(connectionStatus)) {
    throw new Error(`Unsupported integration connection status: ${connectionStatus}`);
  }
  await Database.queryForChurch(churchId, `UPDATE integration_connections
    SET connection_status = ?, last_validated_at = datetime('now'),
        last_error_code = ?, updated_at = datetime('now')
    WHERE church_id = ? AND provider = ?`, [
    connectionStatus, lastErrorCode, churchId, provider,
  ]);
  return getConnection(churchId, provider);
}

async function updateMetadataCache(churchId, provider, metadata) {
  assertMetadataSafe(metadata);
  const connection = await getConnection(churchId, provider);
  if (!connection) return null;

  const updatedMetadata = { ...connection.metadata, syncMetadata: metadata };
  await Database.queryForChurch(churchId, `UPDATE integration_connections
    SET metadata = ?, metadata_cached_at = datetime('now'), updated_at = datetime('now')
    WHERE church_id = ? AND provider = ?`, [
    JSON.stringify(updatedMetadata), churchId, provider,
  ]);
  return getConnection(churchId, provider);
}

async function disconnectConnection(churchId, provider) {
  const result = await Database.queryForChurch(
    churchId,
    'DELETE FROM integration_connections WHERE church_id = ? AND provider = ?',
    [churchId, provider]
  );
  return result.affectedRows > 0;
}

module.exports = {
  upsertConnection,
  getConnection,
  getCredentials,
  markValidated,
  updateMetadataCache,
  disconnectConnection,
};
