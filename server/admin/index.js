/**
 * Internal Admin Panel Server
 * 
 * This server runs on a separate port (7777) and is intended for
 * localhost-only access. No authentication is required since it
 * binds only to 127.0.0.1.
 * 
 * Usage: node server/admin/index.js
 * Access: http://localhost:7777
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

// Import database and backup service
const Database = require('../config/database');
const BackupService = require('../services/backup');

const app = express();
const ADMIN_PORT = process.env.ADMIN_PORT || 7777;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API Routes
// ============================================

// Initialize database on startup
Database.initialize();
Database.migrateRegistry();

// Initialize backup service from env vars
if (BackupService.loadConfigFromEnv()) {
  BackupService.startSchedule();
}

// Dashboard stats (aggregate across all churches)
app.get('/api/stats', async (req, res) => {
  try {
    const churches = Database.listChurches();
    let totalUsers = 0, totalPeople = 0, totalFamilies = 0, totalGatherings = 0, totalSessions = 0;

    for (const church of churches) {
      const cid = church.church_id;
      const u = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM users WHERE is_active = 1');
      const p = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM individuals WHERE is_active = 1');
      const f = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM families');
      const g = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM gathering_types WHERE is_active = 1');
      const s = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM attendance_sessions WHERE excluded_from_stats = 0');
      totalUsers += Number(u[0]?.count || 0);
      totalPeople += Number(p[0]?.count || 0);
      totalFamilies += Number(f[0]?.count || 0);
      totalGatherings += Number(g[0]?.count || 0);
      totalSessions += Number(s[0]?.count || 0);
    }

    res.json({
      churches: churches.length,
      users: totalUsers,
      people: totalPeople,
      families: totalFamilies,
      gatherings: totalGatherings,
      sessions: totalSessions
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all churches
app.get('/api/churches', async (req, res) => {
  try {
    const allChurches = Database.listChurches();

    const churchesWithDetails = await Promise.all(allChurches.map(async (church) => {
      const cid = church.church_id;
      const usersResult = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM users WHERE is_active = 1');
      const peopleResult = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM individuals WHERE is_active = 1');
      const gatheringsResult = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM gathering_types WHERE is_active = 1');
      const settings = await Database.queryForChurch(cid, 'SELECT church_name, country_code, timezone FROM church_settings LIMIT 1');
      const firstUser = await Database.queryForChurch(cid, "SELECT first_name, last_name, email, created_at FROM users ORDER BY created_at ASC LIMIT 1");
      const lastActivity = await Database.queryForChurch(cid, "SELECT MAX(last_login_at) as last_activity FROM users");

      return {
        church_id: cid,
        church_name: settings[0]?.church_name || cid,
        country_code: settings[0]?.country_code || 'AU',
        timezone: settings[0]?.timezone || 'Australia/Sydney',
        user_count: Number(usersResult[0]?.count || 0),
        created_at: firstUser[0]?.created_at || church.created_at,
        created_by_name: firstUser[0] ? `${firstUser[0].first_name || ''} ${firstUser[0].last_name || ''}`.trim() : '',
        created_by_email: firstUser[0]?.email || '',
        last_activity: lastActivity[0]?.last_activity,
        church_name: church.church_name || null,
        is_approved: !!church.is_approved,
        people_count: peopleResult[0]?.count || 0,
        gathering_count: gatheringsResult[0]?.count || 0
      };
    }));

    res.json(churchesWithDetails);
  } catch (error) {
    console.error('Churches error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get church details
app.get('/api/churches/:churchId', async (req, res) => {
  try {
    const { churchId } = req.params;

    const [users, gatherings, recentSessions] = await Promise.all([
      Database.queryForChurch(churchId, `
        SELECT id, email, mobile_number, role, first_name, last_name,
               is_active, last_login_at, created_at
        FROM users
        WHERE church_id = ?
        ORDER BY last_login_at DESC
      `, [churchId]),
      Database.queryForChurch(churchId, `
        SELECT id, name, description, day_of_week, attendance_type, is_active
        FROM gathering_types
        WHERE church_id = ?
        ORDER BY name
      `, [churchId]),
      Database.queryForChurch(churchId, `
        SELECT as2.id, as2.session_date, gt.name as gathering_name,
               (SELECT COUNT(*) FROM attendance_records ar WHERE ar.session_id = as2.id AND ar.present = 1) as attendance_count
        FROM attendance_sessions as2
        JOIN gathering_types gt ON as2.gathering_type_id = gt.id
        WHERE as2.church_id = ?
        ORDER BY as2.session_date DESC
        LIMIT 10
      `, [churchId])
    ]);

    res.json({
      church_id: churchId,
      users,
      gatherings,
      recent_sessions: recentSessions
    });
  } catch (error) {
    console.error('Church details error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List most active users (aggregated across all churches)
app.get('/api/users/active', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const churches = Database.listChurches();
    let allUsers = [];

    for (const church of churches) {
      const cid = church.church_id;
      const users = await Database.queryForChurch(cid, `
        SELECT
          u.id,
          u.church_id,
          u.email,
          u.mobile_number,
          u.role,
          u.first_name,
          u.last_name,
          u.is_active,
          u.last_login_at,
          u.created_at,
          (SELECT COUNT(*) FROM attendance_sessions as2 WHERE as2.created_by = u.id AND as2.excluded_from_stats = 0) as sessions_created,
          (SELECT COUNT(*) FROM audit_log al WHERE al.user_id = u.id) as actions_taken
        FROM users u
        WHERE u.is_active = 1
        ORDER BY u.last_login_at DESC
      `);
      allUsers.push(...users);
    }

    // Sort by last_login_at descending and take top N
    allUsers.sort((a, b) => (b.last_login_at || '').localeCompare(a.last_login_at || ''));
    res.json(allUsers.slice(0, limit));
  } catch (error) {
    console.error('Active users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all users (aggregated across all churches)
app.get('/api/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    const churches = Database.listChurches();
    let allUsers = [];

    for (const church of churches) {
      const cid = church.church_id;
      let whereClause = '';
      let params = [];

      if (search) {
        whereClause = `WHERE u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.church_id LIKE ?`;
        const searchPattern = `%${search}%`;
        params = [searchPattern, searchPattern, searchPattern, searchPattern];
      }

      const users = await Database.queryForChurch(cid, `
        SELECT
          u.id,
          u.church_id,
          u.email,
          u.mobile_number,
          u.role,
          u.first_name,
          u.last_name,
          u.is_active,
          u.last_login_at,
          u.created_at
        FROM users u
        ${whereClause}
        ORDER BY u.created_at DESC
      `, params);
      allUsers.push(...users);
    }

    // Sort by created_at descending
    allUsers.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const total = allUsers.length;
    const paginatedUsers = allUsers.slice(offset, offset + limit);

    res.json({
      users: paginatedUsers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user details (searches across all churches)
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const churches = Database.listChurches();
    let foundUser = null;
    let recentActivity = [];

    for (const church of churches) {
      const cid = church.church_id;
      const user = await Database.queryForChurch(cid, 'SELECT * FROM users WHERE id = ?', [userId]);
      if (user.length) {
        foundUser = user[0];
        recentActivity = await Database.queryForChurch(cid, `
          SELECT action, entity_type, created_at
          FROM audit_log
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 20
        `, [userId]);
        break;
      }
    }

    if (!foundUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      ...foundUser,
      recent_activity: recentActivity
    });
  } catch (error) {
    console.error('User details error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Approve or unapprove a church
app.post('/api/churches/:churchId/approve', async (req, res) => {
  try {
    const { churchId } = req.params;
    const { approved } = req.body;
    Database.approveChurch(churchId, !!approved);
    res.json({ message: `Church ${churchId} has been ${approved ? 'approved' : 'unapproved'}.` });
  } catch (error) {
    console.error('Approve church error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Archive/unarchive a church (deactivates/reactivates all users)
app.post('/api/churches/:churchId/archive', async (req, res) => {
  try {
    const { churchId } = req.params;
    const { archive } = req.body; // true = archive, false = unarchive

    // Count affected users
    const users = await Database.queryForChurch(churchId,
      'SELECT COUNT(*) as count FROM users WHERE church_id = ?',
      [churchId]
    );

    // Update all users' is_active status
    await Database.queryForChurch(churchId,
      'UPDATE users SET is_active = ? WHERE church_id = ?',
      [archive ? 0 : 1, churchId]
    );

    const action = archive ? 'archived' : 'unarchived';
    res.json({
      success: true,
      message: `Church ${action}. ${users[0].count} user(s) ${archive ? 'deactivated' : 'reactivated'}.`
    });
  } catch (error) {
    console.error('Archive church error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a user (soft delete by default, hard delete with ?hard=true)
app.delete('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const hardDelete = req.query.hard === 'true';
    const churches = Database.listChurches();

    // Find user across churches
    let user = null;
    let userChurchId = null;
    for (const church of churches) {
      const cid = church.church_id;
      const result = await Database.queryForChurch(cid,
        'SELECT email, first_name, last_name, church_id FROM users WHERE id = ?',
        [userId]
      );
      if (result.length) {
        user = result[0];
        userChurchId = cid;
        break;
      }
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (hardDelete) {
      await Database.queryForChurch(userChurchId, 'DELETE FROM users WHERE id = ?', [userId]);
      res.json({
        success: true,
        message: `User ${user.email} permanently deleted.`
      });
    } else {
      await Database.queryForChurch(userChurchId,
        'UPDATE users SET is_active = 0 WHERE id = ?',
        [userId]
      );
      res.json({
        success: true,
        message: `User ${user.email} deactivated.`
      });
    }
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reactivate a user
app.post('/api/users/:userId/reactivate', async (req, res) => {
  try {
    const { userId } = req.params;
    const churches = Database.listChurches();

    let user = null;
    let userChurchId = null;
    for (const church of churches) {
      const cid = church.church_id;
      const result = await Database.queryForChurch(cid, 'SELECT email FROM users WHERE id = ?', [userId]);
      if (result.length) {
        user = result[0];
        userChurchId = cid;
        break;
      }
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await Database.queryForChurch(userChurchId,
      'UPDATE users SET is_active = 1 WHERE id = ?',
      [userId]
    );

    res.json({
      success: true,
      message: `User ${user.email} reactivated.`
    });
  } catch (error) {
    console.error('Reactivate user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Transfer church ownership to a different user
app.post('/api/churches/:churchId/transfer', async (req, res) => {
  try {
    const { churchId } = req.params;
    const { newOwnerUserId } = req.body;

    if (!newOwnerUserId) {
      return res.status(400).json({ error: 'New owner user ID is required' });
    }

    // Verify the new owner exists and belongs to this church
    const newOwner = await Database.queryForChurch(churchId,
      'SELECT id, email, first_name, last_name, role FROM users WHERE id = ? AND church_id = ?',
      [newOwnerUserId, churchId]
    );

    if (!newOwner.length) {
      return res.status(404).json({ error: 'User not found or does not belong to this church' });
    }

    // Make the new owner an admin if they aren't already
    if (newOwner[0].role !== 'admin') {
      await Database.queryForChurch(churchId,
        'UPDATE users SET role = "admin" WHERE id = ?',
        [newOwnerUserId]
      );
    }

    res.json({
      success: true,
      message: `Ownership transferred to ${newOwner[0].first_name} ${newOwner[0].last_name} (${newOwner[0].email}). They are now an admin.`,
      newOwner: {
        id: newOwner[0].id,
        email: newOwner[0].email,
        name: `${newOwner[0].first_name} ${newOwner[0].last_name}`
      }
    });
  } catch (error) {
    console.error('Transfer ownership error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update church name (for churches missing names)
app.post('/api/churches/:churchId/name', async (req, res) => {
  try {
    const { churchId } = req.params;
    const { churchName } = req.body;

    if (!churchName || !churchName.trim()) {
      return res.status(400).json({ error: 'Church name is required' });
    }

    // Check if church_settings exists for this church_id
    const existing = await Database.queryForChurch(churchId,
      'SELECT id FROM church_settings WHERE church_id = ?',
      [churchId]
    );

    if (existing.length > 0) {
      await Database.queryForChurch(churchId,
        'UPDATE church_settings SET church_name = ?, updated_at = datetime(\'now\') WHERE church_id = ?',
        [churchName.trim(), churchId]
      );
    } else {
      await Database.queryForChurch(churchId, `
        INSERT INTO church_settings (church_id, church_name, country_code, timezone, onboarding_completed)
        VALUES (?, ?, 'AU', 'Australia/Sydney', 0)
      `, [churchId, churchName.trim()]);
    }

    res.json({ success: true, message: `Church name updated to "${churchName.trim()}"` });
  } catch (error) {
    console.error('Update church name error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Database health check
app.get('/api/health', async (req, res) => {
  try {
    const isConnected = await Database.testConnection();
    const dbInfo = await Database.registryQuery('SELECT sqlite_version() as version');

    res.json({
      status: isConnected ? 'healthy' : 'unhealthy',
      database: {
        connected: isConnected,
        version: dbInfo[0]?.version
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Recent audit log entries (aggregated across all churches)
app.get('/api/audit-log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const churches = Database.listChurches();
    let allEntries = [];

    for (const church of churches) {
      const cid = church.church_id;
      const entries = await Database.queryForChurch(cid, `
        SELECT
          al.id,
          al.user_id,
          u.email as user_email,
          al.church_id,
          al.action,
          al.entity_type,
          al.entity_id,
          al.created_at
        FROM audit_log al
        LEFT JOIN users u ON al.user_id = u.id
        ORDER BY al.created_at DESC
        LIMIT ?
      `, [limit]);
      allEntries.push(...entries);
    }

    // Sort by created_at descending and take top N
    allEntries.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    res.json(allEntries.slice(0, limit));
  } catch (error) {
    console.error('Audit log error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export church data as ZIP of CSVs
app.get('/api/churches/:churchId/export', async (req, res) => {
  try {
    const { churchId } = req.params;
    const archiver = require('archiver');

    const EXPORT_TABLES = [
      'church_settings', 'users', 'gathering_types', 'user_gathering_assignments',
      'families', 'individuals', 'gathering_lists', 'attendance_sessions',
      'attendance_records', 'headcount_records', 'kiosk_checkins',
      'notification_rules', 'notifications', 'visitor_config', 'audit_log',
      'ai_chat_conversations', 'ai_chat_messages', 'user_preferences',
    ];
    const REDACT_COLUMNS = ['brevo_api_key', 'anthropic_api_key', 'openai_api_key', 'elvanto_api_key'];

    function escapeCsvValue(val) {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${churchId}-export-${new Date().toISOString().split('T')[0]}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Export failed' });
    });
    archive.pipe(res);

    for (const table of EXPORT_TABLES) {
      try {
        const rows = await Database.queryForChurch(churchId, `SELECT * FROM ${table}`);
        if (rows.length > 0) {
          const columns = Object.keys(rows[0]).filter(c => !REDACT_COLUMNS.includes(c));
          const header = columns.map(escapeCsvValue).join(',');
          const lines = rows.map(row => columns.map(col => escapeCsvValue(row[col])).join(','));
          archive.append(header + '\n' + lines.join('\n') + '\n', { name: `${table}.csv` });
        }
      } catch (err) {
        console.warn(`Export: skipped table ${table}:`, err.message);
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error('Export error:', error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Delete a church and all its data
app.delete('/api/churches/:churchId', async (req, res) => {
  try {
    const { churchId } = req.params;
    const { confirmChurchId } = req.body;

    if (confirmChurchId !== churchId) {
      return res.status(400).json({ error: 'Church ID confirmation does not match' });
    }

    // Remove from registry
    await Database.registryQuery('DELETE FROM user_lookup WHERE church_id = ?', [churchId]);
    await Database.registryQuery('DELETE FROM churches WHERE church_id = ?', [churchId]);

    // Close and delete database files
    Database.closeChurchDb(churchId);

    const dataDir = process.env.CHURCH_DATA_DIR || process.env.DATA_DIR ||
      path.join(__dirname, '..', 'data');
    const dbPath = path.join(dataDir, 'churches', `${churchId}.sqlite`);

    for (const suffix of ['', '-wal', '-shm']) {
      const file = dbPath + suffix;
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        console.log(`Deleted: ${file}`);
      }
    }

    res.json({ success: true, message: `Church ${churchId} and all data permanently deleted.` });
  } catch (error) {
    console.error('Delete church error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// Backup API Routes
// ============================================

// Get backup status
app.get('/api/backups/status', (req, res) => {
  res.json(BackupService.getStatus());
});

// Configure backup (save S3 settings)
app.post('/api/backups/configure', async (req, res) => {
  try {
    const { endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, retentionDays, schedule } = req.body;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      return res.status(400).json({ error: 'endpoint, bucket, accessKeyId, and secretAccessKey are required' });
    }

    BackupService.configure({ endpoint, bucket, region, accessKeyId, secretAccessKey, prefix, retentionDays, schedule });

    // Test the connection
    await BackupService.testConnection();

    res.json({ success: true, message: 'Backup configured and connection verified.' });
  } catch (error) {
    res.status(500).json({ error: `Configuration failed: ${error.message}` });
  }
});

// Test S3 connection
app.post('/api/backups/test', async (req, res) => {
  try {
    if (!BackupService.isConfigured()) {
      return res.status(400).json({ error: 'Backup not configured' });
    }
    await BackupService.testConnection();
    res.json({ success: true, message: 'Connection successful.' });
  } catch (error) {
    res.status(500).json({ error: `Connection test failed: ${error.message}` });
  }
});

// Start/stop backup schedule
app.post('/api/backups/schedule', (req, res) => {
  const { enabled } = req.body;
  if (enabled) {
    const started = BackupService.startSchedule();
    res.json({ success: started, message: started ? 'Schedule started.' : 'Failed to start schedule.' });
  } else {
    BackupService.stopSchedule();
    res.json({ success: true, message: 'Schedule stopped.' });
  }
});

// Trigger manual backup of everything
app.post('/api/backups/run', async (req, res) => {
  try {
    if (!BackupService.isConfigured()) {
      return res.status(400).json({ error: 'Backup not configured' });
    }
    const results = await BackupService.backupAll();
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: `Backup failed: ${error.message}` });
  }
});

// Backup a single church
app.post('/api/backups/churches/:churchId', async (req, res) => {
  try {
    if (!BackupService.isConfigured()) {
      return res.status(400).json({ error: 'Backup not configured' });
    }
    const result = await BackupService.backupChurch(req.params.churchId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `Backup failed: ${error.message}` });
  }
});

// List snapshots for a target (registry or churchId)
app.get('/api/backups/snapshots/:target', async (req, res) => {
  try {
    if (!BackupService.isConfigured()) {
      return res.status(400).json({ error: 'Backup not configured' });
    }
    const snapshots = await BackupService.listSnapshots(req.params.target);
    res.json(snapshots);
  } catch (error) {
    res.status(500).json({ error: `Failed to list snapshots: ${error.message}` });
  }
});

// Restore a church from a snapshot
app.post('/api/backups/restore/:churchId', async (req, res) => {
  try {
    if (!BackupService.isConfigured()) {
      return res.status(400).json({ error: 'Backup not configured' });
    }
    const { snapshotKey } = req.body;
    if (!snapshotKey) {
      return res.status(400).json({ error: 'snapshotKey is required' });
    }
    const result = await BackupService.restoreChurch(req.params.churchId, snapshotKey);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `Restore failed: ${error.message}` });
  }
});

// Prune old snapshots
app.post('/api/backups/prune', async (req, res) => {
  try {
    if (!BackupService.isConfigured()) {
      return res.status(400).json({ error: 'Backup not configured' });
    }
    const result = await BackupService.pruneSnapshots();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: `Prune failed: ${error.message}` });
  }
});

// ============================================
// Local Backup/Restore API Routes
// ============================================

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', '..', 'backups');

function getBackupDir() {
  // In Docker, use /app/backups (bind-mounted from host ./backups/)
  if (process.env.DOCKER_ENV) return '/app/backups';
  return BACKUP_DIR;
}

// List available local backup files
app.get('/api/local-backups', async (req, res) => {
  try {
    const backupDir = getBackupDir();
    if (!fs.existsSync(backupDir)) {
      return res.json({ files: [], zips: [] });
    }

    const entries = fs.readdirSync(backupDir);
    const files = [];
    const zips = [];

    for (const entry of entries) {
      const fullPath = path.join(backupDir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) continue;

      if (entry.endsWith('.zip')) {
        // Peek inside zip to list contents
        let contents = [];
        try {
          const AdmZip = require('adm-zip');
          const zip = new AdmZip(fullPath);
          contents = zip.getEntries()
            .filter(e => e.entryName.endsWith('.sqlite') && !e.entryName.startsWith('__MACOSX'))
            .map(e => ({
              name: e.entryName,
              size: e.header.size,
              churchId: extractChurchId(e.entryName),
              isRegistry: e.entryName.includes('registry'),
            }));
        } catch (err) {
          console.warn(`Could not read zip ${entry}:`, err.message);
        }

        zips.push({
          filename: entry,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          contents,
        });
      } else if (entry.endsWith('.sqlite')) {
        const churchId = extractChurchId(entry);
        const hasWal = fs.existsSync(fullPath + '-wal');
        const hasShm = fs.existsSync(fullPath + '-shm');
        const walSize = hasWal ? fs.statSync(fullPath + '-wal').size : 0;

        files.push({
          filename: entry,
          churchId,
          isRegistry: entry.includes('registry'),
          size: stat.size,
          walSize,
          hasWal,
          hasShm,
          modified: stat.mtime.toISOString(),
        });
      }
    }

    // Also check for a churches/ subdirectory (from extracted zips)
    const churchesSubDir = path.join(backupDir, 'churches');
    if (fs.existsSync(churchesSubDir) && fs.statSync(churchesSubDir).isDirectory()) {
      const churchEntries = fs.readdirSync(churchesSubDir);
      for (const entry of churchEntries) {
        if (!entry.endsWith('.sqlite')) continue;
        const fullPath = path.join(churchesSubDir, entry);
        const stat = fs.statSync(fullPath);
        const churchId = extractChurchId(entry);
        const hasWal = fs.existsSync(fullPath + '-wal');
        const hasShm = fs.existsSync(fullPath + '-shm');
        const walSize = hasWal ? fs.statSync(fullPath + '-wal').size : 0;

        files.push({
          filename: `churches/${entry}`,
          churchId,
          isRegistry: false,
          size: stat.size,
          walSize,
          hasWal,
          hasShm,
          modified: stat.mtime.toISOString(),
        });
      }
    }

    // Check for registry.sqlite at top level of backups dir
    const registryInBackups = path.join(backupDir, 'registry.sqlite');
    if (fs.existsSync(registryInBackups) && !files.some(f => f.filename === 'registry.sqlite')) {
      const stat = fs.statSync(registryInBackups);
      const hasWal = fs.existsSync(registryInBackups + '-wal');
      const walSize = hasWal ? fs.statSync(registryInBackups + '-wal').size : 0;
      files.push({
        filename: 'registry.sqlite',
        churchId: null,
        isRegistry: true,
        size: stat.size,
        walSize,
        hasWal,
        hasShm: fs.existsSync(registryInBackups + '-shm'),
        modified: stat.mtime.toISOString(),
      });
    }

    res.json({ files, zips });
  } catch (error) {
    console.error('Local backups scan error:', error);
    res.status(500).json({ error: error.message });
  }
});

function extractChurchId(filename) {
  // Extract church_id from filenames like "red_9f3a7c2e5b10.sqlite" or "churches/red_9f3a7c2e5b10.sqlite"
  const base = path.basename(filename, '.sqlite');
  if (base === 'registry') return null;
  return base;
}

// Restore from a zip file (all churches + registry)
app.post('/api/local-backups/restore-zip', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });

    const backupDir = getBackupDir();
    const zipPath = path.join(backupDir, filename);
    if (!fs.existsSync(zipPath)) {
      return res.status(404).json({ error: 'Zip file not found' });
    }

    const AdmZip = require('adm-zip');
    const BetterSqlite3 = require('better-sqlite3');
    const zip = new AdmZip(zipPath);
    const dataDir = process.env.CHURCH_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const churchesDir = path.join(dataDir, 'churches');
    const tmpDir = path.join(dataDir, '.restore-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(churchesDir, { recursive: true });

    const results = { churches: [], registry: false, errors: [] };

    // Extract all entries to temp dir first
    zip.extractAllTo(tmpDir, true);

    // Find and process registry
    const registryTmp = path.join(tmpDir, 'registry.sqlite');
    if (fs.existsSync(registryTmp)) {
      try {
        // Checkpoint WAL if present
        checkpointAndCopy(registryTmp, path.join(dataDir, 'registry.sqlite'));
        results.registry = true;
        // Re-initialize registry
        Database.closeAll();
        Database.initialize();
        Database.migrateRegistry();
      } catch (err) {
        results.errors.push({ target: 'registry', error: err.message });
      }
    }

    // Find and process churches
    const tmpChurchesDir = path.join(tmpDir, 'churches');
    if (fs.existsSync(tmpChurchesDir)) {
      const churchFiles = fs.readdirSync(tmpChurchesDir).filter(f => f.endsWith('.sqlite'));
      for (const file of churchFiles) {
        const churchId = file.replace('.sqlite', '');
        try {
          Database.closeChurchDb(churchId);

          const srcPath = path.join(tmpChurchesDir, file);
          const destPath = path.join(churchesDir, file);

          checkpointAndCopy(srcPath, destPath);

          // Re-open and verify
          const db = Database.getChurchDb(churchId);
          db.prepare('SELECT 1').get();

          results.churches.push(churchId);
        } catch (err) {
          results.errors.push({ target: churchId, error: err.message });
        }
      }
    }

    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    res.json({
      success: true,
      message: `Restored ${results.churches.length} church(es)${results.registry ? ' + registry' : ''}.`,
      ...results,
    });
  } catch (error) {
    console.error('Local restore zip error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore a single church from a local sqlite file
app.post('/api/local-backups/restore-church', async (req, res) => {
  try {
    const { filename, churchId } = req.body;
    if (!filename || !churchId) {
      return res.status(400).json({ error: 'filename and churchId are required' });
    }

    const backupDir = getBackupDir();
    const srcPath = path.join(backupDir, filename);
    if (!fs.existsSync(srcPath)) {
      return res.status(404).json({ error: 'Backup file not found' });
    }

    const dataDir = process.env.CHURCH_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const destPath = path.join(dataDir, 'churches', `${churchId}.sqlite`);
    fs.mkdirSync(path.join(dataDir, 'churches'), { recursive: true });

    // Close existing connection
    Database.closeChurchDb(churchId);

    checkpointAndCopy(srcPath, destPath);

    // Re-open and verify
    const db = Database.getChurchDb(churchId);
    db.prepare('SELECT 1').get();

    // Ensure church exists in registry
    const settings = await Database.queryForChurch(churchId, 'SELECT church_name FROM church_settings LIMIT 1');
    const churchName = settings[0]?.church_name || churchId;
    Database.ensureChurch(churchId, churchName);

    res.json({
      success: true,
      message: `Restored church "${churchName}" (${churchId}) successfully.`,
      churchId,
    });
  } catch (error) {
    console.error('Local restore church error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore registry from a local sqlite file
app.post('/api/local-backups/restore-registry', async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });

    const backupDir = getBackupDir();
    const srcPath = path.join(backupDir, filename);
    if (!fs.existsSync(srcPath)) {
      return res.status(404).json({ error: 'Backup file not found' });
    }

    const dataDir = process.env.CHURCH_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    const destPath = path.join(dataDir, 'registry.sqlite');

    // Close all connections and reinitialize
    Database.closeAll();

    checkpointAndCopy(srcPath, destPath);

    Database.initialize();
    Database.migrateRegistry();

    res.json({
      success: true,
      message: 'Registry restored successfully.',
    });
  } catch (error) {
    console.error('Local restore registry error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Checkpoint WAL into the main sqlite file, then copy the clean file to dest.
 * Also removes any existing WAL/SHM at the destination.
 */
function checkpointAndCopy(srcPath, destPath) {
  const BetterSqlite3 = require('better-sqlite3');

  // If source has a WAL file, checkpoint it first to merge data into the main file
  const srcWal = srcPath + '-wal';
  if (fs.existsSync(srcWal) && fs.statSync(srcWal).size > 0) {
    const tmpDb = new BetterSqlite3(srcPath);
    try {
      tmpDb.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      tmpDb.close();
    }
  }

  // Remove destination WAL/SHM files
  for (const suffix of ['-wal', '-shm']) {
    const f = destPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  // Copy the checkpointed sqlite file
  fs.copyFileSync(srcPath, destPath);
}

// Serve admin UI
app.get('*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
// When running in Docker, bind to 0.0.0.0 (Docker port mapping handles localhost restriction)
// When running locally, bind to 127.0.0.1 for security
const BIND_HOST = process.env.DOCKER_ENV ? '0.0.0.0' : '127.0.0.1';
const server = app.listen(ADMIN_PORT, BIND_HOST, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║     Let My People Grow - Internal Admin Panel         ║');
  console.log('╠═══════════════════════════════════════════════════════╣');
  console.log(`║  Running on: http://localhost:${ADMIN_PORT}                   ║`);
  if (process.env.DOCKER_ENV) {
    console.log('║  Mode: Docker (host binding restricts to localhost)  ║');
  } else {
    console.log('║  Mode: Local (bound to 127.0.0.1 only)                ║');
  }
  console.log('║                                                       ║');
  console.log('║  WARNING: No authentication required                  ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Admin panel shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('Admin panel shutting down...');
  server.close(() => process.exit(0));
});
