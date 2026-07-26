const crypto = require('node:crypto');

// Typed errors so callers (routes/integrations.js's
// resolveElvantoApiKeyOrRespond, server/index.js's startup check) can
// branch on WHICH kind of credential-encryption problem occurred instead of
// string-matching an error message — a prior fix round did the latter,
// which is fragile (a message-wording change would silently stop working)
// and untestable against the real source of the error.
//
// Two distinct failure modes, deliberately not conflated:
//   - INTEGRATION_CREDENTIALS_KEY_INVALID: the key itself is missing or
//     malformed (wrong length/encoding) — thrown by keyBuffer() before any
//     actual crypto operation is attempted.
//   - INTEGRATION_CREDENTIAL_DECRYPT_FAILED: the key is well-formed but
//     decryption's AES-GCM authentication failed — this happens when the
//     key doesn't match whatever key a STORED row was actually encrypted
//     with (e.g. the key was rotated/regenerated since), or the stored
//     ciphertext/nonce/auth-tag is corrupted. A well-formed-but-wrong key
//     round-trips its OWN freshly-encrypted value perfectly fine, so this
//     can only ever be detected against real, already-encrypted data —
//     never from encryptCredential() alone.
const INTEGRATION_CREDENTIALS_KEY_INVALID = 'INTEGRATION_CREDENTIALS_KEY_INVALID';
const INTEGRATION_CREDENTIAL_DECRYPT_FAILED = 'INTEGRATION_CREDENTIAL_DECRYPT_FAILED';

class IntegrationCredentialsKeyInvalidError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrationCredentialsKeyInvalidError';
    this.code = INTEGRATION_CREDENTIALS_KEY_INVALID;
  }
}

class IntegrationCredentialDecryptFailedError extends Error {
  constructor(cause) {
    super(
      'Failed to decrypt an integration credential — the configured encryption key may not match the key this ' +
      'credential was originally encrypted with (e.g. it was rotated or regenerated), or the stored ciphertext is corrupted.'
    );
    this.name = 'IntegrationCredentialDecryptFailedError';
    this.code = INTEGRATION_CREDENTIAL_DECRYPT_FAILED;
    // Never serialized to a client response — exists purely so a caller can
    // log the underlying crypto library error server-side if it wants to.
    this.cause = cause;
  }
}

function keyBuffer() {
  const encodedKey = process.env.INTEGRATION_CREDENTIALS_KEY || '';
  const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!canonicalBase64.test(encodedKey)) {
    throw new IntegrationCredentialsKeyInvalidError('INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key');
  }
  const key = Buffer.from(encodedKey, 'base64');
  if (key.toString('base64') !== encodedKey) {
    throw new IntegrationCredentialsKeyInvalidError('INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key');
  }
  if (key.length !== 32) {
    throw new IntegrationCredentialsKeyInvalidError('INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

function encryptCredential(value) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    credential_ciphertext: ciphertext.toString('base64'),
    credential_nonce: nonce.toString('base64'),
    credential_auth_tag: cipher.getAuthTag().toString('base64'),
    credential_key_version: 1,
  };
}

function decryptCredential(row) {
  // keyBuffer()'s own IntegrationCredentialsKeyInvalidError is allowed to
  // propagate unwrapped — a missing/malformed key is a distinct diagnosis
  // from a well-formed-but-wrong one, and this call happens BEFORE any
  // actual decryption is attempted, so it can never be confused with an
  // authentication failure below.
  const key = keyBuffer();

  // Deliberately OUTSIDE the try below: a malformed row (e.g. a null or
  // non-base64 credential_nonce/auth_tag/ciphertext) throws a plain
  // TypeError here, before any real decryption is even attempted — it must
  // never be mislabeled as IntegrationCredentialDecryptFailedError (a
  // wrong/rotated-key diagnosis). A corrupted/malformed row is a different
  // problem entirely and should propagate as whatever plain error it
  // naturally is, not be folded into "the key doesn't match."
  const nonce = Buffer.from(row.credential_nonce, 'base64');
  const authTag = Buffer.from(row.credential_auth_tag, 'base64');
  const ciphertext = Buffer.from(row.credential_ciphertext, 'base64');

  let plaintext;
  try {
    // Only the actual crypto/authentication operations are wrapped here —
    // createDecipheriv/setAuthTag/update/final failing (a bad key length,
    // or GCM authentication rejecting the ciphertext/tag) is exactly the
    // wrong-key/rotated-key/corrupted-ciphertext signature this error type
    // exists to describe, and nothing else.
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new IntegrationCredentialDecryptFailedError(err);
  }

  // A successful decrypt+authenticate that still isn't valid JSON is yet
  // another distinct failure mode (a corrupted/malformed stored value, not
  // a key problem) — let JSON.parse's own SyntaxError propagate rather
  // than folding it into the same "wrong key" diagnosis.
  return JSON.parse(plaintext);
}

module.exports = {
  encryptCredential,
  decryptCredential,
  INTEGRATION_CREDENTIALS_KEY_INVALID,
  INTEGRATION_CREDENTIAL_DECRYPT_FAILED,
  IntegrationCredentialsKeyInvalidError,
  IntegrationCredentialDecryptFailedError,
};
