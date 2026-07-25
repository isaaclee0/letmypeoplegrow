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

// ─── Provider-neutral adapter helper (Task 8) ──────────────────────────────
//
// isEligible() above is the canonical PCO filter-evaluation logic and is
// used unchanged by the existing diffEngine.js pipeline. The provider-neutral
// adapter contract (providerRegistry.js) calls adapter.isEligible(person,
// filterConfig) with a *normalized* person (projection.js's
// toNormalizedPcoPerson shape: { attributes: { membership, fieldValues } },
// among other fields) rather than PCO's own projected shape ({ membership,
// fieldValues } at the top level). fromNormalized() converts back so the one
// isEligible() implementation above stays the single source of truth for PCO
// filter semantics — nothing here duplicates or reinterprets its rules.
function fromNormalized(person) {
  const attributes = (person && person.attributes) || {};
  return {
    id: person && person.id,
    membership: attributes.membership ?? null,
    fieldValues: attributes.fieldValues || {},
  };
}

module.exports = { isEligible, fromNormalized };
