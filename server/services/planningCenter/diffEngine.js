const { matchIndividuals } = require('./matcher');
const { isEligible } = require('./eligibility');

// Inputs:
//   pcoPeople:   projected [{id, firstName, lastName, status, membership, child, householdId, fieldValues}]
//   individuals: [{id, firstName, lastName, isChild, familyId, isActive(bool),
//                  planningCenterId, peopleType, pcoLinkDeclined}]
//   families:    [{id, planningCenterId}]   (not used directly here; reserved for callers)
//   filterConfig: { membershipFilterEnabled, membershipAllowlist, fieldFilterEnabled, fieldFilters }
//                — see eligibility.js for match semantics
//
// Output buckets:
//   link              — unlinked active individuals matched to a PCO person (set planning_center_id)
//   restore           — unlinked **archived** individuals matched to a PCO person (link + reactivate)
//   ambiguous         — needs reviewer decision (multiple PCO candidates for one LMPG individual)
//   visitorMatches    — needs reviewer decision: a visitor's name matches a PCO person (promote-to-regular or keep-as-visitor)
//   archiveExtras     — active 'regular' individuals that did NOT match PCO (manual/unmatched regulars to archive on review)
//   unmatchedVisitors — visitors that did NOT match PCO (informational; LMPG owns them)
//   add               — eligible active PCO people not consumed by a link/ambiguous/visitorMatch candidate (new regulars to create)
//   update            — linked individuals whose name/age differs from PCO (sync these fields down)
//   archive           — linked individuals whose PCO status went 'inactive'
//   reactivate        — linked individuals whose PCO status is 'active' again (still eligible)
//   gatheringEligible — linked individuals who end this run active AND eligible (already-active or reactivated)
function computePlan({ pcoPeople, individuals, families, filterConfig }) {
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

  // Hide visitors with pco_link_declined = 1 from the matcher entirely. They've
  // already been told "no, not a member" — no point re-prompting.
  const unlinkedForMatcher = unlinked.filter((i) => !i.pcoLinkDeclined);
  const declinedVisitorIds = new Set(
    unlinked.filter((i) => i.pcoLinkDeclined).map((i) => i.id)
  );

  const { links: matchedLinks, ambiguous, unmatched } = matchIndividuals(unlinkedForMatcher, availablePco, familyMembers);

  const individualsById = new Map(individuals.map((i) => [i.id, i]));

  // Split matched links by row state:
  //   - visitor    -> visitorMatches (decision required; no auto-link)
  //   - archived   -> restore (link + reactivate)
  //   - active     -> link (just attach pcoId)
  const link = [];
  const restore = [];
  const visitorMatches = [];
  for (const m of matchedLinks) {
    const ind = individualsById.get(m.individualId);
    const type = (ind && ind.peopleType) || 'regular';
    const isVisitor = type === 'local_visitor' || type === 'traveller_visitor';
    if (isVisitor) {
      const pco = pcoById.get(m.pcoId);
      visitorMatches.push({
        individualId: m.individualId,
        firstName: ind ? ind.firstName : '',
        lastName: ind ? ind.lastName : '',
        peopleType: type,
        candidate: {
          pcoId: m.pcoId,
          firstName: pco ? pco.firstName : '',
          lastName: pco ? pco.lastName : '',
          membership: pco ? pco.membership : null,
        },
      });
      continue;
    }
    if (ind && ind.isActive === false) {
      restore.push({ individualId: m.individualId, pcoId: m.pcoId });
    } else {
      link.push({ individualId: m.individualId, pcoId: m.pcoId });
    }
  }

  // Update / archive / reactivate for already-linked rows (unchanged from before).
  // gatheringEligible additionally tracks every linked individual who ends this run
  // active and eligible for filterConfig — whether they were already active, or are
  // being reactivated this run — so any batch with a gathering assigned can add them
  // to its roster even though they don't need linking/restoring/adding. It has no
  // effect on any other bucket; it's purely an extra input for gathering-roster
  // assignment in apply.js.
  const update = [];
  const archive = [];
  const reactivate = [];
  const gatheringEligible = [];
  for (const i of linked) {
    const p = pcoById.get(i.planningCenterId);
    if (!p) continue; // linked person absent from PCO fetch -> leave alone
    if (i.isActive && p.status === 'inactive') {
      archive.push({ individualId: i.id, pcoId: p.id });
    } else if (!i.isActive && p.status === 'active' && isEligible(p, filterConfig)) {
      reactivate.push({ individualId: i.id, pcoId: p.id });
      gatheringEligible.push({ individualId: i.id, pcoId: p.id });
    } else if (i.isActive && isEligible(p, filterConfig)) {
      gatheringEligible.push({ individualId: i.id, pcoId: p.id });
    }
    if (p.firstName !== i.firstName || p.lastName !== i.lastName || p.child !== !!i.isChild) {
      update.push({ individualId: i.id, pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child });
    }
  }

  // Re-bucket the matcher's "unmatched" by peopleType + isActive:
  //   active + regular  -> archiveExtras  (manual regulars not in PCO)
  //   visitor (any)     -> unmatchedVisitors (informational)
  //   archived + regular -> silent (already archived; nothing to do)
  const archiveExtras = [];
  const unmatchedVisitors = [];
  for (const id of unmatched) {
    const ind = individualsById.get(id);
    if (!ind) continue;
    const type = ind.peopleType || 'regular';
    const isVisitor = type === 'local_visitor' || type === 'traveller_visitor';
    if (isVisitor) {
      unmatchedVisitors.push({ individualId: id, firstName: ind.firstName, lastName: ind.lastName, peopleType: type });
      continue;
    }
    if (ind.isActive) {
      archiveExtras.push({ individualId: id, firstName: ind.firstName, lastName: ind.lastName });
    }
    // else: archived + regular + unmatched — silent no-op.
  }

  // Visitors with pco_link_declined = 1 were excluded from the matcher to suppress
  // re-prompting; they still belong in the informational unmatchedVisitors list so
  // the reviewer can see them.
  for (const id of declinedVisitorIds) {
    const ind = individualsById.get(id);
    if (!ind) continue;
    unmatchedVisitors.push({
      individualId: id,
      firstName: ind.firstName,
      lastName: ind.lastName,
      peopleType: ind.peopleType,
    });
  }

  // adds: allow-listed active PCO people not consumed by a link/restore/visitor-match/ambiguous candidate.
  const usedPco = new Set([
    ...link.map((l) => l.pcoId),
    ...restore.map((r) => r.pcoId),
    ...visitorMatches.map((v) => v.candidate.pcoId),
  ]);
  for (const a of ambiguous) for (const c of a.candidates) usedPco.add(c);
  const add = [];
  for (const p of availablePco) {
    if (usedPco.has(p.id)) continue;
    if (p.status === 'active' && isEligible(p, filterConfig)) {
      add.push({ pcoId: p.id, firstName: p.firstName, lastName: p.lastName, isChild: p.child, householdId: p.householdId, membership: p.membership });
    }
  }

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

  return {
    link,
    restore,
    ambiguous: ambiguousEnriched,
    visitorMatches,
    archiveExtras,
    unmatchedVisitors,
    add,
    update,
    archive,
    reactivate,
    gatheringEligible,
  };
}

module.exports = { computePlan };
