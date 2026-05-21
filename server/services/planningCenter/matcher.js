// Pure matching of UNLINKED LMPG individuals to PCO people using only
// name + family/household context + child flag (LMPG stores nothing else).

function normalizeName(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, '')        // strip punctuation + combining accents
    .replace(/\s+/g, ' ')
    .trim();
}

function nameKey(first, last) {
  return normalizeName(first) + '|' + normalizeName(last);
}

function buildNameIndex(people) {
  const idx = new Map();
  for (const p of people) {
    const k = nameKey(p.firstName, p.lastName);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(p);
  }
  return idx;
}

// unlinked: [{id, firstName, lastName, isChild, familyId}]
// availablePco: projected people not already linked
// familyMembers: Map<familyId, [{firstName,lastName}]>
// returns { links:[{individualId,pcoId}], ambiguous:[{individualId,candidates:[pcoId]}], unmatched:[individualId] }
function matchIndividuals(unlinked, availablePco, familyMembers) {
  const nameIndex = buildNameIndex(availablePco);
  const householdMembers = new Map();
  for (const p of availablePco) {
    if (!p.householdId) continue;
    if (!householdMembers.has(p.householdId)) householdMembers.set(p.householdId, []);
    householdMembers.get(p.householdId).push(p);
  }

  const used = new Set();
  const links = [];
  const ambiguous = [];
  const unmatched = [];

  const ordered = [...unlinked].sort((a, b) => a.id - b.id);
  for (const ind of ordered) {
    const k = nameKey(ind.firstName, ind.lastName);
    const candidates = (nameIndex.get(k) || []).filter((p) => !used.has(p.id));

    if (candidates.length === 0) { unmatched.push(ind.id); continue; }
    if (candidates.length === 1) { links.push({ individualId: ind.id, pcoId: candidates[0].id }); used.add(candidates[0].id); continue; }

    // child-flag narrowing
    const byChild = candidates.filter((p) => p.child === !!ind.isChild);
    if (byChild.length === 1) { links.push({ individualId: ind.id, pcoId: byChild[0].id }); used.add(byChild[0].id); continue; }
    const pool = byChild.length ? byChild : candidates;

    // family corroboration: score each candidate by household-member name overlap
    const famKeys = new Set(
      (familyMembers.get(ind.familyId) || [])
        .map((m) => nameKey(m.firstName, m.lastName))
        .filter((kk) => kk !== k)
    );
    let best = null, bestScore = 0, tie = false;
    for (const c of pool) {
      const hm = householdMembers.get(c.householdId) || [];
      let score = 0;
      for (const m of hm) { if (famKeys.has(nameKey(m.firstName, m.lastName))) score++; }
      if (score > bestScore) { bestScore = score; best = c; tie = false; }
      else if (score === bestScore && score > 0) { tie = true; }
    }
    if (best && bestScore > 0 && !tie) { links.push({ individualId: ind.id, pcoId: best.id }); used.add(best.id); continue; }

    ambiguous.push({ individualId: ind.id, candidates: pool.map((p) => p.id) });
  }

  return { links, ambiguous, unmatched };
}

module.exports = { normalizeName, nameKey, buildNameIndex, matchIndividuals };
