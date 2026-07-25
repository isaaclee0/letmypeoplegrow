const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encryptCredential, decryptCredential } = require('./credentialCipher');

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

test('credential cipher rejects tampered ciphertext', () => {
  // Catches decryption that does not authenticate the stored ciphertext.
  withCredentialKey(Buffer.alloc(32, 7).toString('base64'), () => {
    const encrypted = encryptCredential({ apiKey: 'x' });
    encrypted.credential_ciphertext = `${encrypted.credential_ciphertext.slice(0, -2)}AA`;
    assert.throws(() => decryptCredential(encrypted));
  });
});
