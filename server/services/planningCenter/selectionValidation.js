// candidates: array of { individualId, pcoId } proposed picks, considered in order
// (e.g. Object.entries() order from a request body — first-claimed wins).
// opts.validPcoIds: Set<string> — pcoIds that exist in the current PCO snapshot.
// opts.claimedPcoIds: Set<string> — pcoIds already spoken for (by the plan itself,
// or already linked in the DB); mutated in place as entries are accepted, so a later
// candidate in the same call can't reuse a pcoId an earlier one just claimed.
// opts.allowedIndividualIds: Set<number>|undefined — if given, only individualIds in
// this set may be resolved; omit to allow any individualId.
// Returns the accepted { individualId, pcoId } entries, in input order.
function resolveManualLinks(candidates, { validPcoIds, claimedPcoIds, allowedIndividualIds }) {
  const accepted = [];
  for (const { individualId, pcoId } of candidates) {
    if (!pcoId) continue;
    if (allowedIndividualIds && !allowedIndividualIds.has(individualId)) continue;
    if (!validPcoIds.has(pcoId)) continue;
    if (claimedPcoIds.has(pcoId)) continue;
    claimedPcoIds.add(pcoId);
    accepted.push({ individualId, pcoId });
  }
  return accepted;
}

module.exports = { resolveManualLinks };
