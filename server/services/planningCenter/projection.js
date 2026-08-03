// Project a raw PCO Person (people/v2/people with include=households,field_data) down
// to the minimal shape the sync engine needs. Keeps memory flat — callers discard the
// raw payload.
//
// fieldDataById: optional Map of FieldDatum id -> raw FieldDatum resource (from the
// same page's `included` array), used to resolve this person's relationships.field_data
// references into a { [fieldDefinitionId]: value[] } map. A person can have multiple
// FieldDatum rows for the same field_definition (PCO's multi-select `checkboxes` data
// type has one row per checked box), so each field's values accumulate into an array.
function projectPerson(p, fieldDataById) {
  const a = p.attributes || {};
  const hh = p.relationships && p.relationships.households && p.relationships.households.data;

  const fieldValues = {};
  const fieldDataRefs = (p.relationships && p.relationships.field_data && p.relationships.field_data.data) || [];
  if (fieldDataById) {
    for (const ref of fieldDataRefs) {
      const datum = fieldDataById.get(ref.id);
      if (!datum) continue;
      const fieldDefinitionId = datum.relationships
        && datum.relationships.field_definition
        && datum.relationships.field_definition.data
        && datum.relationships.field_definition.data.id;
      if (!fieldDefinitionId) continue;
      const value = datum.attributes && datum.attributes.value;
      // A FieldDatum row can exist with a blank/null value (e.g. an answer that was
      // cleared rather than removed). Treat that exactly like "no row at all" so it
      // falls through as an absent value downstream — otherwise it leaks a literal
      // null into the normalized provider attributes.
      if (value === null || value === undefined || value === '') continue;
      if (!fieldValues[fieldDefinitionId]) fieldValues[fieldDefinitionId] = [];
      fieldValues[fieldDefinitionId].push(value);
    }
  }

  return {
    id: p.id,
    firstName: a.first_name || '',
    lastName: a.last_name || '',
    status: a.status || null,
    membership: a.membership || null,
    child: a.child === true,
    // Preserve PCO's null/absent (no background-check data at all) as null —
    // collapsing it to false would make applyBackgroundCheckSnapshot write
    // "not cleared" for someone who was simply never checked.
    passedBackgroundCheck: typeof a.passed_background_check === 'boolean' ? a.passed_background_check : null,
    householdId: (hh && hh[0] && hh[0].id) || null,
    fieldValues,
  };
}

// ─── Provider-neutral adapter helpers (Task 8) ─────────────────────────────
//
// Below wraps projectPerson's output (and PCO's household data) into the
// normalized shapes the provider-neutral matcher/plan engine (Task 5/6)
// expects: { provider, id, firstName, lastName, child, state, familyId,
// attributes }. This is purely an additive projection on top of the existing
// data — it does not change projectPerson or the source adapter that consumes
// its output.
//
// PCO's Person.attributes.status is a plain 'active' | 'inactive'.
// There is no separate PCO "contact"/"deceased" person state to preserve, so
// 'inactive' maps to the generic engine's 'archived' terminal state.
function toNormalizedPcoPerson(pcoPerson) {
  return {
    provider: 'planning_center',
    id: pcoPerson.id,
    firstName: pcoPerson.firstName,
    lastName: pcoPerson.lastName,
    child: typeof pcoPerson.child === 'boolean' ? pcoPerson.child : null,
    state: pcoPerson.status === 'active' ? 'active' : 'archived',
    familyId: pcoPerson.householdId ?? null,
    // Retains optional PCO details used by unrelated field and background
    // check features. Provider-owned List membership is resolved separately
    // by sourceAdapter.js, never from these attributes.
    attributes: {
      membership: pcoPerson.membership ?? null,
      passedBackgroundCheck: typeof pcoPerson.passedBackgroundCheck === 'boolean' ? pcoPerson.passedBackgroundCheck : null,
      fieldValues: pcoPerson.fieldValues || {},
    },
  };
}

// Projects PCO Households (as seen via each projected person's householdId,
// plus metadata collected during the source read) into the provider-neutral
// family shape used by matching and the lean review directory. Only the
// household name and identity/member references cross this boundary; raw
// Household attributes remain in the discarded provider page.
function projectPcoHouseholds(people, householdPrimaryContacts, householdNames) {
  const memberIdsByHousehold = new Map();
  for (const person of people || []) {
    if (!person || !person.householdId) continue;
    if (!memberIdsByHousehold.has(person.householdId)) memberIdsByHousehold.set(person.householdId, []);
    memberIdsByHousehold.get(person.householdId).push(person.id);
  }
  const primaryContacts = householdPrimaryContacts instanceof Map ? householdPrimaryContacts : new Map();
  const names = householdNames instanceof Map ? householdNames : new Map();
  const families = [...memberIdsByHousehold.entries()].map(([householdId, memberExternalIds]) => {
    const name = String(names.get(householdId) ?? '').trim();
    return {
      id: householdId,
      ...(name ? { name } : {}),
      memberExternalIds: [...memberExternalIds].sort(),
      primaryContactExternalId: primaryContacts.get(householdId) || null,
    };
  });
  return families.sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { projectPerson, toNormalizedPcoPerson, projectPcoHouseholds };
