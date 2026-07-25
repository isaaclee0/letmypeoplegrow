const crypto = require('node:crypto');

function keyBuffer() {
  const encodedKey = process.env.INTEGRATION_CREDENTIALS_KEY || '';
  const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!canonicalBase64.test(encodedKey)) {
    throw new Error('INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key');
  }
  const key = Buffer.from(encodedKey, 'base64');
  if (key.toString('base64') !== encodedKey) {
    throw new Error('INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key');
  }
  if (key.length !== 32) throw new Error('INTEGRATION_CREDENTIALS_KEY must be a base64-encoded 32-byte key');
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
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(row.credential_nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(row.credential_auth_tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.credential_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

module.exports = { encryptCredential, decryptCredential };
