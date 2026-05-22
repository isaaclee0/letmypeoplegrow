const { matchIndividuals } = require('./matcher');

// Inputs:
//   pcoPeople:   projected [{id, firstName, lastName, status, membership, child, householdId}]
//   individuals: [{id, firstName, lastName, isChild, familyId, isActive(bool), planningCenterId}]
//   families:    [{id, planningCenterId}]   (not used directly here; reserved for callers)
//   allowlist:   string[] of allowed membership values
// Output buckets: { link, ambiguous, unmatched, add, update, archive, reactivate }
function computePlan({ pcoPeople, individuals, families, allowlist }) {
  const allow = new Set(allowlist || []);
  const linked = individuals.filter((i) => i.planningCenterId);
  const unlinked = individuals.filter((i) => !i.planningCenterId);
  const linkedPcoIds = new Set(linked.map((i) => i.planningCenterId));
  const pcoById = new Map(pcoPeople.map((p) => [p.id, p]));
  const availablePco = pcoPeople.filter((p) => !linkedPcoIds.has(p.id));

  // family membership for corroboration
  const familyMembers = new Map();
  for (const i of individuals) {
    if (i.familyId == null) continue;
    if (!familyMembers.has(i.familyId)) familyMembers.set(i.familyId, []);
    familyMembers.get(i.familyId).push({ firstName: i.firstName, lastName: i.lastName });
  }

  const { links, ambiguous, unmatched } = matchIndividuals(unlinked, availablePco, familyMembers);

  const update = [];
  const archive = [];
  const reactivate = [];
  for (const i of linked) {
    const p = pcoById.get(i.planningCenterId);
    if (!p) continue; // linked person absent from PCO fetch -> leave alone
    if (i.isActive && p.status === 'inactive') {
      archive.push({ individualId: i.id, pcoId: p.id });
    } else if (!i.isActive && p.status === 'active' && allow.has(p.membership)) {
      reactivate.push({ individualId: i.id, pcoId: p.id });
    }
    if (p.firstName !== i.firstName || p.lastName !== i.lastName || p.child !== !!i.isChild) {
      update.push({ individualId: i.id, pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child });
    }
  }

  // add: allow-listed active people not consumed by a link or ambiguous candidate
  const usedPco = new Set(links.map((l) => l.pcoId));
  for (const a of ambiguous) for (const c of a.candidates) usedPco.add(c);
  const add = [];
  for (const p of availablePco) {
    if (usedPco.has(p.id)) continue;
    if (p.status === 'active' && allow.has(p.membership)) {
      add.push({ pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child, householdId: p.householdId, membership: p.membership });
    }
  }

  const individualsById = new Map(individuals.map((i) => [i.id, i]));
  const ambiguousEnriched = ambiguous.map((a) => {
    const ind = individualsById.get(a.individualId);
    return {
      individualId: a.individualId,
      firstName: ind ? ind.firstName : '',
      lastName: ind ? ind.lastName : '',
      candidates: a.candidates, // bare PCO ids (kept for apply-side validation)
      candidateDetails: a.candidates.map((id) => {
        const p = pcoById.get(id);
        return { pcoId: id, firstName: p ? p.firstName : '', lastName: p ? p.lastName : '', membership: p ? p.membership : null };
      }),
    };
  });

  return { link: links, ambiguous: ambiguousEnriched, unmatched, add, update, archive, reactivate };
}

module.exports = { computePlan };
