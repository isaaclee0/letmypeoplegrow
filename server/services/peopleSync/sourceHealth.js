'use strict';

const Database = require('../../config/database');
const { normalizeProviderSource } = require('./sourceModel');
const { recordActiveSourceHealthWithConnection } = require('./batchRepository');

const PROVIDER_LABELS = Object.freeze({ planning_center: 'Planning Center', elvanto: 'Elvanto' });
const SAFE_FAILURE_CODES = new Set([
  'SYNC_SOURCE_AUTH',
  'SYNC_SOURCE_INCOMPLETE',
  'SYNC_SOURCE_RATE_LIMIT',
]);

function invalidHealthUpdate() {
  const error = new Error('Invalid active source health update');
  error.code = 'SYNC_SOURCE_CHECK_INVALID';
  return error;
}

function normalizeSource(provider, source) {
  try {
    return normalizeProviderSource(provider, {
      kind: source?.kind,
      externalId: source?.externalId,
      name: source?.name,
    });
  } catch (_) {
    throw invalidHealthUpdate();
  }
}

function checkedTime(checkedAt) {
  if (typeof checkedAt !== 'string' || !checkedAt.trim()) throw invalidHealthUpdate();
  return checkedAt;
}

function sameIdentity(left, right) {
  return left.kind === right.kind && left.externalId === right.externalId;
}

function safeFailureCode(code) {
  if (code === 'SYNC_SOURCE_UNAVAILABLE') return code;
  return SAFE_FAILURE_CODES.has(code) ? code : 'SYNC_SOURCE_CHECK_FAILED';
}

function missingNotification(provider, sourceName, batchName) {
  const label = PROVIDER_LABELS[provider];
  if (!label) throw invalidHealthUpdate();
  return {
    title: `${label} sync source missing`,
    message: `The source “${sourceName}” for batch “${batchName}” is no longer available. Select a replacement in Settings → Integrations.`,
  };
}

async function query(conn, sql, params) {
  if (typeof conn.query === 'function') return conn.query(sql, params);
  return conn.prepare(sql).all(...params);
}

async function write(conn, sql, params) {
  if (typeof conn.query === 'function') return conn.query(sql, params);
  return conn.prepare(sql).run(...params);
}

async function recordActiveSourceAvailable({ churchId, provider, batchId, expectedSource, observedSource, checkedAt }) {
  const expected = normalizeSource(provider, expectedSource);
  const observed = normalizeSource(provider, observedSource);
  if (!sameIdentity(expected, observed)) throw invalidHealthUpdate();
  const time = checkedTime(checkedAt);

  return Database.transactionForChurch(churchId, async (conn) => {
    const result = await recordActiveSourceHealthWithConnection(conn, {
      churchId, provider, batchId, expectedSource: expected, sourceName: observed.name,
      sourceStatus: 'available', checkedAt: time, errorCode: null,
    });
    return { updated: result.updated, notified: false, adminCount: 0 };
  });
}

async function recordActiveSourceFailure({ churchId, provider, batchId, expectedSource, code, checkedAt }) {
  const expected = normalizeSource(provider, expectedSource);
  const time = checkedTime(checkedAt);
  const errorCode = safeFailureCode(code);
  const sourceStatus = errorCode === 'SYNC_SOURCE_UNAVAILABLE' ? 'missing' : 'error';

  return Database.transactionForChurch(churchId, async (conn) => {
    const result = await recordActiveSourceHealthWithConnection(conn, {
      churchId, provider, batchId, expectedSource: expected, sourceName: null,
      sourceStatus, checkedAt: time, errorCode,
    });
    if (!result.updated || sourceStatus !== 'missing' || result.priorSourceStatus === 'missing') {
      return { updated: result.updated, notified: false, adminCount: 0 };
    }

    const admins = await query(conn,
      `SELECT id FROM users WHERE church_id = ? AND role = 'admin' AND is_active = 1`, [churchId]);
    const notice = missingNotification(provider, result.sourceName, result.batchName);
    for (const admin of admins) {
      await write(conn, `INSERT INTO notifications (user_id, title, message, notification_type, church_id)
        VALUES (?, ?, ?, 'system', ?)`, [admin.id, notice.title, notice.message, churchId]);
    }
    return { updated: true, notified: true, adminCount: admins.length };
  });
}

module.exports = {
  recordActiveSourceAvailable,
  recordActiveSourceFailure,
};
