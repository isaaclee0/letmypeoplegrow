'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyEvidence,
  tierDirection,
  evidenceSupportsCandidate,
} = require('./tiers');

const settings = { coreMinimum: 60, casualMinimum: 20 };

test('classifies assigned evidence at exact configured thresholds', () => {
  assert.deepEqual(
    classifyEvidence({ assigned: true, attended: 6, opportunities: 10 }, settings),
    { status: 'core', attended: 6, opportunities: 10, rate: 0.6 },
  );
  assert.deepEqual(
    classifyEvidence({ assigned: true, attended: 2, opportunities: 10 }, settings),
    { status: 'casual', attended: 2, opportunities: 10, rate: 0.2 },
  );
  assert.equal(
    classifyEvidence({ assigned: true, attended: 1, opportunities: 10 }, settings).status,
    'irregular',
  );
});

test('keeps insufficient and unassigned evidence out of classified tiers', () => {
  assert.deepEqual(
    classifyEvidence({ assigned: true, attended: 3, opportunities: 5 }, settings),
    { status: 'establishing', attended: 3, opportunities: 5, rate: 0.6 },
  );
  assert.deepEqual(
    classifyEvidence({ assigned: false, attended: 8, opportunities: 10 }, settings),
    { status: 'not_assigned', attended: 0, opportunities: 0, rate: null },
  );
});

test('identifies higher and lower classified-tier movement only', () => {
  assert.equal(tierDirection('casual', 'core'), 'higher');
  assert.equal(tierDirection('core', 'casual'), 'lower');
  assert.equal(tierDirection('core', 'core'), null);
  assert.equal(tierDirection('core', 'establishing'), null);
});

test('accepts evidence at or farther in the candidate direction', () => {
  assert.equal(evidenceSupportsCandidate({
    establishedTier: 'casual', candidateTier: 'core', evidenceTier: 'core',
  }), true);
  assert.equal(evidenceSupportsCandidate({
    establishedTier: 'core', candidateTier: 'casual', evidenceTier: 'irregular',
  }), true);
});

test('requires direct two-tier candidates to have supporting evidence at their target', () => {
  assert.equal(evidenceSupportsCandidate({
    establishedTier: 'core', candidateTier: 'irregular', evidenceTier: 'casual',
  }), false);
  assert.equal(evidenceSupportsCandidate({
    establishedTier: 'core', candidateTier: 'irregular', evidenceTier: 'irregular',
  }), true);
  assert.equal(evidenceSupportsCandidate({
    establishedTier: 'irregular', candidateTier: 'core', evidenceTier: 'casual',
  }), false);
  assert.equal(evidenceSupportsCandidate({
    establishedTier: 'irregular', candidateTier: 'core', evidenceTier: 'core',
  }), true);
});
