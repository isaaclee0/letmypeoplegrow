const crypto = require('node:crypto');

const SOURCE_KINDS_BY_PROVIDER = Object.freeze({
  planning_center: new Set(['planning_center_list']),
  elvanto: new Set(['elvanto_category', 'elvanto_group']),
});
const SOURCE_STATUSES = new Set(['unknown', 'available', 'missing', 'error']);

function invalidSource(message) {
  const error = new Error(message);
  error.code = 'SYNC_SOURCE_INVALID';
  return error;
}

function assertSourceForProvider(provider, source) {
  const allowedKinds = SOURCE_KINDS_BY_PROVIDER[provider];
  if (!allowedKinds || !source || typeof source !== 'object' || Array.isArray(source) ||
      Object.keys(source).length !== 3 ||
      !Object.hasOwn(source, 'kind') || !Object.hasOwn(source, 'externalId') || !Object.hasOwn(source, 'name') ||
      typeof source.kind !== 'string' || !allowedKinds.has(source.kind) ||
      typeof source.externalId !== 'string' || !source.externalId.trim() ||
      typeof source.name !== 'string' || !source.name.trim()) {
    throw invalidSource('Invalid provider-owned sync source');
  }
}

function normalizeProviderSource(provider, source) {
  assertSourceForProvider(provider, source);
  return {
    kind: source.kind,
    externalId: source.externalId.trim(),
    name: source.name.trim(),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function digestSourceIdentity(source) {
  return digest({ kind: source?.kind, externalId: source?.externalId });
}

function normalizedPerson(person) {
  return {
    id: person?.id ?? person?.externalId ?? null,
    name: person?.name ?? null,
    state: person?.state ?? person?.status ?? null,
    child: person?.child ?? person?.isChild ?? null,
    familyId: person?.familyId ?? person?.householdId ?? null,
  };
}

function normalizedFamily(family) {
  return {
    id: family?.id ?? family?.externalId ?? null,
    name: family?.name ?? null,
    primaryContactId: family?.primaryContactId ?? null,
  };
}

function sorted(values, normalize) {
  return (Array.isArray(values) ? values : []).map(normalize).sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right))
  );
}

function digestSourceSnapshot(snapshot) {
  const source = snapshot?.source || {};
  return digest({
    provider: snapshot?.provider ?? null,
    source: {
      kind: source.kind ?? null,
      externalId: source.externalId ?? null,
      name: source.name ?? null,
      memberCount: Array.isArray(snapshot?.memberExternalIds) ? snapshot.memberExternalIds.length : 0,
      providerRefreshedAt: snapshot?.providerRefreshedAt ?? null,
    },
    memberExternalIds: (Array.isArray(snapshot?.memberExternalIds) ? snapshot.memberExternalIds : [])
      .map(String).sort(),
    people: sorted(snapshot?.people, normalizedPerson),
    context: sorted(snapshot?.context, normalizedPerson),
    families: sorted(snapshot?.families, normalizedFamily),
  });
}

module.exports = {
  SOURCE_KINDS_BY_PROVIDER,
  SOURCE_STATUSES,
  assertSourceForProvider,
  normalizeProviderSource,
  digestSourceIdentity,
  digestSourceSnapshot,
};
