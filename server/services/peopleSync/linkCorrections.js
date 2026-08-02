'use strict';

const OUTCOMES = new Set(['relink', 'unlink']);
const ALLOWED_FIELDS = {
  relink: new Set(['externalPersonId', 'fromIndividualId', 'outcome', 'individualId']),
  unlink: new Set(['externalPersonId', 'fromIndividualId', 'outcome']),
};

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function assertExternalPersonId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('External person ID must be a non-empty string');
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a valid positive integer ID`);
  }
  return value;
}

function canonicalCorrection(externalPersonId, rawCorrection, { hasEmbeddedExternalPersonId = false } = {}) {
  const id = assertExternalPersonId(externalPersonId);
  if (!isRecord(rawCorrection)) {
    throw new Error(`Link correction for ${id} must be an object`);
  }
  if (!OUTCOMES.has(rawCorrection.outcome)) {
    throw new Error(`Unsupported link correction outcome for ${id}: ${rawCorrection.outcome}`);
  }
  const allowed = new Set(ALLOWED_FIELDS[rawCorrection.outcome]);
  if (!hasEmbeddedExternalPersonId) allowed.delete('externalPersonId');
  if (Object.keys(rawCorrection).some((field) => !allowed.has(field))) {
    throw new Error(`Link correction for ${id} has invalid fields for outcome "${rawCorrection.outcome}"`);
  }

  const fromIndividualId = assertPositiveInteger(
    rawCorrection.fromIndividualId,
    `Current individual ID for ${id}`
  );
  if (rawCorrection.outcome === 'unlink') {
    return { externalPersonId: id, fromIndividualId, outcome: 'unlink' };
  }

  const individualId = assertPositiveInteger(rawCorrection.individualId, `Relink individual ID for ${id}`);
  if (individualId === fromIndividualId) {
    throw new Error(`Link correction for ${id} cannot relink an identity to itself`);
  }
  return { externalPersonId: id, fromIndividualId, outcome: 'relink', individualId };
}

function canonicalLinkCorrections(rawCorrections = {}) {
  let entries;
  if (Array.isArray(rawCorrections)) {
    entries = rawCorrections.map((rawCorrection) => {
      if (!isRecord(rawCorrection)) throw new Error('Link correction must be an object');
      return [rawCorrection.externalPersonId, rawCorrection];
    });
  } else if (isRecord(rawCorrections)) {
    entries = Object.entries(rawCorrections);
  } else {
    throw new Error('Link corrections must be an object or array');
  }

  const correctionsByExternalId = new Map();
  for (const [externalPersonId, rawCorrection] of entries) {
    const correction = canonicalCorrection(externalPersonId, rawCorrection, {
      hasEmbeddedExternalPersonId: Array.isArray(rawCorrections),
    });
    if (correctionsByExternalId.has(correction.externalPersonId)) {
      throw new Error(`Duplicate link correction for ${correction.externalPersonId}`);
    }
    correctionsByExternalId.set(correction.externalPersonId, correction);
  }
  return [...correctionsByExternalId.values()]
    .sort((left, right) => left.externalPersonId.localeCompare(right.externalPersonId));
}

function assertReviewedEstablishedLink(current, correction, sourceExternalIds, localIndividualIds) {
  if (!current) {
    throw new Error(`Unknown established link for external person ${correction.externalPersonId}`);
  }
  if (!sourceExternalIds.has(correction.externalPersonId)) {
    throw new Error(`External person is outside the reviewed source: ${correction.externalPersonId}`);
  }
  if (current.individualId !== correction.fromIndividualId) {
    throw new Error(`Stale established link for ${correction.externalPersonId}`);
  }
  if (correction.outcome === 'relink' && !localIndividualIds.has(correction.individualId)) {
    throw new Error(`Relink individual ID for ${correction.externalPersonId} does not exist locally`);
  }
}

function assertUniqueFinalIndividuals(links) {
  const externalByIndividualId = new Map();
  for (const link of links) {
    const existingExternalPersonId = externalByIndividualId.get(link.individualId);
    if (existingExternalPersonId) {
      throw new Error(`Individual ${link.individualId} is still linked to ${existingExternalPersonId}`);
    }
    externalByIndividualId.set(link.individualId, link.externalPersonId);
  }
}

function correctionProjection(corrections, projectedLinks) {
  const finalIndividualIds = new Set(projectedLinks.map((link) => link.individualId));
  const correctedExternalIds = new Set(corrections.map(({ externalPersonId }) => externalPersonId));
  const unlinkedExternalIds = new Set(corrections
    .filter(({ outcome }) => outcome === 'unlink')
    .map(({ externalPersonId }) => externalPersonId));
  const freedIndividualIds = new Set(corrections
    .map(({ fromIndividualId }) => fromIndividualId)
    .filter((individualId) => !finalIndividualIds.has(individualId)));

  return {
    corrections,
    projectedLinks,
    exclusionsToAdd: corrections.map(({ externalPersonId, fromIndividualId }) => ({
      externalPersonId, individualId: fromIndividualId,
    })),
    holdsToUpsert: corrections
      .filter(({ outcome }) => outcome === 'unlink')
      .map(({ externalPersonId }) => ({ externalPersonId, reason: 'pair_rejected' })),
    holdsToDelete: corrections
      .filter(({ outcome }) => outcome === 'relink')
      .map(({ externalPersonId }) => externalPersonId),
    correctedExternalIds,
    unlinkedExternalIds,
    freedIndividualIds,
  };
}

function validateAndProjectLinkCorrections({
  rawCorrections = {}, baseLinks = [], sourceExternalIds = new Set(), localIndividualIds = new Set(),
} = {}) {
  const corrections = canonicalLinkCorrections(rawCorrections);
  const byExternal = new Map(baseLinks.map((link) => [String(link.externalPersonId), link]));
  for (const correction of corrections) {
    const current = byExternal.get(correction.externalPersonId);
    assertReviewedEstablishedLink(current, correction, sourceExternalIds, localIndividualIds);
    byExternal.delete(correction.externalPersonId);
  }
  for (const correction of corrections) {
    if (correction.outcome === 'relink') {
      const baseLink = baseLinks.find((link) => String(link.externalPersonId) === correction.externalPersonId);
      byExternal.set(correction.externalPersonId, {
        ...baseLink,
        externalPersonId: correction.externalPersonId,
        individualId: correction.individualId,
        linkSource: 'manual',
      });
    }
  }
  assertUniqueFinalIndividuals(byExternal.values());
  const projectedLinks = [...byExternal.values()]
    .sort((left, right) => String(left.externalPersonId).localeCompare(String(right.externalPersonId)));
  return correctionProjection(corrections, projectedLinks);
}

module.exports = {
  canonicalLinkCorrections,
  validateAndProjectLinkCorrections,
};
