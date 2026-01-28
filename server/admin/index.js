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

// Dashboard stats
app.get('/api/stats', async (req, res) => {
  try {
    const [churches, users, people, families, gatherings, sessions] = await Promise.all([
      Database.query(`SELECT COUNT(DISTINCT church_id) as count FROM users`),
      Database.query(`SELECT COUNT(*) as count FROM users WHERE is_active = 1`),
      Database.query(`SELECT COUNT(*) as count FROM individuals WHERE is_active = 1`),
      Database.query(`SELECT COUNT(*) as count FROM families`),
      Database.query(`SELECT COUNT(*) as count FROM gathering_types WHERE is_active = 1`),
      Database.query(`SELECT COUNT(*) as count FROM attendance_sessions`)
    ]);

    res.json({
      churches: churches[0]?.count || 0,
      users: users[0]?.count || 0,
      people: people[0]?.count || 0,
      families: families[0]?.count || 0,
      gatherings: gatherings[0]?.count || 0,
      sessions: sessions[0]?.count || 0
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all churches
app.get('/api/churches', async (req, res) => {
  try {
    // Get church info by joining users with church_settings
    // Also find the first user (creator) for each church
    const churches = await Database.query(`
      SELECT 
        u.church_id,
        cs.church_name,
        cs.country_code,
        cs.timezone,
        COUNT(DISTINCT u.id) as user_count,
        MAX(u.last_login_at) as last_activity,
        MIN(u.created_at) as created_at,
        (SELECT CONCAT(COALESCE(u2.first_name, ''), ' ', COALESCE(u2.last_name, '')) 
         FROM users u2 
         WHERE u2.church_id = u.church_id 
         ORDER BY u2.created_at ASC LIMIT 1) as created_by_name,
        (SELECT u2.email 
         FROM users u2 
         WHERE u2.church_id = u.church_id 
         ORDER BY u2.created_at ASC LIMIT 1) as created_by_email
      FROM users u
      LEFT JOIN church_settings cs ON cs.church_id = u.church_id
      WHERE u.is_active = 1
      GROUP BY u.church_id, cs.church_name, cs.country_code, cs.timezone
      ORDER BY user_count DESC, u.church_id
    `);

    // Get people and gathering counts for each church
    const churchesWithDetails = await Promise.all(churches.map(async (church) => {
      // Count people created by users in this church
      const peopleResult = await Database.query(`
        SELECT COUNT(DISTINCT i.id) as count 
        FROM individuals i
        JOIN families f ON i.family_id = f.id
        JOIN users u ON f.created_by = u.id
        WHERE i.is_active = 1 AND u.church_id = ?
      `, [church.church_id]);

      // Count gatherings for this church
      const gatheringsResult = await Database.query(`
        SELECT COUNT(*) as count 
        FROM gathering_types 
        WHERE church_id = ? AND is_active = 1
      `, [church.church_id]);
      
      return {
        ...church,
        // Use actual church name if available, otherwise show church_id
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
      Database.query(`
        SELECT id, email, mobile_number, role, first_name, last_name, 
               is_active, last_login_at, created_at
        FROM users 
        WHERE church_id = ?
        ORDER BY last_login_at DESC
      `, [churchId]),
      Database.query(`
        SELECT id, name, description, day_of_week, attendance_type, is_active
        FROM gathering_types 
        WHERE church_id = ?
        ORDER BY name
      `, [churchId]),
      Database.query(`
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

// List most active users
app.get('/api/users/active', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    
    const users = await Database.query(`
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
      LIMIT ?
    `, [limit]);

    res.json(users);
  } catch (error) {
    console.error('Active users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all users
app.get('/api/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let whereClause = '';
    let params = [];

    if (search) {
      whereClause = `WHERE u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR u.church_id LIKE ?`;
      const searchPattern = `%${search}%`;
      params = [searchPattern, searchPattern, searchPattern, searchPattern];
    }

    const [users, countResult] = await Promise.all([
      Database.query(`
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
        LIMIT ? OFFSET ?
      `, [...params, limit, offset]),
      Database.query(`SELECT COUNT(*) as total FROM users u ${whereClause}`, params)
    ]);

    res.json({
      users,
      pagination: {
        page,
        limit,
        total: countResult[0]?.total || 0,
        pages: Math.ceil((countResult[0]?.total || 0) / limit)
      }
    });
  } catch (error) {
    console.error('Users error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user details
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const [user, recentActivity] = await Promise.all([
      Database.query(`
        SELECT * FROM users WHERE id = ?
      `, [userId]),
      Database.query(`
        SELECT action, entity_type, created_at
        FROM audit_log
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 20
      `, [userId])
    ]);

    if (!user.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      ...user[0],
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
    const users = await Database.query(
      'SELECT COUNT(*) as count FROM users WHERE church_id = ?',
      [churchId]
    );

    // Update all users' is_active status
    await Database.query(
      'UPDATE users SET is_active = ? WHERE church_id = ?',
      [!archive, churchId]
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

    // Get user info first
    const user = await Database.query(
      'SELECT email, first_name, last_name, church_id FROM users WHERE id = ?',
      [userId]
    );

    if (!user.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (hardDelete) {
      // Hard delete - remove from database
      await Database.query('DELETE FROM users WHERE id = ?', [userId]);
      res.json({ 
        success: true, 
        message: `User ${user[0].email} permanently deleted.`
      });
    } else {
      // Soft delete - deactivate
      await Database.query(
        'UPDATE users SET is_active = false WHERE id = ?',
        [userId]
      );
      res.json({ 
        success: true, 
        message: `User ${user[0].email} deactivated.`
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

    const user = await Database.query(
      'SELECT email FROM users WHERE id = ?',
      [userId]
    );

    if (!user.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    await Database.query(
      'UPDATE users SET is_active = true WHERE id = ?',
      [userId]
    );

    res.json({ 
      success: true, 
      message: `User ${user[0].email} reactivated.`
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
    const newOwner = await Database.query(
      'SELECT id, email, first_name, last_name, role FROM users WHERE id = ? AND church_id = ?',
      [newOwnerUserId, churchId]
    );

    if (!newOwner.length) {
      return res.status(404).json({ error: 'User not found or does not belong to this church' });
    }

    // Get current admins
    const currentAdmins = await Database.query(
      'SELECT id, email FROM users WHERE church_id = ? AND role = "admin"',
      [churchId]
    );

    // Make the new owner an admin if they aren't already
    if (newOwner[0].role !== 'admin') {
      await Database.query(
        'UPDATE users SET role = "admin" WHERE id = ?',
        [newOwnerUserId]
      );
    }

    // Optionally demote other admins to coordinator (keep them as admins for now)
    // await Database.query(
    //   'UPDATE users SET role = "coordinator" WHERE church_id = ? AND role = "admin" AND id != ?',
    //   [churchId, newOwnerUserId]
    // );

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
    const existing = await Database.query(
      'SELECT id FROM church_settings WHERE church_id = ?',
      [churchId]
    );

    if (existing.length > 0) {
      // Update existing record
      await Database.query(
        'UPDATE church_settings SET church_name = ?, updated_at = NOW() WHERE church_id = ?',
        [churchName.trim(), churchId]
      );
    } else {
      // Create new record
      await Database.query(`
        INSERT INTO church_settings (church_id, church_name, country_code, timezone, onboarding_completed)
        VALUES (?, ?, 'AU', 'Australia/Sydney', false)
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
    const dbInfo = await Database.query(`SELECT VERSION() as version`);
    
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

// Recent audit log entries
app.get('/api/audit-log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    
    const entries = await Database.query(`
      SELECT 
        al.id,
        al.user_id,
        u.email as user_email,
        u.church_id,
        al.action,
        al.entity_type,
        al.entity_id,
        al.created_at
      FROM audit_log al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.created_at DESC
      LIMIT ?
    `, [limit]);

    res.json(entries);
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
