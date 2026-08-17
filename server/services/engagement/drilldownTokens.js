'use strict';

const {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} = require('node:crypto');

const VERSION = 'v1';
const PURPOSE = 'let-my-people-grow/engagement-drilldown-token';
const AAD = Buffer.from(`${PURPOSE}:${VERSION}`, 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;

class DrilldownTokenError extends Error {
  constructor() {
    super('The report drilldown token is invalid or has expired.');
    this.name = 'DrilldownTokenError';
    this.code = 'INVALID_DRILLDOWN_TOKEN';
  }
}

function keyForCurrentSecret() {
  const secret = process.env.JWT_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('JWT_SECRET is required to protect engagement drilldown tokens.');
  }
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from(PURPOSE, 'utf8'),
    Buffer.from('aes-256-gcm', 'utf8'),
    32,
  ));
}

function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('A drilldown token payload is required.');
  }
  if (typeof payload.churchId !== 'string' || payload.churchId.length === 0) {
    throw new TypeError('A church ID is required for a drilldown token.');
  }
  if (typeof payload.kind !== 'string' || payload.kind.length === 0) {
    throw new TypeError('A drilldown kind is required.');
  }
  if (!payload.selector || typeof payload.selector !== 'object' || Array.isArray(payload.selector)) {
    throw new TypeError('A drilldown selector is required.');
  }
  if (!isDateOnly(payload.completedWeekEnd)) {
    throw new TypeError('A valid completed week end is required.');
  }
  if (typeof payload.expiresAt !== 'string'
      || Number.isNaN(new Date(payload.expiresAt).getTime())) {
    throw new TypeError('A valid expiry is required.');
  }
}

function createDrilldownToken(payload) {
  validatePayload(payload);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyForCurrentSecret(), iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join('.');
}

function decodeCanonicalBase64Url(value) {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('non-canonical token');
  return decoded;
}

function readDrilldownToken(token, { churchId, kind, now = new Date() } = {}) {
  try {
    if (typeof token !== 'string' || token.length === 0) throw new Error('missing token');
    const [version, ivText, ciphertextText, tagText, extra] = token.split('.');
    if (version !== VERSION || !ivText || !ciphertextText || !tagText || extra !== undefined) {
      throw new Error('malformed token');
    }
    const iv = decodeCanonicalBase64Url(ivText);
    const ciphertext = decodeCanonicalBase64Url(ciphertextText);
    const tag = decodeCanonicalBase64Url(tagText);
    if (iv.length !== IV_BYTES || ciphertext.length === 0 || tag.length !== TAG_BYTES) {
      throw new Error('malformed token');
    }

    const decipher = createDecipheriv('aes-256-gcm', keyForCurrentSecret(), iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    validatePayload(payload);

    const instant = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(instant.getTime())
        || payload.churchId !== churchId
        || payload.kind !== kind
        || new Date(payload.expiresAt).getTime() <= instant.getTime()) {
      throw new Error('token binding failed');
    }
    return payload;
  } catch (error) {
    if (error instanceof DrilldownTokenError) throw error;
    throw new DrilldownTokenError();
  }
}

module.exports = {
  DrilldownTokenError,
  createDrilldownToken,
  readDrilldownToken,
};
