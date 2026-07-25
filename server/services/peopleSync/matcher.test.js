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
