'use strict';

const crypto = require('node:crypto');

function normalizeCoverage(coveredDimensionIds) {
  return [...new Set(coveredDimensionIds instanceof Set ? coveredDimensionIds : coveredDimensionIds || [])]
    .filter((id) => typeof id === 'string' && id)
    .sort();
}

function gateSettings(provider, settings) {
  // Keep only values that alter population membership. A missing Elvanto
  // setting is equivalent to its default (contacts included).
  return provider === 'elvanto'
    ? { provider, includeContacts: !(settings && settings.includeContacts === false) }
    : { provider };
}

function populationGateDigest(provider, settings) {
  return crypto.createHash('sha256').update(JSON.stringify(gateSettings(provider, settings))).digest('hex');
}

function copyFacts(facts, coveredDimensionIds) {
  const dimensions = {};
  for (const [dimensionId, values] of Object.entries(facts && facts.dimensions || {})) {
    if (!coveredDimensionIds.has(dimensionId) || !Array.isArray(values)) continue;
    const cleanValues = [...new Set(values.filter((value) => typeof value === 'string'))].sort();
    if (cleanValues.length) dimensions[dimensionId] = cleanValues;
  }
  return { externalPersonId: String(facts && facts.externalPersonId || ''), dimensions };
}

function captureFilterSnapshotInput({ provider, snapshot, providerMetadata, settings, coveredDimensionIds, adapter } = {}) {
  const coverage = normalizeCoverage(coveredDimensionIds);
  const covered = new Set(coverage);
  const facts = [];
  for (const person of snapshot && Array.isArray(snapshot.people) ? snapshot.people : []) {
    if (!adapter.isInFilterPopulation(person, settings || {})) continue;
    facts.push(copyFacts(adapter.toFilterFacts(person, covered), covered));
  }
  facts.sort((left, right) => left.externalPersonId.localeCompare(right.externalPersonId));
  return {
    facts,
    dimensions: adapter.buildFilterDimensions({ facts, providerMetadata, coveredDimensionIds: coverage }),
    coverage,
    populationGateDigest: populationGateDigest(provider, settings),
  };
}

module.exports = { captureFilterSnapshotInput, populationGateDigest };
