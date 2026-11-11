'use strict';

function isChild(member) {
  return member?.child === true || member?.isChild === true;
}

function buildFamilyName(members = []) {
  const usable = members.filter((member) =>
    String(member?.firstName || '').trim() || String(member?.lastName || '').trim());
  const adults = usable.filter((member) => !isChild(member));
  const selected = adults.length ? adults : usable;
  if (!selected.length) return '';

  const lastName = String(selected[0].lastName || '').trim();
  const firstNames = selected
    .map((member) => String(member.firstName || '').trim())
    .filter(Boolean);
  if (!lastName) return firstNames.join(' and ');
  return firstNames.length ? `${lastName}, ${firstNames.join(' and ')}` : lastName;
}

function buildSinglePersonFamilyName(person) {
  const firstName = String(person?.firstName || '').trim();
  const lastName = String(person?.lastName || '').trim().toUpperCase();
  return lastName && firstName ? `${lastName}, ${firstName}` : lastName || firstName;
}

function hasConfirmedNoHousehold(person, families = []) {
  return Array.isArray(person?.householdIds) && person.householdIds.length === 0 && person.familyId == null &&
    !families.some(family => [...(family.memberExternalIds || []), ...(family.householdMemberExternalIds || [])]
      .some(id => String(id) === String(person.id)));
}

module.exports = { buildFamilyName, buildSinglePersonFamilyName, hasConfirmedNoHousehold };
