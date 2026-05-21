// Project a raw PCO Person (people/v2/people with include=households) down to the
// minimal shape the sync engine needs. Keeps memory flat — callers discard the raw.
function projectPerson(p) {
  const a = p.attributes || {};
  const hh = p.relationships && p.relationships.households && p.relationships.households.data;
  return {
    id: p.id,
    firstName: a.first_name || '',
    lastName: a.last_name || '',
    status: a.status || null,
    membership: a.membership || null,
    child: a.child === true,
    householdId: (hh && hh[0] && hh[0].id) || null,
  };
}

module.exports = { projectPerson };
