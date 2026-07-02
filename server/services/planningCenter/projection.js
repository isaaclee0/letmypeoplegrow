// Project a raw PCO Person (people/v2/people with include=households,field_data) down
// to the minimal shape the sync engine needs. Keeps memory flat — callers discard the
// raw payload.
//
// fieldDataById: optional Map of FieldDatum id -> raw FieldDatum resource (from the
// same page's `included` array), used to resolve this person's relationships.field_data
// references into a { [fieldDefinitionId]: value } map.
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
      fieldValues[fieldDefinitionId] = (datum.attributes && datum.attributes.value) || null;
    }
  }

  return {
    id: p.id,
    firstName: a.first_name || '',
    lastName: a.last_name || '',
    status: a.status || null,
    membership: a.membership || null,
    child: a.child === true,
    householdId: (hh && hh[0] && hh[0].id) || null,
    fieldValues,
  };
}

module.exports = { projectPerson };
