'use strict';

const crypto = require('node:crypto');

const FRESH_MS = 10 * 60 * 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 200;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareCanonical(left, right) {
  const leftJson = JSON.stringify(left);
  const rightJson = JSON.stringify(right);
  return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize).sort(compareCanonical);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cacheKey(churchId, provider) {
  return `${churchId.length}:${churchId}:${provider.length}:${provider}`;
}

function snapshotIdentity({ provider, coveredDimensionIds, facts }) {
  const canonical = canonicalize({ provider, coveredDimensionIds, facts });
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function assertCompleteEntry(entry) {
  if (!isPlainObject(entry) || entry.complete !== true) {
    throw new TypeError('Only a complete snapshot may be cached.');
  }
  if (typeof entry.churchId !== 'string' || !entry.churchId || typeof entry.provider !== 'string' || !entry.provider) {
    throw new TypeError('A complete snapshot requires churchId and provider.');
  }
  if (!Array.isArray(entry.coveredDimensionIds) || !entry.coveredDimensionIds.every((id) => typeof id === 'string' && id)) {
    throw new TypeError('A complete snapshot requires coveredDimensionIds.');
  }
  if (!Array.isArray(entry.facts)) throw new TypeError('A complete snapshot requires facts.');
  if (!Array.isArray(entry.dimensions)) throw new TypeError('A complete snapshot requires dimensions.');
  if (typeof entry.populationGateDigest !== 'string' || !entry.populationGateDigest) {
    throw new TypeError('A complete snapshot requires populationGateDigest.');
  }
}

function createFilterFactsCache({ now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  const entries = new Map();

  function putComplete(entry) {
    assertCompleteEntry(entry);
    const capturedAtMs = now();
    if (!Number.isFinite(capturedAtMs)) throw new TypeError('now must return a finite timestamp.');
    const coveredDimensionIds = [...new Set(entry.coveredDimensionIds)].sort();
    const facts = canonicalize(clone(entry.facts));
    const stored = deepFreeze({
      snapshotId: snapshotIdentity({ provider: entry.provider, coveredDimensionIds, facts }),
      provider: entry.provider,
      churchId: entry.churchId,
      capturedAt: new Date(capturedAtMs).toISOString(),
      freshUntil: new Date(capturedAtMs + FRESH_MS).toISOString(),
      expiresAt: new Date(capturedAtMs + RETAIN_MS).toISOString(),
      coveredDimensionIds,
      dimensions: clone(entry.dimensions),
      facts,
      populationGateDigest: entry.populationGateDigest,
    });
    const key = cacheKey(stored.churchId, stored.provider);
    entries.delete(key);
    entries.set(key, stored);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    return readEntry(stored, capturedAtMs);
  }

  function readEntry(entry, at) {
    return deepFreeze({
      ...clone(entry),
      fresh: at < Date.parse(entry.freshUntil),
    });
  }

  function get(churchId, provider, options = {}) {
    if (typeof churchId !== 'string' || typeof provider !== 'string') return null;
    const key = cacheKey(churchId, provider);
    const entry = entries.get(key);
    if (!entry) return null;
    const at = options.now === undefined ? now() : options.now;
    if (!Number.isFinite(at)) throw new TypeError('get now must be a finite timestamp.');
    if (at >= Date.parse(entry.expiresAt)) {
      entries.delete(key);
      return null;
    }
    entries.delete(key);
    entries.set(key, entry);
    return readEntry(entry, at);
  }

  function clear(churchId, provider) {
    if (typeof churchId !== 'string' || typeof provider !== 'string') return false;
    return entries.delete(cacheKey(churchId, provider));
  }

  function clearAll() {
    entries.clear();
  }

  function size() {
    return entries.size;
  }

  return { putComplete, get, clear, clearAll, size };
}

const defaultCache = createFilterFactsCache();

module.exports = {
  FRESH_MS,
  RETAIN_MS,
  MAX_ENTRIES,
  createFilterFactsCache,
  putComplete: defaultCache.putComplete,
  get: defaultCache.get,
  clear: defaultCache.clear,
  clearAll: defaultCache.clearAll,
};
