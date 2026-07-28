'use strict';

const crypto = require('node:crypto');

const Database = require('../../config/database');
const { evaluateFilterV2 } = require('./filterEngine');
const { validatePcoFilter } = require('./pcoAdapter');
const { validateElvantoFilter } = require('../elvanto/filter');
const { digestFilterConfig, ReviewSigningSecretMissingError } = require('./planDigest');
const { upgradeLegacyFilterWithConnection } = require('./batchRepository');
const filterFactsCache = require('./filterFactsCache');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const NOT_SET = '$not_set';
const UPGRADE_KIND = 'filter_upgrade';
const UPGRADE_TTL_SECONDS = 30 * 60;
const INVALID = Object.freeze({ ok: false, code: 'SYNC_UPGRADE_INVALID' });
const EXPIRED = Object.freeze({ ok: false, code: 'SYNC_UPGRADE_EXPIRED' });

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function hasStrictPcoEnvelope(config) {
  return exactKeys(config, ['membershipFilterEnabled', 'membershipAllowlist', 'fieldFilterEnabled', 'fieldFilters']) &&
    Array.isArray(config.fieldFilters) && config.fieldFilters.every((field) => exactKeys(field, ['fieldDefinitionId', 'values']));
}

function hasStrictElvantoEnvelope(config) {
  if (!exactKeys(config, ['statuses', 'categoryIds', 'groups', 'demographics', 'departments', 'serviceTypes', 'locations', 'customFields'])) return false;
  for (const [key, valuesKey] of [
    ['groups', 'ids'], ['demographics', 'values'], ['departments', 'values'],
    ['serviceTypes', 'ids'], ['locations', 'ids'],
  ]) {
    if (!exactKeys(config[key], [valuesKey, 'operator'])) return false;
  }
  return Array.isArray(config.customFields) && config.customFields.every((field) => exactKeys(field, ['fieldId', 'values', 'operator']));
}

function validatedLegacyConfig(provider, config) {
  if (!PROVIDERS.has(provider)) return null;
  const strict = provider === 'planning_center' ? hasStrictPcoEnvelope(config) : hasStrictElvantoEnvelope(config);
  if (!strict) return null;
  const validation = provider === 'planning_center' ? validatePcoFilter(config) : validateElvantoFilter(config);
  return validation.ok ? validation.value : null;
}

function sortedValues(values, mapper = (value) => value) {
  return [...new Set((Array.isArray(values) ? values : []).map(mapper).filter((value) => typeof value === 'string'))]
    .sort(compareStrings);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPcoValue(value) {
  if (value === '(none)') return NOT_SET;
  // PCO's snapshot projector escapes a real provider value equal to the
  // internal missing-value literal.  Preserve that distinction on upgrade.
  return value === NOT_SET ? '$$not_set' : value;
}

function literalPcoMembershipValue(value) {
  // The live v1 membership evaluator is a literal allowlist check. `(none)`
  // is only a custom-field absence sentinel there; changing it to missing
  // membership would make a direct upgrade behavior-changing.
  return value === NOT_SET ? '$$not_set' : value;
}

function group(dimensionId, mode, values) {
  return { dimensionId, mode, values: sortedValues(values) };
}

function intersectValues(left, right) {
  const wanted = new Set(right);
  return left.filter((value) => wanted.has(value));
}

function convertV1Filter(provider, config) {
  const valid = validatedLegacyConfig(provider, config);
  if (!valid) throw new TypeError(`Invalid ${provider} version-1 filter`);

  if (provider === 'planning_center') {
    const branches = [];
    if (valid.membershipFilterEnabled) {
      const values = sortedValues(valid.membershipAllowlist, canonicalPcoValue);
      if (values.length) branches.push({ groups: [group('membership', 'any', values)] });
    }
    if (valid.fieldFilterEnabled) {
      // Historical PCO permits repeated rules for one field. They are ANDed,
      // so their exact v2 equivalent is the intersection of their `any`
      // values, rather than an invalid duplicate dimension in one branch.
      const valuesByDimension = new Map();
      for (const field of valid.fieldFilters) {
        const dimensionId = `custom_field:${field.fieldDefinitionId}`;
        const values = sortedValues(field.values, canonicalPcoValue);
        valuesByDimension.set(dimensionId, valuesByDimension.has(dimensionId)
          ? intersectValues(valuesByDimension.get(dimensionId), values)
          : values);
      }
      const groups = [...valuesByDimension]
        .map(([dimensionId, values]) => group(dimensionId, 'any', values))
        .filter((field) => field.values.length > 0)
        .sort((left, right) => compareStrings(left.dimensionId, right.dimensionId));
      if (groups.length) branches.push({ groups });
    }
    return { branches, exclusions: [] };
  }

  const groups = [];
  const add = (dimensionId, mode, values) => {
    const canonicalValues = sortedValues(values);
    if (canonicalValues.length) groups.push(group(dimensionId, mode, canonicalValues));
  };
  add('status', 'any', valid.statuses);
  add('category', 'any', valid.categoryIds);
  add('groups', valid.groups.operator, valid.groups.ids);
  add('demographics', valid.demographics.operator, valid.demographics.values);
  add('departments', valid.departments.operator, valid.departments.values);
  add('service_types', valid.serviceTypes.operator, valid.serviceTypes.ids);
  add('locations', valid.locations.operator, valid.locations.ids);
  for (const field of valid.customFields) add(`custom_field:${field.fieldId}`, field.operator, field.values);
  groups.sort((left, right) => compareStrings(left.dimensionId, right.dimensionId));
  return { branches: groups.length ? [{ groups }] : [], exclusions: [] };
}

function factValues(facts, dimensionId) {
  const values = facts && facts.dimensions && facts.dimensions[dimensionId];
  return Array.isArray(values) ? values.filter((value) => typeof value === 'string') : [];
}

function legacyAny(facts, dimensionId, selected, mapper = (value) => value) {
  const wanted = sortedValues(selected, mapper);
  if (!wanted.length) return false;
  const values = factValues(facts, dimensionId);
  return wanted.some((value) => value === NOT_SET ? values.length === 0 : values.includes(value));
}

function legacySet(facts, dimensionId, selected, mode) {
  if (!selected.length) return true;
  const values = new Set(factValues(facts, dimensionId));
  return mode === 'all' ? selected.every((value) => values.has(value)) : selected.some((value) => values.has(value));
}

function evaluateLegacyFacts(provider, facts, config) {
  const valid = validatedLegacyConfig(provider, config);
  if (!valid) return false;
  if (provider === 'planning_center') {
    const membership = valid.membershipFilterEnabled && legacyAny(facts, 'membership', valid.membershipAllowlist, literalPcoMembershipValue);
    const fieldGroups = valid.fieldFilterEnabled
      ? valid.fieldFilters.map((field) => ({ field, values: sortedValues(field.values, canonicalPcoValue) })).filter(({ values }) => values.length)
      : [];
    const fields = fieldGroups.length > 0 && fieldGroups.every(({ field, values }) =>
      legacyAny(facts, `custom_field:${field.fieldDefinitionId}`, values));
    return membership || fields;
  }
  if (!legacyAny(facts, 'status', valid.statuses)) return false;
  if (!legacySet(facts, 'category', valid.categoryIds, 'any')) return false;
  if (!legacySet(facts, 'groups', valid.groups.ids, valid.groups.operator)) return false;
  if (!legacySet(facts, 'demographics', valid.demographics.values, valid.demographics.operator)) return false;
  if (!legacySet(facts, 'departments', valid.departments.values, valid.departments.operator)) return false;
  if (!legacySet(facts, 'service_types', valid.serviceTypes.ids, valid.serviceTypes.operator)) return false;
  if (!legacySet(facts, 'locations', valid.locations.ids, valid.locations.operator)) return false;
  return valid.customFields.every((field) =>
    legacySet(facts, `custom_field:${field.fieldId}`, field.values, field.operator));
}

function matchedIds(facts, evaluator) {
  const ids = new Set();
  for (const person of Array.isArray(facts) ? facts : []) {
    if (typeof person?.externalPersonId === 'string' && person.externalPersonId && evaluator(person)) ids.add(person.externalPersonId);
  }
  return [...ids].sort(compareStrings);
}

function sameSortedIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function compareUpgradeSets({ provider, config, facts, convertedConfig } = {}) {
  const converted = convertedConfig || convertV1Filter(provider, config);
  const oldIds = matchedIds(facts, (person) => evaluateLegacyFacts(provider, person, config));
  const newIds = matchedIds(facts, (person) => evaluateFilterV2(person, converted));
  return { oldCount: oldIds.length, newCount: newIds.length, compatible: sameSortedIds(oldIds, newIds) };
}

function signingSecret() {
  const secret = process.env.SYNC_REVIEW_SECRET || process.env.JWT_SECRET;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

function sign(payloadPart, secret) {
  return crypto.createHmac('sha256', secret).update(payloadPart).digest('base64url');
}

function validDigest(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validUpgradeContext(value) {
  return isPlainObject(value) && typeof value.churchId === 'string' && value.churchId.length > 0 &&
    PROVIDERS.has(value.provider) && (typeof value.batchId === 'string' || Number.isSafeInteger(value.batchId)) &&
    Number.isSafeInteger(value.filterRevision) && value.filterRevision > 0 && validDigest(value.activeConfigDigest) &&
    typeof value.snapshotId === 'string' && value.snapshotId.length > 0 && validDigest(value.convertedDigest) &&
    typeof value.compatible === 'boolean';
}

function createUpgradeToken(context) {
  const secret = signingSecret();
  if (!secret) throw new ReviewSigningSecretMissingError();
  if (!validUpgradeContext(context)) throw new TypeError('Invalid filter-upgrade token context');
  const payload = {
    kind: UPGRADE_KIND,
    churchId: context.churchId,
    provider: context.provider,
    batchId: context.batchId,
    filterRevision: context.filterRevision,
    activeConfigDigest: context.activeConfigDigest,
    snapshotId: context.snapshotId,
    convertedDigest: context.convertedDigest,
    compatible: context.compatible,
    exp: Math.floor(Date.now() / 1000) + UPGRADE_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded, secret)}`;
}

function parsePayload(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded) return null;
  return JSON.parse(decoded.toString('utf8'));
}

function validPayload(payload) {
  if (!validUpgradeContext(payload) || payload.kind !== UPGRADE_KIND || !Number.isSafeInteger(payload.exp) || payload.exp < 0) return false;
  const keys = Object.keys(payload).sort();
  return keys.join(',') === 'activeConfigDigest,batchId,churchId,compatible,convertedDigest,exp,filterRevision,kind,provider,snapshotId';
}

function verifyUpgradeToken(token, expected) {
  try {
    const secret = signingSecret();
    if (!secret || !validUpgradeContext(expected) || typeof token !== 'string' || !token || token.length > 8192) return INVALID;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return INVALID;
    const supplied = Buffer.from(parts[1], 'base64url');
    const signed = Buffer.from(sign(parts[0], secret), 'base64url');
    if (supplied.toString('base64url') !== parts[1] || supplied.length !== signed.length || !crypto.timingSafeEqual(supplied, signed)) return INVALID;
    const payload = parsePayload(parts[0]);
    if (!validPayload(payload)) return INVALID;
    if (Math.floor(Date.now() / 1000) >= payload.exp) return EXPIRED;
    for (const key of ['churchId', 'provider', 'batchId', 'filterRevision', 'activeConfigDigest', 'snapshotId', 'convertedDigest', 'compatible']) {
      if (payload[key] !== expected[key]) return INVALID;
    }
    return { ok: true, payload };
  } catch (_) {
    return INVALID;
  }
}

function parseStoredConfig(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return isPlainObject(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function staleError() {
  const error = new Error('Sync filter upgrade is stale');
  error.code = 'SYNC_UPGRADE_STALE';
  return error;
}

function validSnapshot(entry, churchId, provider) {
  return entry && entry.churchId === churchId && entry.provider === provider &&
    typeof entry.snapshotId === 'string' && entry.snapshotId &&
    typeof entry.populationGateDigest === 'string' && entry.populationGateDigest && Array.isArray(entry.facts);
}

async function applyCompatibleUpgrades({ churchId, provider, upgrades, cache = filterFactsCache } = {}) {
  if (typeof churchId !== 'string' || !churchId || !PROVIDERS.has(provider) || !Array.isArray(upgrades) || upgrades.length === 0 ||
      !cache || typeof cache.get !== 'function') throw new TypeError('Invalid filter-upgrade request');
  const seen = new Set();
  for (const upgrade of upgrades) {
    if (!isPlainObject(upgrade) || !(typeof upgrade.batchId === 'string' || Number.isSafeInteger(upgrade.batchId)) ||
        typeof upgrade.upgradeToken !== 'string' || seen.has(String(upgrade.batchId))) throw new TypeError('Invalid filter-upgrade request');
    seen.add(String(upgrade.batchId));
  }

  return Database.transactionForChurch(churchId, async (conn) => {
    // Both the rows and snapshot are deliberately re-read after the church
    // transaction starts.  No row is updated until every token/context has
    // passed against this single current snapshot.
    const snapshot = cache.get(churchId, provider);
    if (!validSnapshot(snapshot, churchId, provider)) throw staleError();
    const verified = [];
    for (const upgrade of upgrades) {
      const rows = await conn.query(`SELECT id, church_id, provider, filter_schema_version, filter_config, filter_revision
        FROM people_sync_batches WHERE id = ? AND church_id = ? AND provider = ?`, [upgrade.batchId, churchId, provider]);
      const row = rows[0];
      const config = parseStoredConfig(row?.filter_config);
      if (!row || Number(row.filter_schema_version) !== 1 || !config) throw staleError();
      let converted;
      try { converted = convertV1Filter(provider, config); } catch (_) { throw staleError(); }
      const comparison = compareUpgradeSets({ provider, config, facts: snapshot.facts, convertedConfig: converted });
      const expected = {
        churchId, provider, batchId: row.id, filterRevision: Number(row.filter_revision),
        activeConfigDigest: digestFilterConfig(config), snapshotId: snapshot.snapshotId,
        convertedDigest: digestFilterConfig(converted), compatible: comparison.compatible,
      };
      if (!comparison.compatible || !verifyUpgradeToken(upgrade.upgradeToken, expected).ok) throw staleError();
      verified.push({ batchId: row.id, filterRevision: Number(row.filter_revision), converted });
    }
    // `conn.query` is synchronous for the SQLite connection supplied by
    // Database.transactionForChurch. Re-check the cache immediately before
    // that synchronous write loop, then do not yield: a refresh cannot slip
    // in between this identity check and any committed row change.
    const currentSnapshot = cache.get(churchId, provider);
    if (!validSnapshot(currentSnapshot, churchId, provider) ||
        currentSnapshot.snapshotId !== snapshot.snapshotId ||
        currentSnapshot.populationGateDigest !== snapshot.populationGateDigest) throw staleError();
    for (const upgrade of verified) {
      upgradeLegacyFilterWithConnection(conn, {
        churchId, provider, batchId: upgrade.batchId, expectedRevision: upgrade.filterRevision,
        convertedFilterConfig: upgrade.converted,
      });
    }
    return verified.map((upgrade) => ({
      id: upgrade.batchId, filterSchemaVersion: 2, filterRevision: upgrade.filterRevision + 1,
    }));
  });
}

module.exports = {
  convertV1Filter,
  evaluateLegacyFacts,
  compareUpgradeSets,
  createUpgradeToken,
  verifyUpgradeToken,
  applyCompatibleUpgrades,
};
