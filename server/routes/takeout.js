const express = require('express');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const router = express.Router();
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const logger = require('../config/logger');
const { getChurchDate, loadChurchTimeZone } = require('../utils/churchTime');

router.use(verifyToken);
router.use(requireRole('admin'));

const EXPORT_TABLES = [
  'church_settings',
  'users',
  'gathering_types',
  'user_gathering_assignments',
  'families',
  'individuals',
  'gathering_lists',
  'attendance_sessions',
  'attendance_records',
  'headcount_records',
  'kiosk_checkins',
  'notification_rules',
  'notifications',
  'visitor_config',
  'audit_log',
  'ai_chat_conversations',
  'ai_chat_messages',
  'user_preferences',
  'integration_connections',
];

// Columns to redact from export (sensitive data)
const REDACT_COLUMNS = [
  'brevo_api_key',
  'anthropic_api_key',
  'openai_api_key',
  'elvanto_api_key',
  'planning_center_tokens',
  'credential_ciphertext',
  'credential_nonce',
  'credential_auth_tag',
  'credential_key_version',
];
const REDACT_PREFERENCE_KEYS = new Set(['elvanto_api_key', 'planning_center_tokens']);
// Any other elvanto-prefixed preference row (e.g. a stale legacy
// `elvanto_integration` OAuth remnant) redacts the same way, matching the
// Elvanto disconnect route's own `LIKE 'elvanto%'` cleanup breadth (see
// routes/integrations/elvanto.js's defaultDeleteLegacyPreferences) — a row
// that survives disconnect for any church must never leave in cleartext
// via this export.
function isRedactedPreferenceKey(key) {
  // Case-insensitive prefix match, matching the underlying SQL `LIKE
  // 'elvanto%'` cleanup's own case-insensitivity (SQLite's LIKE is
  // case-insensitive for ASCII by default) — an oddly-cased row (e.g.
  // `Elvanto_Integration`) must redact here exactly as it would be deleted
  // on disconnect, not slip through a case-sensitive check first.
  return REDACT_PREFERENCE_KEYS.has(key) || (typeof key === 'string' && key.toLowerCase().startsWith('elvanto'));
}

function escapeCsvValue(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowsToCsv(rows, redactColumns = REDACT_COLUMNS) {
  if (!rows || rows.length === 0) return '';
  const safeRows = rows.filter(row => !isRedactedPreferenceKey(row.preference_key));
  if (safeRows.length === 0) return '';
  const columns = Object.keys(safeRows[0]).filter(c => !redactColumns.includes(c));
  const header = columns.map(escapeCsvValue).join(',');
  const lines = safeRows.map(row =>
    columns.map(col => escapeCsvValue(row[col])).join(',')
  );
  return header + '\n' + lines.join('\n') + '\n';
}

function exportFilename(timeZone, now = new Date()) {
  return `church-data-export-${getChurchDate(now, timeZone)}.zip`;
}

async function streamChurchExport(churchId, destination, { includeEmptyCsv = true } = {}) {
  const { default: ZipStream } = await import('zip-stream');
  const archive = new ZipStream({ zlib: { level: 6 } });
  const addEntry = promisify(archive.entry.bind(archive));

  async function writeTables() {
    for (const table of EXPORT_TABLES) {
      if (archive.destroyed) return;
      let csv;
      try {
        const rows = await Database.queryForChurch(churchId, `SELECT * FROM ${table}`);
        if (!rows.length) continue;
        csv = rowsToCsv(rows);
      } catch (err) {
        logger.warn(`Export: skipped table ${table}`, { error: err.message });
        continue;
      }
      if (csv || includeEmptyCsv) await addEntry(csv, { name: `${table}.csv` });
    }
    archive.finalize();
  }

  try {
    await Promise.all([pipeline(archive, destination), writeTables()]);
  } finally {
    archive.destroy();
  }
}

// GET /api/takeout/export - Download ZIP of all church data as CSVs
router.get('/export', async (req, res) => {
  const churchId = req.user.church_id;
  logger.info('Data export requested', { userId: req.user.id, churchId });

  try {
    const timeZone = await loadChurchTimeZone(churchId);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(timeZone)}"`);

    await streamChurchExport(churchId, res);
    logger.info('Data export completed', { userId: req.user.id, churchId });
  } catch (error) {
    logger.error('Export error:', error);
    if (!res.headersSent && !res.destroyed) {
      res.status(500).json({ error: 'Failed to export data' });
    }
  }
});

// POST /api/takeout/delete - Delete church account
router.post('/delete', async (req, res) => {
  const churchId = req.user.church_id;
  const { confirmChurchName } = req.body;

  if (!confirmChurchName || !confirmChurchName.trim()) {
    return res.status(400).json({ error: 'Church name confirmation is required' });
  }

  try {
    // Get actual church name
    const settings = await Database.queryForChurch(churchId,
      'SELECT church_name FROM church_settings WHERE church_id = ? LIMIT 1',
      [churchId]
    );
    const actualName = settings[0]?.church_name || '';

    if (confirmChurchName.trim() !== actualName.trim()) {
      return res.status(400).json({ error: 'Church name does not match. Please type the exact church name to confirm deletion.' });
    }

    logger.info('Church deletion requested', { userId: req.user.id, churchId, churchName: actualName });

    // Remove all user lookups from registry
    await Database.registryQuery(
      'DELETE FROM user_lookup WHERE church_id = ?',
      [churchId]
    );

    // Remove church from registry
    await Database.registryQuery(
      'DELETE FROM churches WHERE church_id = ?',
      [churchId]
    );

    // Close and delete the church database
    Database.closeChurchDb(churchId);

    const fs = require('fs');
    const path = require('path');
    const dataDir = process.env.CHURCH_DATA_DIR || process.env.DATA_DIR ||
      path.join(__dirname, '..', 'data');
    const dbPath = path.join(dataDir, 'churches', `${churchId}.sqlite`);

    for (const suffix of ['', '-wal', '-shm']) {
      const file = dbPath + suffix;
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        logger.info(`Deleted: ${file}`);
      }
    }

    // Clear auth cookie
    res.clearCookie('authToken', { httpOnly: true, path: '/' });
    res.clearCookie('token', { httpOnly: true, path: '/' });

    logger.info('Church account deleted', { churchId, churchName: actualName });
    res.json({ success: true, message: 'Church account and all data have been permanently deleted.' });
  } catch (error) {
    logger.error('Delete church error:', error);
    res.status(500).json({ error: 'Failed to delete church account' });
  }
});

module.exports = router;
module.exports.streamChurchExport = streamChurchExport;
module.exports.rowsToCsv = rowsToCsv;
module.exports.exportFilename = exportFilename;
