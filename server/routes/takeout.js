const express = require('express');
const router = express.Router();
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const archiver = require('archiver');
const logger = require('../config/logger');

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
];

// Columns to redact from export (sensitive data)
const REDACT_COLUMNS = ['brevo_api_key', 'anthropic_api_key', 'openai_api_key', 'elvanto_api_key'];

function escapeCsvValue(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowsToCsv(rows) {
  if (!rows || rows.length === 0) return '';
  const columns = Object.keys(rows[0]).filter(c => !REDACT_COLUMNS.includes(c));
  const header = columns.map(escapeCsvValue).join(',');
  const lines = rows.map(row =>
    columns.map(col => escapeCsvValue(row[col])).join(',')
  );
  return header + '\n' + lines.join('\n') + '\n';
}

// GET /api/takeout/export - Download ZIP of all church data as CSVs
router.get('/export', async (req, res) => {
  const churchId = req.user.church_id;
  logger.info('Data export requested', { userId: req.user.id, churchId });

  try {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="church-data-export-${new Date().toISOString().split('T')[0]}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      logger.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create export archive' });
      }
    });
    archive.pipe(res);

    for (const table of EXPORT_TABLES) {
      try {
        const rows = await Database.queryForChurch(churchId, `SELECT * FROM ${table}`);
        if (rows.length > 0) {
          const csv = rowsToCsv(rows);
          archive.append(csv, { name: `${table}.csv` });
        }
      } catch (err) {
        // Table may not exist or be empty - skip
        logger.warn(`Export: skipped table ${table}`, { error: err.message });
      }
    }

    await archive.finalize();
    logger.info('Data export completed', { userId: req.user.id, churchId });
  } catch (error) {
    logger.error('Export error:', error);
    if (!res.headersSent) {
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
