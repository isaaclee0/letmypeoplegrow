'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalLinkCorrections,
  validateAndProjectLinkCorrections,
} = require('./linkCorrections');

function link(externalPersonId, individualId, overrides = {}) {
  return { externalPersonId, individualId, linkSource: 'matched', ...overrides };
}

function pair(entry) {
  return [entry.externalPersonId, entry.individualId];
}

function inputs(overrides = {}) {
  return {
    rawCorrections: {},
    baseLinks: [link('ext-a', 10), link('ext-b', 20)],
    sourceExternalIds: new Set(['ext-a', 'ext-b']),
    localIndividualIds: new Set([10, 20, 30]),
    ...overrides,
  };
}

test('projects corrections simultaneously so two explicit rows can exchange targets', () => {
  const result = validateAndProjectLinkCorrections(inputs({
    rawCorrections: {
      'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 },
      'ext-b': { outcome: 'relink', fromIndividualId: 20, individualId: 10 },
    },
  }));

  assert.deepEqual(result.projectedLinks.map(pair), [['ext-a', 20], ['ext-b', 10]]);
  assert.deepEqual(result.corrections, [
    { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'relink', individualId: 20 },
    { externalPersonId: 'ext-b', fromIndividualId: 20, outcome: 'relink', individualId: 10 },
  ]);
});

test('rejects an implicit collision with an unchanged established link', () => {
  assert.throws(
    () => validateAndProjectLinkCorrections(inputs({
      rawCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 20 } },
    })),
    /still linked to ext-b/i
  );
});

test('rejects corrections that do not identify a reviewed established source link', () => {
  assert.throws(
    () => validateAndProjectLinkCorrections(inputs({
      rawCorrections: { unknown: { outcome: 'unlink', fromIndividualId: 10 } },
    })),
    /unknown.*unknown/i
  );
  assert.throws(
    () => validateAndProjectLinkCorrections(inputs({
      sourceExternalIds: new Set(['ext-a']),
      rawCorrections: { 'ext-b': { outcome: 'unlink', fromIndividualId: 20 } },
    })),
    /reviewed source.*ext-b/i
  );
  assert.throws(
    () => validateAndProjectLinkCorrections(inputs({
      rawCorrections: { 'ext-a': { outcome: 'unlink', fromIndividualId: 20 } },
    })),
    /stale.*ext-a/i
  );
});

test('rejects malformed correction fields and unavailable local relink targets', () => {
  for (const rawCorrections of [
    { 'ext-a': { outcome: 'unlink', fromIndividualId: 10, surprise: true } },
    { 'ext-a': { outcome: 'unlink', fromIndividualId: 0 } },
    { 'ext-a': { outcome: 'guess', fromIndividualId: 10 } },
    { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 10 } },
    { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 999 } },
  ]) {
    assert.throws(
      () => validateAndProjectLinkCorrections(inputs({ rawCorrections })),
      /invalid fields|positive integer|unsupported|cannot relink.*itself|does not exist/i
    );
  }
});

test('rejects duplicate local targets in the complete final mapping', () => {
  assert.throws(
    () => validateAndProjectLinkCorrections(inputs({
      rawCorrections: { 'ext-a': { outcome: 'relink', fromIndividualId: 10, individualId: 30 } },
      baseLinks: [link('ext-a', 10), link('ext-b', 20), link('ext-c', 30)],
      sourceExternalIds: new Set(['ext-a', 'ext-b', 'ext-c']),
    })),
    /individual 30.*still linked to ext-c/i
  );
});

test('canonicalizes keyed and array corrections into the same deterministic order', () => {
  const expected = [
    { externalPersonId: 'ext-a', fromIndividualId: 10, outcome: 'unlink' },
    { externalPersonId: 'ext-z', fromIndividualId: 20, outcome: 'relink', individualId: 30 },
  ];
  assert.deepEqual(canonicalLinkCorrections({
    'ext-z': { outcome: 'relink', fromIndividualId: 20, individualId: 30 },
    'ext-a': { outcome: 'unlink', fromIndividualId: 10 },
  }), expected);
  assert.deepEqual(canonicalLinkCorrections([...expected].reverse()), expected);
});

test('projects unlink review effects and relink hold deletion from canonical corrections', () => {
  const result = validateAndProjectLinkCorrections(inputs({
    rawCorrections: {
      'ext-a': { outcome: 'unlink', fromIndividualId: 10 },
      'ext-b': { outcome: 'relink', fromIndividualId: 20, individualId: 30 },
    },
  }));

  assert.deepEqual(result.projectedLinks.map(pair), [['ext-b', 30]]);
  assert.deepEqual(result.exclusionsToAdd, [
    { externalPersonId: 'ext-a', individualId: 10 },
    { externalPersonId: 'ext-b', individualId: 20 },
  ]);
  assert.deepEqual(result.holdsToUpsert, [{ externalPersonId: 'ext-a', reason: 'pair_rejected' }]);
  assert.deepEqual(result.holdsToDelete, ['ext-b']);
  assert.deepEqual([...result.correctedExternalIds], ['ext-a', 'ext-b']);
  assert.deepEqual([...result.unlinkedExternalIds], ['ext-a']);
  assert.deepEqual([...result.freedIndividualIds], [10, 20]);
});
