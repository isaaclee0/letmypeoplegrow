// A person is eligible for sync if AT LEAST ONE enabled source matches (OR across
// sources). Within the custom-field source, every configured rule must match (AND).
// An enabled source with no configured allow-list/rules contributes nobody — a
// half-configured filter never silently makes everyone eligible.
function isEligible(person, filterConfig) {
  if (filterConfig.membershipFilterEnabled) {
    const allow = new Set(filterConfig.membershipAllowlist || []);
    if (allow.has(person.membership)) return true;
  }
  if (filterConfig.fieldFilterEnabled) {
    const rules = filterConfig.fieldFilters || [];
    if (rules.length) {
      const matches = rules.every((r) => {
        // Defensively drop falsy entries (null/undefined/'') — a blank answer must be
        // treated the same as no answer at all, not as a real (unmatchable) value that
        // silently bypasses the '(none)' sentinel check below.
        const vals = ((person.fieldValues && person.fieldValues[r.fieldDefinitionId]) || []).filter(Boolean);
        if (vals.length === 0) return r.values.includes('(none)');
        return vals.some((val) => r.values.includes(val));
      });
      if (matches) return true;
    }
  }
  return false;
}

module.exports = { isEligible };
