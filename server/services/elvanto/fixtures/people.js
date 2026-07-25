'use strict';

// Sanitized, fabricated Elvanto "person" fixtures for normalizer.test.js.
// Every name/id/value here is invented for this task — NONE of it is real
// church data.
//
// Field-name conventions below are chosen deliberately, not guessed at
// random:
//   - `firstname` / `lastname` / `preferred_name` / `family_id` /
//     `family_relationship` / `archived` match the existing one-shot Elvanto
//     importer (server/routes/integrations.js) exactly, e.g.
//     `person.family_relationship === 'Primary Contact' | 'Spouse' | 'Child'`,
//     `p.archived === 1 || p.archived === '1'`. The Task 11 HTTP client's own
//     tests also use `firstname` (see httpClient.test.js).
//   - `deceased` / `contact` appear nowhere else in this repo — there is no
//     legacy code path exercising them. They are taken directly, and only,
//     from Task 12's own spec examples
//     (`deriveElvantoState({ deceased: '1', archived: '0', contact: '1' })`),
//     which are authoritative for these two field names/shapes.
//   - `category` / `date_modified` / `custom_fields` / `demographics` are
//     inferred from Elvanto's known API surface (the debug-dump route hits
//     `people/categories/getAll.json` and fetches people with
//     `fields=family,demographics`) but are NOT independently confirmed
//     against Elvanto's API docs — see the top-of-file note in
//     ../normalizer.js for how normalizer.js handles this uncertainty
//     defensively (accepting both object- and array-shaped payloads).

function person(overrides = {}) {
  return {
    id: '1000',
    firstname: 'Fallback',
    lastname: 'Person',
    preferred_name: '',
    family_id: '',
    family_relationship: '',
    archived: '0',
    contact: '0',
    deceased: '0',
    category: null,
    date_modified: '2024-01-01 08:00:00',
    custom_fields: {},
    demographics: {},
    ...overrides,
  };
}

// ─── Status precedence: Active / Contact / Archived / Deceased ─────────────

const activePerson = person({
  id: '2001',
  firstname: 'Alice',
  lastname: 'Anderson',
  family_id: 'fam-100',
  family_relationship: 'Primary Contact',
  category: { id: 'cat-1', name: 'Members' },
  date_modified: '2024-03-01 09:30:00',
  custom_fields: { 'Favorite Color': 'Blue' },
  demographics: { marital_status: 'Married' },
});

const contactPerson = person({
  id: '2002',
  firstname: 'Cara',
  lastname: 'Contact',
  contact: '1',
});

const archivedPerson = person({
  id: '2003',
  firstname: 'Aaron',
  lastname: 'Archer',
  archived: '1',
});

const deceasedPerson = person({
  id: '2004',
  firstname: 'Derek',
  lastname: 'Deacon',
  deceased: '1',
});

// Overlapping flags: deceased AND archived AND contact are all truthy at
// once — precedence must resolve to the most terminal state, 'deceased'.
const overlappingFlagsPerson = person({
  id: '2005',
  firstname: 'Olive',
  lastname: 'Overlap',
  deceased: '1',
  archived: '1',
  contact: '1',
});

// ─── Family relationships: Primary Contact / Spouse / Child ────────────────
// Shares family_id 'fam-100' with activePerson (the Primary Contact above),
// forming one complete family: Alice (Primary Contact) + Beth (Spouse) +
// Cody (Child).

const spousePerson = person({
  id: '2006',
  firstname: 'Beth',
  lastname: 'Anderson',
  family_id: 'fam-100',
  family_relationship: 'Spouse',
});

const childPerson = person({
  id: '2007',
  firstname: 'Cody',
  lastname: 'Anderson',
  family_id: 'fam-100',
  family_relationship: 'Child',
});

// ─── Solo person: no family_id at all ───────────────────────────────────────

const soloPerson = person({
  id: '2008',
  firstname: 'Sam',
  lastname: 'Solo',
  family_id: '',
});

// ─── Preferred name ─────────────────────────────────────────────────────────

const preferredNamePerson = person({
  id: '2009',
  firstname: 'Robert',
  lastname: 'Roberts',
  preferred_name: 'Rob',
});

// ─── Missing / invalid records (must land in normalizeSnapshot's `skipped`) ─

const missingNamesPerson = person({
  id: '2010',
  firstname: '',
  lastname: '',
});

const missingIdPerson = person({
  id: '',
  firstname: 'Ghost',
  lastname: 'Person',
});

// ─── Custom fields: single-value vs list-value ──────────────────────────────

const singleValueCustomFieldPerson = person({
  id: '2011',
  firstname: 'Sasha',
  lastname: 'Single',
  custom_fields: { 'T-Shirt Size': 'M' },
});

const listValueCustomFieldPerson = person({
  id: '2012',
  firstname: 'Lena',
  lastname: 'List',
  custom_fields: { Interests: ['Music', 'Sports'] },
});

// ─── Absent optional fields entirely (not even blank — the keys are missing) ─

const noOptionalFieldsPerson = {
  id: '2013',
  firstname: 'Nora',
  lastname: 'NoExtras',
};

const familyMembers = [activePerson, spousePerson, childPerson];

const rawPeopleSnapshot = [
  activePerson,
  contactPerson,
  archivedPerson,
  deceasedPerson,
  overlappingFlagsPerson,
  spousePerson,
  childPerson,
  soloPerson,
  preferredNamePerson,
  missingNamesPerson,
  missingIdPerson,
  singleValueCustomFieldPerson,
  listValueCustomFieldPerson,
  noOptionalFieldsPerson,
];

module.exports = {
  person,
  activePerson,
  contactPerson,
  archivedPerson,
  deceasedPerson,
  overlappingFlagsPerson,
  spousePerson,
  childPerson,
  soloPerson,
  preferredNamePerson,
  missingNamesPerson,
  missingIdPerson,
  singleValueCustomFieldPerson,
  listValueCustomFieldPerson,
  noOptionalFieldsPerson,
  familyMembers,
  rawPeopleSnapshot,
};
