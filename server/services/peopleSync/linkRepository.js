const Database = require('../../config/database');

const PROVIDERS = new Set(['planning_center', 'elvanto']);
const LINK_SOURCES = new Set(['matched', 'created', 'manual', 'legacy_backfill']);

function assertProvider(provider) {
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported people-sync provider: ${provider}`);
}

function assertLinkInput(input, kind) {
  const externalIdKey = kind === 'person' ? 'externalPersonId' : 'externalFamilyId';
  const localIdKey = kind === 'person' ? 'individualId' : 'familyId';
  if (!input || !input.churchId || !input[externalIdKey] || !Number.isInteger(input[localIdKey])) {
    throw new Error(`Invalid ${kind} link input`);
  }
  assertProvider(input.provider);
  if (!LINK_SOURCES.has(input.linkSource)) throw new Error(`Unsupported link source: ${input.linkSource}`);
}

function toPersonLink(row) {
  return {
    id: row.id,
    churchId: row.church_id,
    provider: row.provider,
    externalPersonId: row.external_person_id,
    individualId: row.individual_id,
    linkSource: row.link_source,
    linkedAt: row.linked_at,
    lastSeenAt: row.last_seen_at,
    missingFullSyncCount: Number(row.missing_full_sync_count),
    reviewDeclined: Boolean(row.review_declined),
  };
}

function toFamilyLink(row) {
  return {
    id: row.id,
    churchId: row.church_id,
    provider: row.provider,
    externalFamilyId: row.external_family_id,
    familyId: row.family_id,
    linkSource: row.link_source,
    linkedAt: row.linked_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function listPersonLinks(churchId, provider) {
  assertProvider(provider);
  const rows = await Database.queryForChurch(churchId, `SELECT id, church_id, provider,
      external_person_id, individual_id, link_source, linked_at, last_seen_at,
      missing_full_sync_count, review_declined
    FROM external_person_links
    WHERE church_id = ? AND provider = ? ORDER BY id`, [churchId, provider]);
  return rows.map(toPersonLink);
}

async function listFamilyLinks(churchId, provider) {
  assertProvider(provider);
  const rows = await Database.queryForChurch(churchId, `SELECT id, church_id, provider,
      external_family_id, family_id, link_source, linked_at, last_seen_at
    FROM external_family_links
    WHERE church_id = ? AND provider = ? ORDER BY id`, [churchId, provider]);
  return rows.map(toFamilyLink);
}

async function assertLocalRecord(conn, table, id, churchId) {
  const rows = await conn.query(`SELECT id FROM ${table} WHERE id = ? AND church_id = ?`, [id, churchId]);
  if (!rows[0]) throw new Error(`Cannot link a ${table} record outside this church`);
}

async function upsertPersonLinkWithConnection(conn, input) {
  assertLinkInput(input, 'person');
  const { churchId, provider, externalPersonId, individualId, linkSource } = input;
  await assertLocalRecord(conn, 'individuals', individualId, churchId);
  const byExternal = await conn.query(`SELECT id, individual_id FROM external_person_links
    WHERE church_id = ? AND provider = ? AND external_person_id = ?`, [churchId, provider, externalPersonId]);
  const byIndividual = await conn.query(`SELECT id, external_person_id FROM external_person_links
    WHERE church_id = ? AND provider = ? AND individual_id = ?`, [churchId, provider, individualId]);
  if ((byExternal[0] && byExternal[0].individual_id !== individualId) ||
      (byIndividual[0] && byIndividual[0].external_person_id !== externalPersonId)) {
    throw new Error('Person link collision for this church and provider');
  }
  if (byExternal[0]) {
    await conn.query(`UPDATE external_person_links SET link_source = ?, last_seen_at = datetime('now'),
        missing_full_sync_count = 0, updated_at = datetime('now')
      WHERE id = ? AND church_id = ? AND provider = ? AND external_person_id = ? AND individual_id = ?`,
    [linkSource, byExternal[0].id, churchId, provider, externalPersonId, individualId]);
    return (await conn.query(`SELECT id, church_id, provider, external_person_id, individual_id, link_source,
        linked_at, last_seen_at, missing_full_sync_count, review_declined FROM external_person_links
      WHERE id = ? AND church_id = ? AND provider = ?`, [byExternal[0].id, churchId, provider]))[0];
  }
  const result = await conn.query(`INSERT INTO external_person_links
    (church_id, provider, external_person_id, individual_id, link_source, last_seen_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`, [churchId, provider, externalPersonId, individualId, linkSource]);
  return (await conn.query(`SELECT id, church_id, provider, external_person_id, individual_id, link_source,
      linked_at, last_seen_at, missing_full_sync_count, review_declined FROM external_person_links
    WHERE id = ? AND church_id = ? AND provider = ?`, [result.insertId, churchId, provider]))[0];
}

async function upsertFamilyLinkWithConnection(conn, input) {
  assertLinkInput(input, 'family');
  const { churchId, provider, externalFamilyId, familyId, linkSource } = input;
  await assertLocalRecord(conn, 'families', familyId, churchId);
  const byExternal = await conn.query(`SELECT id, family_id FROM external_family_links
    WHERE church_id = ? AND provider = ? AND external_family_id = ?`, [churchId, provider, externalFamilyId]);
  const byFamily = await conn.query(`SELECT id, external_family_id FROM external_family_links
    WHERE church_id = ? AND provider = ? AND family_id = ?`, [churchId, provider, familyId]);
  if ((byExternal[0] && byExternal[0].family_id !== familyId) ||
      (byFamily[0] && byFamily[0].external_family_id !== externalFamilyId)) {
    throw new Error('Family link collision for this church and provider');
  }
  if (byExternal[0]) {
    await conn.query(`UPDATE external_family_links SET link_source = ?, last_seen_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND church_id = ? AND provider = ? AND external_family_id = ? AND family_id = ?`,
    [linkSource, byExternal[0].id, churchId, provider, externalFamilyId, familyId]);
    return (await conn.query(`SELECT id, church_id, provider, external_family_id, family_id, link_source, linked_at, last_seen_at
      FROM external_family_links WHERE id = ? AND church_id = ? AND provider = ?`, [byExternal[0].id, churchId, provider]))[0];
  }
  const result = await conn.query(`INSERT INTO external_family_links
    (church_id, provider, external_family_id, family_id, link_source, last_seen_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`, [churchId, provider, externalFamilyId, familyId, linkSource]);
  return (await conn.query(`SELECT id, church_id, provider, external_family_id, family_id, link_source, linked_at, last_seen_at
    FROM external_family_links WHERE id = ? AND church_id = ? AND provider = ?`, [result.insertId, churchId, provider]))[0];
}

// Resolves an external provider's household/family id to the local family it
// is already linked to, scoped to this church and provider. Returns null
// when no such link exists yet — callers (e.g. apply.js when creating a new
// person whose external record carries a household id nobody has linked to
// a local family yet) must treat that as "no family", never as an error and
// never as license to invent one.
async function findFamilyIdByExternalId(conn, churchId, provider, externalFamilyId) {
  assertProvider(provider);
  if (!churchId || !externalFamilyId) return null;
  const rows = await conn.query(
    `SELECT family_id FROM external_family_links
      WHERE church_id = ? AND provider = ? AND external_family_id = ?`,
    [churchId, provider, String(externalFamilyId)]
  );
  return rows[0] ? rows[0].family_id : null;
}

async function upsertPersonLink(input) {
  return Database.transaction(async (conn) => toPersonLink(await upsertPersonLinkWithConnection(conn, input)));
}

async function upsertFamilyLink(input) {
  return Database.transaction(async (conn) => toFamilyLink(await upsertFamilyLinkWithConnection(conn, input)));
}

async function markPeopleSeen(churchId, provider, seenExternalIds) {
  assertProvider(provider);
  if (!(seenExternalIds instanceof Set)) throw new Error('Seen external IDs must be a Set');
  return Database.transaction(async (conn) => {
    for (const externalPersonId of seenExternalIds) {
      await conn.query(`UPDATE external_person_links SET missing_full_sync_count = 0,
          last_seen_at = datetime('now'), updated_at = datetime('now')
        WHERE church_id = ? AND provider = ? AND external_person_id = ?`, [churchId, provider, externalPersonId]);
    }
  });
}

async function recordFullFetchPresence(churchId, provider, seenExternalIds, {
  complete, ignoredExternalIds = new Set(), authorityExpectation = null, sourceExpectations = null,
} = {}) {
  assertProvider(provider);
  if (complete !== true) throw new Error('Refusing missing-person accounting for an incomplete full fetch');
  if (!(seenExternalIds instanceof Set)) throw new Error('Seen external IDs must be a Set');
  if (!(ignoredExternalIds instanceof Set)) throw new Error('Ignored external IDs must be a Set');
  return Database.transaction(async (conn) => {
    if (authorityExpectation) {
      const authority = require('./authority');
      await authority.assertAuthorityExpectationWithConnection(conn, churchId, authorityExpectation);
    }
    if (sourceExpectations) {
      const batchRepository = require('./batchRepository');
      await batchRepository.assertSourceExpectationsWithConnection(conn, {
        churchId, provider, expectations: sourceExpectations,
      });
    }
    const links = await conn.query(`SELECT id, external_person_id, individual_id, missing_full_sync_count
      FROM external_person_links WHERE church_id = ? AND provider = ?`, [churchId, provider]);
    const missingCandidates = [];
    for (const link of links) {
      // Lifecycle-ineligible source records are neither seen nor missing;
      // preserve an existing link without advancing its archive counter.
      if (ignoredExternalIds.has(link.external_person_id)) continue;
      const seen = seenExternalIds.has(link.external_person_id);
      const missingFullSyncCount = seen ? 0 : Number(link.missing_full_sync_count) + 1;
      await conn.query(`UPDATE external_person_links SET missing_full_sync_count = ?,
          last_seen_at = CASE WHEN ? THEN datetime('now') ELSE last_seen_at END,
          updated_at = datetime('now')
        WHERE id = ? AND church_id = ? AND provider = ?`,
      [missingFullSyncCount, seen ? 1 : 0, link.id, churchId, provider]);
      if (!seen) missingCandidates.push({
        id: link.id, externalPersonId: link.external_person_id, individualId: link.individual_id, missingFullSyncCount,
      });
    }
    return { missingCandidates };
  });
}

module.exports = {
  listPersonLinks,
  listFamilyLinks,
  upsertPersonLink,
  upsertPersonLinkWithConnection,
  upsertFamilyLink,
  upsertFamilyLinkWithConnection,
  markPeopleSeen,
  recordFullFetchPresence,
  findFamilyIdByExternalId,
  // Exported so apply.js (Task 7) can defend against a plan/selection
  // referencing a family or individual ID that belongs to a different
  // church — the same church-ownership check this module already relies
  // on internally before ever writing a link row.
  assertLocalRecord,
};
