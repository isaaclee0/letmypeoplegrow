const { test } = require('node:test');
const assert = require('node:assert/strict');

const { matchPeople } = require('./matcher');

function external(id, firstName, lastName, extra = {}) {
  return { id, firstName, lastName, child: null, familyId: null, ...extra };
}

function local(id, firstName, lastName, extra = {}) {
  return {
    id, firstName, lastName, isChild: false, familyId: null,
    peopleType: 'regular', isActive: true, ...extra,
  };
}

function input(overrides = {}) {
  return {
    externalPeople: [],
    localPeople: [],
    existingLinks: [],
    localFamilyMembers: new Map(),
    externalFamilyMembers: new Map(),
    ...overrides,
  };
}

function emptyResult() {
  return {
    linked: [], matches: [], ambiguous: [], unmatchedExternalIds: [], unmatchedLocalIds: [],
    visitorMatches: [], archivedMatches: [],
  };
}

test('uses an existing durable link before considering a conflicting name', () => {
  const result = matchPeople(input({
    externalPeople: [external('e2', 'Other', 'Name'), external('e1', 'Sarah', 'Jones')],
    localPeople: [local(1, 'Sarah', 'Jones'), local(2, 'Different', 'Person')],
    existingLinks: [{ externalPersonId: 'e2', individualId: 2 }],
  }));

  assert.deepEqual(result, {
    ...emptyResult(),
    linked: [{ individualId: 2, externalPersonId: 'e2', reason: 'existing_link' }],
    matches: [{ individualId: 1, externalPersonId: 'e1', reason: 'unique_name' }],
  });
});

test('an exclusion removes only the exact candidate pair', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith'), local(8, 'Alex', 'Smith')],
    excludedPairs: new Set(['ext-1\u00007']),
  }));

  assert.deepEqual(result.matches.map((row) => row.individualId), [8]);
});

test('exclusions apply to visitor and archived review candidates', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [
      local(7, 'Alex', 'Smith', { peopleType: 'local_visitor' }),
      local(8, 'Alex', 'Smith', { isActive: false }),
    ],
    excludedPairs: new Set(['ext-1\u00007']),
  }));

  assert.deepEqual(result.archivedMatches, [{ externalPersonId: 'ext-1', individualId: 8 }]);
  assert.deepEqual(result.visitorMatches, []);
});

test('all excluded candidates leave the external person unmatched', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith')],
    excludedPairs: new Set(['ext-1\u00007']),
  }));

  assert.deepEqual(result.unmatchedExternalIds, ['ext-1']);
  assert.deepEqual(result.matches, []);
});

test('a held deterministic match is returned for review instead of automatic linking', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith')],
    heldExternalIds: new Set(['ext-1']),
  }));

  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'ext-1', candidateIndividualIds: [7], reason: 'review_deferred',
  }]);
});

test('a held unmatched person is returned for review without an add proposal', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [],
    heldExternalIds: new Set(['ext-1']),
  }));

  assert.deepEqual(result.unmatchedExternalIds, []);
  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'ext-1', candidateIndividualIds: [], reason: 'review_deferred',
  }]);
});

test('a held person with a stale durable link is returned as deferred review', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith')],
    existingLinks: [{ externalPersonId: 'ext-1', individualId: 99 }],
    heldExternalIds: new Set(['ext-1']),
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'ext-1', candidateIndividualIds: [], reason: 'review_deferred',
  }]);
});

test('a held person with conflicting durable links is returned as deferred review', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith'), local(8, 'Alex', 'Smith')],
    existingLinks: [
      { externalPersonId: 'ext-1', individualId: 7 },
      { externalPersonId: 'ext-1', individualId: 8 },
    ],
    heldExternalIds: new Set(['ext-1']),
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'ext-1', candidateIndividualIds: [], reason: 'review_deferred',
  }]);
});

test('a held duplicate external identity is returned as deferred review', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith'), external('ext-1', 'Blair', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith'), local(8, 'Blair', 'Smith')],
    heldExternalIds: new Set(['ext-1']),
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'ext-1', candidateIndividualIds: [], reason: 'review_deferred',
  }]);
});

test('a durable link retains precedence over a hold and exclusion', () => {
  const result = matchPeople(input({
    externalPeople: [external('ext-1', 'Alex', 'Smith')],
    localPeople: [local(7, 'Alex', 'Smith')],
    existingLinks: [{ externalPersonId: 'ext-1', individualId: 7 }],
    excludedPairs: new Set(['ext-1\u00007']),
    heldExternalIds: new Set(['ext-1']),
  }));

  assert.deepEqual(result.linked, [{ individualId: 7, externalPersonId: 'ext-1', reason: 'existing_link' }]);
  assert.deepEqual(result.ambiguous, []);
});

test('matches a unique normalized name and ignores email and mobile values', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Jos\u00e9', "O\u2019Brien-Smith", {
      email: 'same@example.com', mobile: '+61 400 000 000',
    })],
    localPeople: [local(1, 'Jose', 'OBrienSmith', {
      email: 'different@example.com', mobile: '+61 499 999 999',
    })],
  }));

  assert.deepEqual(result.matches, [{ individualId: 1, externalPersonId: 'e1', reason: 'unique_name' }]);
});

test('does not auto-match on email because local people do not model it', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Different', 'Name', { email: 'same@example.com' })],
    localPeople: [local(1, 'Local', 'Person', { email: 'same@example.com' })],
  }));

  assert.deepEqual(result.unmatchedExternalIds, ['e1']);
  assert.deepEqual(result.unmatchedLocalIds, [1]);
});

test('does not auto-match on a shared custom identifier', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Different', 'Name', { customId: 'church-123' })],
    localPeople: [local(1, 'Local', 'Person', { customId: 'church-123' })],
  }));

  assert.deepEqual(result.unmatchedExternalIds, ['e1']);
  assert.deepEqual(result.unmatchedLocalIds, [1]);
});

test('uses known child state to narrow an otherwise duplicate name', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Sam', 'Lee', { child: true })],
    localPeople: [local(4, 'Sam', 'Lee', { isChild: false }), local(9, 'Sam', 'Lee', { isChild: true })],
  }));

  assert.deepEqual(result.matches, [{ individualId: 9, externalPersonId: 'e1', reason: 'child_narrowing' }]);
  assert.deepEqual(result.unmatchedLocalIds, [4]);
});

test('does not guess from an unknown child state', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Sam', 'Lee', { child: null })],
    localPeople: [local(4, 'Sam', 'Lee', { isChild: false }), local(9, 'Sam', 'Lee', { isChild: true })],
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'e1', candidateIndividualIds: [4, 9], reason: 'duplicate_name',
  }]);
});

test('uses family corroboration only when a different household member has a real durable link', () => {
  const result = matchPeople(input({
    externalPeople: [
      external('e-target-a', 'John', 'Smith', { familyId: 'external-a' }),
      external('e-linked', 'Jane', 'Smith', { familyId: 'external-a' }),
    ],
    localPeople: [
      local(1, 'John', 'Smith', { familyId: 10 }),
      local(2, 'John', 'Smith', { familyId: 20 }),
      local(3, 'Jane', 'Smith', { familyId: 10 }),
    ],
    existingLinks: [{ externalPersonId: 'e-linked', individualId: 3 }],
    localFamilyMembers: new Map([[10, [local(1, 'John', 'Smith', { familyId: 10 }), local(3, 'Jane', 'Smith', { familyId: 10 })]]]),
    externalFamilyMembers: new Map([
      ['external-a', [external('e-target-a', 'John', 'Smith', { familyId: 'external-a' }), external('e-linked', 'Jane', 'Smith', { familyId: 'external-a' })]],
    ]),
  }));

  assert.deepEqual(result.linked, [{ individualId: 3, externalPersonId: 'e-linked', reason: 'existing_link' }]);
  assert.deepEqual(result.matches, [{ individualId: 1, externalPersonId: 'e-target-a', reason: 'family_corroboration' }]);
  assert.deepEqual(result.unmatchedLocalIds, [2]);
});

test('keeps conflicting family corroboration in review rather than guessing', () => {
  const result = matchPeople(input({
    externalPeople: [
      external('e-target', 'John', 'Smith', { familyId: 'external-a' }),
      external('e-jane', 'Jane', 'Smith', { familyId: 'external-a' }),
      external('e-jake', 'Jake', 'Smith', { familyId: 'external-a' }),
    ],
    localPeople: [
      local(1, 'John', 'Smith', { familyId: 10 }), local(2, 'John', 'Smith', { familyId: 20 }),
      local(3, 'Jane', 'Smith', { familyId: 10 }), local(4, 'Jake', 'Smith', { familyId: 20 }),
    ],
    existingLinks: [
      { externalPersonId: 'e-jane', individualId: 3 }, { externalPersonId: 'e-jake', individualId: 4 },
    ],
    localFamilyMembers: new Map([
      [10, [local(1, 'John', 'Smith', { familyId: 10 }), local(3, 'Jane', 'Smith', { familyId: 10 })]],
      [20, [local(2, 'John', 'Smith', { familyId: 20 }), local(4, 'Jake', 'Smith', { familyId: 20 })]],
    ]),
    externalFamilyMembers: new Map([
      ['external-a', [external('e-target', 'John', 'Smith', { familyId: 'external-a' }), external('e-jane', 'Jane', 'Smith', { familyId: 'external-a' }), external('e-jake', 'Jake', 'Smith', { familyId: 'external-a' })]],
    ]),
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'e-target', candidateIndividualIds: [1, 2], reason: 'conflicting_family_evidence',
  }]);
});

test('keeps visitors and archived people in explicit review buckets', () => {
  const result = matchPeople(input({
    externalPeople: [external('e-visitor', 'Vera', 'Visitor'), external('e-archived', 'Arnie', 'Archived')],
    localPeople: [
      local(1, 'Vera', 'Visitor', { peopleType: 'local_visitor' }),
      local(2, 'Arnie', 'Archived', { isActive: false }),
    ],
  }));

  assert.deepEqual(result.visitorMatches, [{
    externalPersonId: 'e-visitor', individualId: 1, peopleType: 'local_visitor',
  }]);
  assert.deepEqual(result.archivedMatches, [{ externalPersonId: 'e-archived', individualId: 2 }]);
  assert.deepEqual(result.matches, []);
});

test('does not let same-name visitor or archived records prevent a regular match', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Robin', 'Same')],
    localPeople: [
      local(1, 'Robin', 'Same', { peopleType: 'traveller_visitor' }),
      local(2, 'Robin', 'Same', { isActive: false }),
      local(3, 'Robin', 'Same'),
    ],
  }));

  assert.deepEqual(result.matches, [{ individualId: 3, externalPersonId: 'e1', reason: 'unique_name' }]);
  assert.deepEqual(result.visitorMatches, []);
  assert.deepEqual(result.archivedMatches, []);
});

test('keeps a same-name visitor and archived person together for review', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Robin', 'Review')],
    localPeople: [
      local(1, 'Robin', 'Review', { peopleType: 'local_visitor' }),
      local(2, 'Robin', 'Review', { isActive: false }),
    ],
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'e1', candidateIndividualIds: [1, 2], reason: 'review_candidates',
  }]);
  assert.deepEqual(result.visitorMatches, []);
  assert.deepEqual(result.archivedMatches, []);
});

test('keeps multiple visitors and an archived person together for review', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Robin', 'Review')],
    localPeople: [
      local(1, 'Robin', 'Review', { peopleType: 'local_visitor' }),
      local(2, 'Robin', 'Review', { peopleType: 'traveller_visitor' }),
      local(3, 'Robin', 'Review', { isActive: false }),
    ],
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'e1', candidateIndividualIds: [1, 2, 3], reason: 'review_candidates',
  }]);
});

test('never reuses duplicate durable-link candidates', () => {
  const result = matchPeople(input({
    externalPeople: [external('e-a', 'A', 'Person'), external('e-b', 'B', 'Person')],
    localPeople: [local(1, 'A', 'Person')],
    existingLinks: [
      { externalPersonId: 'e-a', individualId: 1 }, { externalPersonId: 'e-b', individualId: 1 },
    ],
  }));

  assert.deepEqual(result.linked, []);
  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'e-a', candidateIndividualIds: [1], reason: 'conflicting_existing_link',
  }, {
    externalPersonId: 'e-b', candidateIndividualIds: [1], reason: 'conflicting_existing_link',
  }]);
});

test('surfaces a stale durable link instead of falling back to a name match', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Sarah', 'Jones')],
    localPeople: [local(1, 'Sarah', 'Jones')],
    existingLinks: [{ externalPersonId: 'e1', individualId: 99 }],
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'e1', candidateIndividualIds: [], staleLinkedIndividualIds: [99], reason: 'stale_link',
  }]);
  assert.deepEqual(result.matches, []);
});

test('surfaces mixed stale and valid durable-link claims for review', () => {
  const result = matchPeople(input({
    externalPeople: [external('e1', 'Sarah', 'Jones')],
    localPeople: [local(1, 'Sarah', 'Jones')],
    existingLinks: [
      { externalPersonId: 'e1', individualId: 1 }, { externalPersonId: 'e1', individualId: 99 },
    ],
  }));

  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'e1', candidateIndividualIds: [1], staleLinkedIndividualIds: [99], reason: 'stale_link',
  }]);
  assert.deepEqual(result.linked, []);
});

test('keeps reciprocal contention ambiguous instead of assigning one local by external sort order', () => {
  const result = matchPeople(input({
    externalPeople: [external('e-b', 'Alex', 'Lee'), external('e-a', 'Alex', 'Lee')],
    localPeople: [local(1, 'Alex', 'Lee')],
  }));

  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.ambiguous, [{
    externalPersonId: 'e-a', candidateIndividualIds: [1], reason: 'contended_unique_name',
  }, {
    externalPersonId: 'e-b', candidateIndividualIds: [1], reason: 'contended_unique_name',
  }]);
});

test('allows same-name externals narrowed by opposite child states to match independently after reordering', () => {
  const first = input({
    externalPeople: [
      external('e-child', 'Alex', 'Lee', { child: true }),
      external('e-adult', 'Alex', 'Lee', { child: false }),
    ],
    localPeople: [local(1, 'Alex', 'Lee', { isChild: false }), local(2, 'Alex', 'Lee', { isChild: true })],
  });
  const second = input({ ...first, externalPeople: [...first.externalPeople].reverse() });
  const expected = [{
    individualId: 1, externalPersonId: 'e-adult', reason: 'child_narrowing',
  }, {
    individualId: 2, externalPersonId: 'e-child', reason: 'child_narrowing',
  }];

  assert.deepEqual(matchPeople(first).matches, expected);
  assert.deepEqual(matchPeople(second).matches, expected);
});

test('allows same-name externals corroborated by separate linked families to match independently after reordering', () => {
  const first = input({
    externalPeople: [
      external('e-two', 'John', 'Smith', { familyId: 'external-2' }),
      external('e-linked-1', 'Jane', 'Smith', { familyId: 'external-1' }),
      external('e-one', 'John', 'Smith', { familyId: 'external-1' }),
      external('e-linked-2', 'Jill', 'Smith', { familyId: 'external-2' }),
    ],
    localPeople: [
      local(1, 'John', 'Smith', { familyId: 10 }), local(2, 'John', 'Smith', { familyId: 20 }),
      local(3, 'Jane', 'Smith', { familyId: 10 }), local(4, 'Jill', 'Smith', { familyId: 20 }),
    ],
    existingLinks: [
      { externalPersonId: 'e-linked-1', individualId: 3 }, { externalPersonId: 'e-linked-2', individualId: 4 },
    ],
    localFamilyMembers: new Map([
      [10, [local(1, 'John', 'Smith', { familyId: 10 }), local(3, 'Jane', 'Smith', { familyId: 10 })]],
      [20, [local(2, 'John', 'Smith', { familyId: 20 }), local(4, 'Jill', 'Smith', { familyId: 20 })]],
    ]),
    externalFamilyMembers: new Map([
      ['external-1', [external('e-one', 'John', 'Smith', { familyId: 'external-1' }), external('e-linked-1', 'Jane', 'Smith', { familyId: 'external-1' })]],
      ['external-2', [external('e-two', 'John', 'Smith', { familyId: 'external-2' }), external('e-linked-2', 'Jill', 'Smith', { familyId: 'external-2' })]],
    ]),
  });
  const second = input({ ...first, externalPeople: [...first.externalPeople].reverse() });
  const expected = [{
    individualId: 1, externalPersonId: 'e-one', reason: 'family_corroboration',
  }, {
    individualId: 2, externalPersonId: 'e-two', reason: 'family_corroboration',
  }];

  assert.deepEqual(matchPeople(first).matches, expected);
  assert.deepEqual(matchPeople(second).matches, expected);
});

test('keeps visitor and archived review candidates globally contended after reordering', () => {
  const visitor = input({
    externalPeople: [external('e-two', 'Vera', 'Review'), external('e-one', 'Vera', 'Review')],
    localPeople: [local(1, 'Vera', 'Review', { peopleType: 'local_visitor' })],
  });
  const archived = input({
    externalPeople: [external('a-two', 'Arnie', 'Review'), external('a-one', 'Arnie', 'Review')],
    localPeople: [local(2, 'Arnie', 'Review', { isActive: false })],
  });
  const expectedVisitor = [{
    externalPersonId: 'e-one', candidateIndividualIds: [1], reason: 'contended_review_candidate',
  }, {
    externalPersonId: 'e-two', candidateIndividualIds: [1], reason: 'contended_review_candidate',
  }];
  const expectedArchived = [{
    externalPersonId: 'a-one', candidateIndividualIds: [2], reason: 'contended_review_candidate',
  }, {
    externalPersonId: 'a-two', candidateIndividualIds: [2], reason: 'contended_review_candidate',
  }];

  assert.deepEqual(matchPeople(visitor).ambiguous, expectedVisitor);
  assert.deepEqual(matchPeople(input({ ...visitor, externalPeople: [...visitor.externalPeople].reverse() })).ambiguous, expectedVisitor);
  assert.deepEqual(matchPeople(archived).ambiguous, expectedArchived);
  assert.deepEqual(matchPeople(input({ ...archived, externalPeople: [...archived.externalPeople].reverse() })).ambiguous, expectedArchived);
});

test('canonicalizes equivalent duplicate external records with type-varied family ids before family corroboration', () => {
  const targetNumber = external('e-target', 'John', 'Smith', { familyId: 1, email: 'first@example.com' });
  const targetString = external('e-target', 'John', 'Smith', { familyId: '1', customId: 'ignored-custom-id' });
  const linked = external('e-linked', 'Jane', 'Smith', { familyId: 1 });
  const first = input({
    externalPeople: [targetNumber, targetString, linked],
    localPeople: [
      local(1, 'John', 'Smith', { familyId: 10 }), local(2, 'John', 'Smith', { familyId: 20 }),
      local(3, 'Jane', 'Smith', { familyId: 10 }),
    ],
    existingLinks: [{ externalPersonId: 'e-linked', individualId: 3 }],
    localFamilyMembers: new Map([[10, [local(1, 'John', 'Smith', { familyId: 10 }), local(3, 'Jane', 'Smith', { familyId: 10 })]]]),
    externalFamilyMembers: new Map([[1, [targetString, linked]]]),
  });
  const second = input({ ...first, externalPeople: [...first.externalPeople].reverse() });
  const expected = {
    ...emptyResult(),
    linked: [{ individualId: 3, externalPersonId: 'e-linked', reason: 'existing_link' }],
    matches: [{ individualId: 1, externalPersonId: 'e-target', reason: 'family_corroboration' }],
    unmatchedLocalIds: [2],
  };

  assert.deepEqual(matchPeople(first), expected);
  assert.deepEqual(matchPeople(second), expected);
});

test('keeps conflicting duplicate external records review-safe after input reordering', () => {
  const first = input({
    externalPeople: [external('e1', 'Alex', 'Lee'), external('e1', 'Blair', 'Lee')],
    localPeople: [local(1, 'Alex', 'Lee'), local(2, 'Blair', 'Lee')],
  });
  const second = input({ ...first, externalPeople: [...first.externalPeople].reverse() });
  const expected = {
    ...emptyResult(),
    ambiguous: [{ externalPersonId: 'e1', candidateIndividualIds: [], reason: 'duplicate_external_id' }],
    unmatchedLocalIds: [1, 2],
  };

  assert.deepEqual(matchPeople(first), expected);
  assert.deepEqual(matchPeople(second), expected);
});

test('orders results deterministically and never matches blank names', () => {
  const common = input({
    externalPeople: [external('z', '', ''), external('b', 'Bea', 'Able'), external('a', 'Ann', 'Able')],
    localPeople: [local(9, '', ''), local(5, 'Bea', 'Able'), local(2, 'Ann', 'Able')],
  });
  const reordered = input({
    ...common,
    externalPeople: [...common.externalPeople].reverse(),
    localPeople: [...common.localPeople].reverse(),
  });

  assert.deepEqual(matchPeople(common), {
    ...emptyResult(),
    matches: [
      { individualId: 2, externalPersonId: 'a', reason: 'unique_name' },
      { individualId: 5, externalPersonId: 'b', reason: 'unique_name' },
    ],
    unmatchedExternalIds: ['z'],
    unmatchedLocalIds: [9],
  });
  assert.deepEqual(matchPeople(reordered), matchPeople(common));
});
