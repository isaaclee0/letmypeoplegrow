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

module.exports = { buildFamilyName };
