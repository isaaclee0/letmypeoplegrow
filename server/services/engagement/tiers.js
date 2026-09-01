'use strict';

const { DEFAULT_ENGAGEMENT_SETTINGS } = require('./settings');

const MINIMUM_CLASSIFIED_OPPORTUNITIES = 8;
const TIER_RANK = Object.freeze({ irregular: 0, casual: 1, core: 2 });
const CLASSIFIED_TIERS = new Set(Object.keys(TIER_RANK));

function isClassifiedTier(tier) {
  return CLASSIFIED_TIERS.has(tier);
}

function classifyEvidence({ assigned, attended, opportunities }, settings = DEFAULT_ENGAGEMENT_SETTINGS) {
  if (!assigned) {
    return { status: 'not_assigned', attended: 0, opportunities: 0, rate: null };
  }

  const attendedCount = attended || 0;
  const opportunityCount = opportunities || 0;
  const rate = opportunityCount === 0 ? null : attendedCount / opportunityCount;
  if (opportunityCount < MINIMUM_CLASSIFIED_OPPORTUNITIES) {
    return { status: 'establishing', attended: attendedCount, opportunities: opportunityCount, rate };
  }

  const coreMinimum = (settings.coreMinimum ?? DEFAULT_ENGAGEMENT_SETTINGS.coreMinimum) / 100;
  const casualMinimum = (settings.casualMinimum ?? DEFAULT_ENGAGEMENT_SETTINGS.casualMinimum) / 100;
  const status = rate >= coreMinimum ? 'core' : rate >= casualMinimum ? 'casual' : 'irregular';
  return { status, attended: attendedCount, opportunities: opportunityCount, rate };
}

function tierDirection(fromTier, toTier) {
  if (!isClassifiedTier(fromTier) || !isClassifiedTier(toTier)) return null;
  if (TIER_RANK[toTier] > TIER_RANK[fromTier]) return 'higher';
  if (TIER_RANK[toTier] < TIER_RANK[fromTier]) return 'lower';
  return null;
}

function evidenceSupportsCandidate({ establishedTier, candidateTier, evidenceTier }) {
  if (!isClassifiedTier(evidenceTier)) return false;
  const direction = tierDirection(establishedTier, candidateTier);
  if (direction === 'higher') return TIER_RANK[evidenceTier] >= TIER_RANK[candidateTier];
  if (direction === 'lower') return TIER_RANK[evidenceTier] <= TIER_RANK[candidateTier];
  return false;
}

module.exports = {
  MINIMUM_CLASSIFIED_OPPORTUNITIES,
  TIER_RANK,
  isClassifiedTier,
  classifyEvidence,
  tierDirection,
  evidenceSupportsCandidate,
};
