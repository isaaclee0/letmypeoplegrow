const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  encryptCredential,
  decryptCredential,
  INTEGRATION_CREDENTIAL_DECRYPT_FAILED,
} = require('./credentialCipher');

function withCredentialKey(value, callback) {
  const previous = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = value;
  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.INTEGRATION_CREDENTIALS_KEY;
    } else {
      process.env.INTEGRATION_CREDENTIALS_KEY = previous;
    }
  }
}

test('credential cipher round-trips JSON without exposing plaintext', () => {
  // Catches plaintext storage, a wrong algorithm/key size, or loss of the
  // structured credential payload during encryption and decryption.
  withCredentialKey(Buffer.alloc(32, 7).toString('base64'), () => {
    const encrypted = encryptCredential({ apiKey: 'secret-value' });
    assert.equal(encrypted.credential_ciphertext.includes('secret-value'), false);
    assert.deepEqual(decryptCredential(encrypted), { apiKey: 'secret-value' });
  });
});

test('credential cipher rejects an invalid key', () => {
  // Catches accepting a deployment key that cannot provide AES-256 security.
  withCredentialKey(Buffer.alloc(16).toString('base64'), () => {
    assert.throws(() => encryptCredential({ apiKey: 'x' }), /32-byte/);
  });
});

test('credential cipher rejects a 32-byte key with invalid base64 trailing characters', () => {
  // Catches permissive base64 decoding that silently ignores non-alphabet
  // characters after an otherwise valid 32-byte key.
  const validKey = Buffer.alloc(32, 7).toString('base64');
  withCredentialKey(`${validKey}!!!!`, () => {
    assert.throws(() => encryptCredential({ apiKey: 'x' }), /base64-encoded/);
  });
});

test('credential cipher rejects non-canonical base64 padding that still decodes to 32 bytes', () => {
  // Catches excess padding accepted by Buffer.from(value, 'base64') even
  // though it is not the canonical encoding emitted by openssl.
  const validKey = Buffer.alloc(32, 7).toString('base64');
  const malformedPadding = `${validKey.slice(0, -1)}===`;
  assert.equal(Buffer.from(malformedPadding, 'base64').length, 32);
  withCredentialKey(malformedPadding, () => {
    assert.throws(() => encryptCredential({ apiKey: 'x' }), /base64-encoded/);
  });
});

test('credential cipher rejects tampered ciphertext with a typed decrypt-failure error', () => {
  // Catches decryption that does not authenticate the stored ciphertext,
  // and confirms it is reported as the specific typed
  // IntegrationCredentialDecryptFailedError (INTEGRATION_CREDENTIAL_DECRYPT_FAILED)
  // — the same diagnosis a rotated/mismatched key would produce — rather
  // than some other unlabeled error.
  withCredentialKey(Buffer.alloc(32, 7).toString('base64'), () => {
    const encrypted = encryptCredential({ apiKey: 'x' });
    encrypted.credential_ciphertext = `${encrypted.credential_ciphertext.slice(0, -2)}AA`;
    assert.throws(() => decryptCredential(encrypted), (err) => {
      assert.equal(err.code, INTEGRATION_CREDENTIAL_DECRYPT_FAILED);
      return true;
    });
  });
});

// Regression: decryptCredential's try block used to wrap the Buffer.from
// coercions and the final JSON.parse too, not just the actual crypto
// calls — so a malformed row (e.g. a null nonce) and a successfully
// decrypted-but-non-JSON plaintext were BOTH mislabeled as
// IntegrationCredentialDecryptFailedError, the exact same diagnosis as a
// genuine wrong/rotated key. That's a confidently wrong operator-facing
// message in both cases (server/index.js's startup check would report
// "key rotation" for a corrupted row; routes/integrations.js's route-level
// message would tell an admin their key was rotated when it wasn't).

test('a malformed row (e.g. a null nonce) throws a plain error, never mislabeled as a wrong/rotated key', () => {
  withCredentialKey(Buffer.alloc(32, 7).toString('base64'), () => {
    const encrypted = encryptCredential({ apiKey: 'x' });
    const malformedRow = { ...encrypted, credential_nonce: null };
    assert.throws(() => decryptCredential(malformedRow), (err) => {
      assert.notEqual(err.code, INTEGRATION_CREDENTIAL_DECRYPT_FAILED);
      return true;
    });
  });
});

test('a successful decrypt+authenticate that is not valid JSON throws a plain SyntaxError, never mislabeled as a wrong/rotated key', () => {
  withCredentialKey(Buffer.alloc(32, 7).toString('base64'), () => {
    // Hand-builds a row using the exact same primitive crypto calls
    // encryptCredential uses internally, but encrypting a non-JSON string
    // directly — encryptCredential() itself always JSON.stringifies its
    // input, so this is the only way to produce a row that decrypts and
    // authenticates successfully but still fails JSON.parse.
    const key = Buffer.alloc(32, 7);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update('not valid json{{{', 'utf8'), cipher.final()]);
    const row = {
      credential_ciphertext: ciphertext.toString('base64'),
      credential_nonce: nonce.toString('base64'),
      credential_auth_tag: cipher.getAuthTag().toString('base64'),
      credential_key_version: 1,
    };
    assert.throws(() => decryptCredential(row), (err) => {
      assert.ok(err instanceof SyntaxError, `expected a SyntaxError from JSON.parse, got ${err.name}`);
      assert.notEqual(err.code, INTEGRATION_CREDENTIAL_DECRYPT_FAILED);
      return true;
    });
  });
});
