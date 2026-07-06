const { test } = require('node:test');
const assert = require('node:assert');
const { resolveManualLinks } = require('./selectionValidation');

test('accepts a valid, unclaimed pick', () => {
  const claimed = new Set();
  const accepted = resolveManualLinks(
    [{ individualId: 1, pcoId: 'p1' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: claimed }
  );
  assert.deepStrictEqual(accepted, [{ individualId: 1, pcoId: 'p1' }]);
  assert.ok(claimed.has('p1'));
});

test('rejects a pcoId not present in validPcoIds', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 1, pcoId: 'ghost' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set() }
  );
  assert.deepStrictEqual(accepted, []);
});

test('rejects the second of two candidates claiming the same pcoId', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 1, pcoId: 'p1' }, { individualId: 2, pcoId: 'p1' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set() }
  );
  assert.deepStrictEqual(accepted, [{ individualId: 1, pcoId: 'p1' }]);
});

test('rejects a pick outside allowedIndividualIds when provided', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 99, pcoId: 'p1' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set(), allowedIndividualIds: new Set([1, 2]) }
  );
  assert.deepStrictEqual(accepted, []);
});

test('allows any individualId when allowedIndividualIds is not provided', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 99, pcoId: 'p1' }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set() }
  );
  assert.deepStrictEqual(accepted, [{ individualId: 99, pcoId: 'p1' }]);
});

test('ignores entries with no pcoId', () => {
  const accepted = resolveManualLinks(
    [{ individualId: 1, pcoId: null }, { individualId: 2, pcoId: undefined }],
    { validPcoIds: new Set(['p1']), claimedPcoIds: new Set() }
  );
  assert.deepStrictEqual(accepted, []);
});
