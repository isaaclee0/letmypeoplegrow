const Database = require('../../config/database');

const PEOPLE_SOURCE_LOCKED = 'PEOPLE_SOURCE_LOCKED';
const AUTHORITY_PROVIDERS = new Set(['planning_center', 'elvanto']);
const PROVIDER_LABELS = { planning_center: 'Planning Center', elvanto: 'Elvanto' };

function assertAuthorityProvider(provider) {
  if (!AUTHORITY_PROVIDERS.has(provider)) {
    throw new Error(`Unsupported people authority provider: ${provider}`);
  }
}

function assertAuthorityPreviewId(authorityPreviewId) {
  if (typeof authorityPreviewId !== 'string' || authorityPreviewId.length === 0 || authorityPreviewId.length > 200) {
    throw new Error('A valid authority preview ID is required');
  }
}

async function getAuthority(churchId) {
  const rows = await Database.queryForChurch(
    churchId,
    `SELECT authority_provider, pending_authority_provider
       FROM people_sync_settings
      WHERE church_id = ?
      LIMIT 1`,
    [churchId]
  );
  return {
    active: rows[0]?.authority_provider || 'none',
    pending: rows[0]?.pending_authority_provider || null,
  };
}

async function beginAuthoritySwitch(churchId, provider, authorityPreviewId = null) {
  assertAuthorityProvider(provider);
  if (authorityPreviewId !== null) assertAuthorityPreviewId(authorityPreviewId);
  return Database.transactionForChurch(churchId, async (conn) => {
    await conn.query(
      `INSERT INTO people_sync_settings (church_id, authority_provider, pending_authority_provider)
       VALUES (?, 'none', ?)
       ON CONFLICT(church_id) DO UPDATE SET
         pending_authority_provider = CASE
           WHEN people_sync_settings.authority_provider = excluded.pending_authority_provider THEN NULL
           ELSE excluded.pending_authority_provider
         END,
         updated_at = datetime('now')`,
      [churchId, provider]
    );
    const [row] = await conn.query(
      `SELECT authority_provider, pending_authority_provider
         FROM people_sync_settings WHERE church_id = ? LIMIT 1`,
      [churchId]
    );
    if (row?.pending_authority_provider && authorityPreviewId !== null) {
      await conn.query(
        `INSERT INTO people_sync_authority_preview_intents
           (church_id, provider, authority_preview_id)
         VALUES (?, ?, ?)
         ON CONFLICT(church_id) DO UPDATE SET
           provider = excluded.provider,
           authority_preview_id = excluded.authority_preview_id,
           updated_at = datetime('now')`,
        [churchId, provider, authorityPreviewId]
      );
    } else {
      await conn.query(
        'DELETE FROM people_sync_authority_preview_intents WHERE church_id = ?',
        [churchId]
      );
    }
    return {
      active: row?.authority_provider || 'none',
      pending: row?.pending_authority_provider || null,
    };
  });
}

async function getAuthorityPreviewIntent(churchId) {
  const [row] = await Database.queryForChurch(
    churchId,
    `SELECT provider, authority_preview_id
       FROM people_sync_authority_preview_intents
      WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  return row ? { provider: row.provider, authorityPreviewId: row.authority_preview_id } : null;
}

async function cancelAuthoritySwitch(churchId, provider, authorityPreviewId) {
  assertAuthorityProvider(provider);
  assertAuthorityPreviewId(authorityPreviewId);
  return Database.transactionForChurch(churchId, async (conn) => {
    const [intent] = await conn.query(
      `SELECT provider, authority_preview_id
         FROM people_sync_authority_preview_intents
        WHERE church_id = ? LIMIT 1`,
      [churchId]
    );
    if (intent?.provider === provider && intent?.authority_preview_id === authorityPreviewId) {
      await conn.query(
        `UPDATE people_sync_settings
            SET pending_authority_provider = NULL, updated_at = datetime('now')
          WHERE church_id = ? AND pending_authority_provider = ?`,
        [churchId, provider]
      );
      await conn.query(
        `DELETE FROM people_sync_authority_preview_intents
          WHERE church_id = ? AND provider = ? AND authority_preview_id = ?`,
        [churchId, provider, authorityPreviewId]
      );
    }
    const [row] = await conn.query(
      `SELECT authority_provider, pending_authority_provider
         FROM people_sync_settings WHERE church_id = ? LIMIT 1`,
      [churchId]
    );
    return {
      active: row?.authority_provider || 'none',
      pending: row?.pending_authority_provider || null,
    };
  });
}

async function commitAuthoritySwitchWithConnection(conn, churchId, provider, authorityPreviewId = null) {
  assertAuthorityProvider(provider);
  if (authorityPreviewId !== null) assertAuthorityPreviewId(authorityPreviewId);
  const rows = await conn.query(
    `SELECT pending_authority_provider
       FROM people_sync_settings
      WHERE church_id = ?
      LIMIT 1`,
    [churchId]
  );
  if (rows[0]?.pending_authority_provider !== provider) {
    throw new Error(`No pending authority switch for provider: ${provider}`);
  }
  if (authorityPreviewId !== null) {
    const [intent] = await conn.query(
      `SELECT provider, authority_preview_id
         FROM people_sync_authority_preview_intents
        WHERE church_id = ? LIMIT 1`,
      [churchId]
    );
    if (intent?.provider !== provider || intent?.authority_preview_id !== authorityPreviewId) {
      throw new Error(`Authority preview changed before commit: ${provider}`);
    }
  }
  const result = await conn.query(
    `UPDATE people_sync_settings
        SET authority_provider = ?, pending_authority_provider = NULL,
            updated_at = datetime('now')
      WHERE church_id = ? AND pending_authority_provider = ?`,
    [provider, churchId, provider]
  );
  if (result.affectedRows !== 1) {
    throw new Error(`Pending authority switch changed before commit: ${provider}`);
  }
  await conn.query(
    'DELETE FROM people_sync_authority_preview_intents WHERE church_id = ?',
    [churchId]
  );
  return { active: provider, pending: null };
}

async function commitAuthoritySwitch(churchId, provider) {
  return Database.transactionForChurch(churchId, (conn) =>
    commitAuthoritySwitchWithConnection(conn, churchId, provider)
  );
}

async function disableAuthority(churchId) {
  return Database.transactionForChurch(churchId, async (conn) => {
    await conn.query(
      `INSERT INTO people_sync_settings (church_id, authority_provider, pending_authority_provider)
       VALUES (?, 'none', NULL)
       ON CONFLICT(church_id) DO UPDATE SET
         authority_provider = 'none',
         pending_authority_provider = NULL,
         updated_at = datetime('now')`,
      [churchId]
    );
    await conn.query(
      'DELETE FROM people_sync_authority_preview_intents WHERE church_id = ?',
      [churchId]
    );
    return { active: 'none', pending: null };
  });
}

async function getManagedLinks(churchId, individualIds) {
  const ids = [...new Set((individualIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => '?').join(',');
  const [linkRows, legacyRows] = await Promise.all([
    Database.queryForChurch(
      churchId,
      `SELECT individual_id, provider
         FROM external_person_links
        WHERE church_id = ? AND individual_id IN (${placeholders})`,
      [churchId, ...ids]
    ),
    Database.queryForChurch(
      churchId,
      `SELECT id
         FROM individuals
        WHERE church_id = ? AND id IN (${placeholders})
          AND planning_center_id IS NOT NULL AND planning_center_id <> ''`,
      [churchId, ...ids]
    ),
  ]);

  const managed = new Map();
  const add = (individualId, provider) => {
    const id = Number(individualId);
    if (!managed.has(id)) managed.set(id, new Set());
    managed.get(id).add(provider);
  };
  for (const row of linkRows) add(row.individual_id, row.provider);
  for (const row of legacyRows) add(row.id, 'planning_center');
  return managed;
}

async function getManagedFamilyIds(churchId, familyIds, authority) {
  const ids = [...new Set((familyIds || []).map(Number).filter(Number.isInteger))];
  if (authority === 'none' || ids.length === 0) return new Set();
  assertAuthorityProvider(authority);

  const placeholders = ids.map(() => '?').join(',');
  const [directRows, members] = await Promise.all([
    Database.queryForChurch(
      churchId,
      `SELECT f.id
         FROM families f
         LEFT JOIN external_family_links efl
           ON efl.family_id = f.id AND efl.church_id = f.church_id AND efl.provider = ?
        WHERE f.church_id = ? AND f.id IN (${placeholders})
          AND (efl.id IS NOT NULL OR (? = 'planning_center'
            AND f.planning_center_id IS NOT NULL AND f.planning_center_id <> ''))`,
      [authority, churchId, ...ids, authority]
    ),
    Database.queryForChurch(
      churchId,
      `SELECT id, family_id FROM individuals
        WHERE church_id = ? AND family_id IN (${placeholders})`,
      [churchId, ...ids]
    ),
  ]);

  const managedFamilyIds = new Set(directRows.map((row) => Number(row.id)));
  const memberLinks = await getManagedLinks(churchId, members.map((member) => Number(member.id)));
  for (const member of members) {
    if (isPersonLocked(authority, memberLinks.get(Number(member.id)))) {
      managedFamilyIds.add(Number(member.family_id));
    }
  }
  return managedFamilyIds;
}

function isPersonLocked(authority, links) {
  return authority !== 'none' && links instanceof Set && links.has(authority);
}

function lockedResponse(provider, action = 'change this person') {
  const label = PROVIDER_LABELS[provider] || 'the configured people source';
  return {
    error: `This person is managed by ${label}. Make the change in ${label} and sync again.`,
    code: PEOPLE_SOURCE_LOCKED,
    provider,
    action,
  };
}

module.exports = {
  PEOPLE_SOURCE_LOCKED,
  getAuthority,
  beginAuthoritySwitch,
  getAuthorityPreviewIntent,
  cancelAuthoritySwitch,
  commitAuthoritySwitchWithConnection,
  commitAuthoritySwitch,
  disableAuthority,
  getManagedLinks,
  getManagedFamilyIds,
  isPersonLocked,
  lockedResponse,
};
