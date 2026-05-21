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

module.exports = { tallyMembership };
