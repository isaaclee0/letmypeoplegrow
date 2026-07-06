const { normalizeName } = require('./matcher');

// pcoPeople: full cached projected list (from getCachedPcoPeople).
// query: raw search text typed by the reviewer.
// alreadyLinkedPcoIds: Set<string> of PCO ids already linked to some individual in
// this church — these are excluded so a reviewer can't pick someone already claimed.
// Returns up to `limit` matches, in the order encountered in pcoPeople.
function searchPcoPeople(pcoPeople, query, alreadyLinkedPcoIds, limit = 20) {
  const q = normalizeName(query);
  if (!q) return [];
  const results = [];
  for (const p of pcoPeople) {
    if (alreadyLinkedPcoIds.has(p.id)) continue;
    const full = normalizeName(`${p.firstName} ${p.lastName}`);
    if (!full.includes(q)) continue;
    results.push({ pcoId: p.id, firstName: p.firstName, lastName: p.lastName, householdId: p.householdId, status: p.status });
    if (results.length >= limit) break;
  }
  return results;
}

module.exports = { searchPcoPeople };
