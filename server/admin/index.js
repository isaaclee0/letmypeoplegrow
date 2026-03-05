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
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Import database
const Database = require('../config/database');

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
      const s = await Database.queryForChurch(cid, 'SELECT COUNT(*) as count FROM attendance_sessions');
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
          (SELECT COUNT(*) FROM attendance_sessions as2 WHERE as2.created_by = u.id) as sessions_created,
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

// Serve admin UI
app.get('*', (req, res) => {
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
