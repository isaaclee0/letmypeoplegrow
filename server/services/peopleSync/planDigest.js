const crypto = require('node:crypto');

const INVALID = Object.freeze({ ok: false, code: 'SYNC_REVIEW_INVALID' });
const EXPIRED = Object.freeze({ ok: false, code: 'SYNC_REVIEW_EXPIRED' });
const STALE = Object.freeze({ ok: false, code: 'SYNC_PLAN_STALE' });
const TIMESTAMP_KEY = /^(?:fetchedAt|generatedAt|updatedAt|createdAt|startedAt|completedAt|cachedAt|timestamp)$/i;

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isVolatile(path, key) {
  const parent = path[path.length - 1] || '';
  const ancestry = path.join('.');
  if (parent === 'snapshot' && key === 'fetchedAt') return true;
  if (/^(?:runId|run_id|syncRunId|sync_run_id)$/i.test(key)) return true;
  if (/run/i.test(parent) && key === 'id') return true;
  if (/^(?:cachedAt|cacheTimestamp|metadataCachedAt|cacheUpdatedAt)$/i.test(key)) return true;
  return TIMESTAMP_KEY.test(key) && /(?:^|\.)(?:display|[^.]*run[^.]*|[^.]*cache[^.]*)(?:\.|$)/i.test(ancestry);
}

function canonicalize(value, path = []) {
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, [...path, String(index)]));
  if (!isPlainObject(value)) return value;
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    if (isVolatile(path, key)) continue;
    const nested = value[key];
    if (nested === undefined) continue;
    normalized[key] = canonicalize(nested, [...path, key]);
  }
  return normalized;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digestPlan(plan) {
  return crypto.createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

function signingSecret() {
  const secret = process.env.SYNC_REVIEW_SECRET || process.env.JWT_SECRET;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

function sign(payloadPart, secret) {
  return crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
}

function assertCreateContext(context) {
  if (!isPlainObject(context) || typeof context.churchId !== 'string' || context.churchId.length === 0 ||
      typeof context.provider !== 'string' || context.provider.length === 0 ||
      !(context.batchId === null || typeof context.batchId === 'string' || Number.isSafeInteger(context.batchId)) ||
      typeof context.planDigest !== 'string' || !/^[a-f0-9]{64}$/.test(context.planDigest) ||
      !Number.isSafeInteger(context.expiresInSeconds) || context.expiresInSeconds <= 0) {
    throw new Error('Invalid review token context');
  }
}

function createReviewToken(context) {
  const secret = signingSecret();
  if (!secret) throw new Error('A review signing secret is required');
  assertCreateContext(context);
  const payload = {
    churchId: context.churchId,
    provider: context.provider,
    batchId: context.batchId,
    planDigest: context.planDigest,
    exp: Math.floor(Date.now() / 1000) + context.expiresInSeconds,
  };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadPart}.${sign(payloadPart, secret)}`;
}

function validExpected(expected) {
  return isPlainObject(expected) && typeof expected.churchId === 'string' && expected.churchId.length > 0 &&
    typeof expected.provider === 'string' && expected.provider.length > 0 &&
    (expected.batchId === null || typeof expected.batchId === 'string' || Number.isSafeInteger(expected.batchId)) &&
    typeof expected.planDigest === 'string' && /^[a-f0-9]{64}$/.test(expected.planDigest);
}

function validPayload(payload) {
  if (!isPlainObject(payload)) return false;
  const keys = Object.keys(payload).sort();
  if (keys.join(',') !== 'batchId,churchId,exp,planDigest,provider') return false;
  return typeof payload.churchId === 'string' && payload.churchId.length > 0 &&
    typeof payload.provider === 'string' && payload.provider.length > 0 &&
    (payload.batchId === null || typeof payload.batchId === 'string' || Number.isSafeInteger(payload.batchId)) &&
    typeof payload.planDigest === 'string' && /^[a-f0-9]{64}$/.test(payload.planDigest) &&
    Number.isSafeInteger(payload.exp) && payload.exp >= 0;
}

function decodePayload(payloadPart) {
  if (!/^[A-Za-z0-9_-]+$/.test(payloadPart)) return null;
  const decoded = Buffer.from(payloadPart, 'base64url');
  if (decoded.toString('base64url') !== payloadPart) return null;
  return JSON.parse(decoded.toString('utf8'));
}

function verifyReviewToken(token, expected) {
  try {
    const secret = signingSecret();
    if (!secret || typeof token !== 'string' || token.length === 0 || token.length > 8192 || !validExpected(expected)) {
      return INVALID;
    }
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return INVALID;
    const suppliedSignature = Buffer.from(parts[1], 'base64url');
    if (suppliedSignature.toString('base64url') !== parts[1]) return INVALID;
    const expectedSignature = Buffer.from(sign(parts[0], secret), 'base64url');
    if (suppliedSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) return INVALID;
    const payload = decodePayload(parts[0]);
    if (!validPayload(payload)) return INVALID;
    if (payload.churchId !== expected.churchId || payload.provider !== expected.provider || payload.batchId !== expected.batchId) {
      return INVALID;
    }
    if (Math.floor(Date.now() / 1000) >= payload.exp) return EXPIRED;
    if (payload.planDigest !== expected.planDigest) return STALE;
    return { ok: true, payload };
  } catch (_) {
    return INVALID;
  }
}

module.exports = { canonicalJson, digestPlan, createReviewToken, verifyReviewToken };
