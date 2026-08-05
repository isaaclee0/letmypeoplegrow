'use strict';

const Database = require('../../config/database');
const { digestSourceIdentity } = require('./sourceModel');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const REASONS = new Set(['identity_decision_required', 'deferred', 'pair_rejected']);

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported people-sync provider: ${provider}`);
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} must be a positive integer`);
  return id;
}

function externalId(value, label = 'External person ID') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function visibleSource(batch) {
  const sourceRole = batch?.draftSource ? 'draft' : 'active';
  const source = batch?.draftSource || batch?.source;
  if (!source || typeof source !== 'object') throw new Error(`Batch ${batch?.id} has no visible source`);
  const sourceRevision = Number(batch?.sourceRevision);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 0 || (sourceRole === 'active' && sourceRevision === 0)) {
    throw new Error('Source revision must be valid for the visible source');
  }
  const sourceBaseRevision = sourceRole === 'draft'
    ? Number(batch?.draftSourceBaseRevision)
    : null;
  if (sourceRole === 'draft' && (!Number.isSafeInteger(sourceBaseRevision) || sourceBaseRevision < 0)) {
    throw new Error('Draft source base revision must be a non-negative integer');
  }
  return {
    sourceRole,
    sourceIdentityDigest: digestSourceIdentity(source),
    sourceRevision,
    sourceBaseRevision,
  };
}

function idsForBatch(eligibleByBatch, batchId) {
  const values = eligibleByBatch instanceof Map
    ? eligibleByBatch.get(batchId)
    : eligibleByBatch?.[batchId];
  if (!(values instanceof Set) && !Array.isArray(values)) {
    throw new Error(`Missing eligible external-person IDs for batch ${batchId}`);
  }
  return [...values].map((value) => externalId(String(value))).sort((left, right) => left.localeCompare(right, 'en'));
}

function buildPendingIdentityObservations({
  batches, eligibleByBatch, personLinks = [], holds = [], resolvedExternalPersonIds = new Set(), observedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(batches)) throw new Error('Batches must be an array');
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) throw new Error('Observed-at timestamp must be valid');
  const linked = new Set((personLinks || []).map((link) => externalId(String(link?.externalPersonId))));
  const resolved = new Set([...(resolvedExternalPersonIds || [])].map((id) => externalId(String(id))));
  const holdReason = new Map((holds || []).map((hold) => {
    const id = externalId(String(hold?.externalPersonId));
    const reason = REASONS.has(hold?.reason) ? hold.reason : 'identity_decision_required';
    return [id, reason];
  }));
  const seenBatchIds = new Set();
  return [...batches]
    .map((batch) => {
      const batchId = positiveId(batch?.id, 'Batch ID');
      if (seenBatchIds.has(batchId)) throw new Error(`Duplicate batch ID ${batchId}`);
      seenBatchIds.add(batchId);
      const source = visibleSource(batch);
      const items = idsForBatch(eligibleByBatch, batchId)
        .filter((id) => !linked.has(id) && !resolved.has(id))
        .map((externalPersonId) => ({
          externalPersonId,
          reason: holdReason.get(externalPersonId) || 'identity_decision_required',
        }));
      return { batchId, ...source, observedAt, items };
    })
    .sort((left, right) => left.batchId - right.batchId);
}

function normalizeObservations(provider, observations) {
  assertProvider(provider);
  if (!Array.isArray(observations)) throw new Error('Pending identity observations must be an array');
  const batchIds = new Set();
  return observations.map((observation) => {
    const batchId = positiveId(observation?.batchId, 'Batch ID');
    if (batchIds.has(batchId)) throw new Error(`Duplicate pending identity observation for batch ${batchId}`);
    batchIds.add(batchId);
    if (!['active', 'draft'].includes(observation?.sourceRole) ||
        typeof observation?.sourceIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/.test(observation.sourceIdentityDigest) ||
        !Number.isSafeInteger(observation?.sourceRevision) || observation.sourceRevision < 0 ||
        (observation.sourceRole === 'active' && observation.sourceRevision < 1) ||
        (observation.sourceRole === 'draft' && (!Number.isSafeInteger(observation.sourceBaseRevision) || observation.sourceBaseRevision < 0)) ||
        (observation.sourceRole === 'active' && observation.sourceBaseRevision !== null) ||
        typeof observation?.observedAt !== 'string' || Number.isNaN(Date.parse(observation.observedAt)) ||
        !Array.isArray(observation.items)) {
      throw new Error('Invalid pending identity observation');
    }
    const externalIds = new Set();
    const items = observation.items.map((item) => {
      const externalPersonId = externalId(item?.externalPersonId);
      if (externalIds.has(externalPersonId) || !REASONS.has(item?.reason)) {
        throw new Error('Invalid pending identity observation item');
      }
      externalIds.add(externalPersonId);
      return { externalPersonId, reason: item.reason };
    }).sort((left, right) => left.externalPersonId.localeCompare(right.externalPersonId, 'en'));
    return {
      batchId,
      sourceRole: observation.sourceRole,
      sourceIdentityDigest: observation.sourceIdentityDigest,
      sourceRevision: observation.sourceRevision,
      sourceBaseRevision: observation.sourceBaseRevision,
      observedAt: observation.observedAt,
      items,
    };
  }).sort((left, right) => left.batchId - right.batchId);
}

async function replacePendingIdentityObservationsWithConnection(conn, { churchId, provider, observations }) {
  if (!churchId) throw new Error('A church ID is required');
  const normalized = normalizeObservations(provider, observations);
  for (const observation of normalized) {
    const batchRows = await conn.query(
      `SELECT 1 FROM people_sync_batches WHERE id = ? AND church_id = ? AND provider = ?`,
      [observation.batchId, churchId, provider],
    );
    if (!batchRows.length) throw new Error(`Batch ${observation.batchId} is not available for this church/provider`);
  }
  for (const observation of normalized) {
    await conn.query(
      `DELETE FROM people_sync_batch_identity_projection_states
       WHERE batch_id = ? AND church_id = ? AND provider = ?`,
      [observation.batchId, churchId, provider],
    );
    await conn.query(
      `INSERT INTO people_sync_batch_identity_projection_states
       (batch_id, church_id, provider, source_role, source_identity_digest, source_revision, source_base_revision, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [observation.batchId, churchId, provider, observation.sourceRole, observation.sourceIdentityDigest,
        observation.sourceRevision, observation.sourceBaseRevision, observation.observedAt],
    );
    for (const item of observation.items) {
      await conn.query(
        `INSERT INTO people_sync_batch_identity_projection_items
         (church_id, provider, batch_id, external_person_id, reason)
         VALUES (?, ?, ?, ?, ?)`,
        [churchId, provider, observation.batchId, item.externalPersonId, item.reason],
      );
    }
  }
}

async function replacePendingIdentityObservations(churchId, provider, observations) {
  return Database.transactionForChurch(churchId, (conn) => replacePendingIdentityObservationsWithConnection(conn, {
    churchId, provider, observations,
  }));
}

async function listCurrentUnresolvedIdentityCounts(churchId, provider, batches) {
  assertProvider(provider);
  if (!Array.isArray(batches)) throw new Error('Batches must be an array');
  const counts = new Map(batches.map((batch) => [positiveId(batch?.id, 'Batch ID'), null]));
  if (counts.size === 0) return counts;
  const states = await Database.queryForChurch(churchId,
    `SELECT state.*, COUNT(item.id) AS unresolved_count
       FROM people_sync_batch_identity_projection_states state
       LEFT JOIN people_sync_batch_identity_projection_items item
         ON item.batch_id = state.batch_id AND item.church_id = state.church_id AND item.provider = state.provider
      WHERE state.church_id = ? AND state.provider = ?
      GROUP BY state.batch_id, state.church_id, state.provider`,
    [churchId, provider],
  );
  const statesByBatch = new Map(states.map((state) => [Number(state.batch_id), state]));
  for (const batch of batches) {
    const batchId = positiveId(batch?.id, 'Batch ID');
    const state = statesByBatch.get(batchId);
    if (!state) continue;
    const source = visibleSource(batch);
    if (state.source_role === source.sourceRole &&
        state.source_identity_digest === source.sourceIdentityDigest &&
        Number(state.source_revision) === source.sourceRevision &&
        (state.source_base_revision === null ? null : Number(state.source_base_revision)) === source.sourceBaseRevision) {
      counts.set(batchId, Number(state.unresolved_count));
    }
  }
  return counts;
}

module.exports = {
  buildPendingIdentityObservations,
  replacePendingIdentityObservations,
  replacePendingIdentityObservationsWithConnection,
  listCurrentUnresolvedIdentityCounts,
};
