// Tally projected PCO people by membership value. Null/empty membership -> '(none)'.
// Returns { total, values: [{membership, count}] } sorted by count desc.
function tallyMembership(people) {
  const counts = new Map();
  for (const p of people) {
    const key = p.membership || '(none)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const values = [...counts.entries()]
    .map(([membership, count]) => ({ membership, count }))
    .sort((a, b) => b.count - a.count);
  return { total: people.length, values };
}

// Tally projected PCO people by their value(s) for one custom field (by fieldDefinitionId).
// A person's field value is an array (multi-select checkboxes can have several); each
// selected value is counted once. No selected values -> '(none)'. Returns
// { total, values: [{value, count}] } sorted by count desc.
//
// canonicalOptions (optional): the field's admin-defined option list in PCO (from
// FieldOption resources). Seeded into the tally at count 0 so options nobody has
// selected yet still show up as choices in the filter UI, instead of being invisible
// just because no currently-synced person has picked them.
function tallyField(people, fieldDefinitionId, canonicalOptions = []) {
  const counts = new Map();
  for (const opt of canonicalOptions) counts.set(opt, 0);
  for (const p of people) {
    const raw = (p.fieldValues && p.fieldValues[fieldDefinitionId]) || [];
    if (raw.length === 0) {
      counts.set('(none)', (counts.get('(none)') || 0) + 1);
      continue;
    }
    for (const key of raw) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const values = [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count);
  return { total: people.length, values };
}

module.exports = { tallyMembership, tallyField };
