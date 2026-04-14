const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireGatheringAccess, requireRole, auditLog } = require('../middleware/auth');
const { requireLastAttendedColumn, columnExists } = require('../utils/databaseSchema');
const { processApiResponse } = require('../utils/caseConverter');
const websocketBroadcast = require('../utils/websocketBroadcast');
const logger = require('../config/logger');

const router = express.Router();

/**
 * Snapshot the current roster into attendance_records with present=0.
 * This preserves the historical roster state so past sessions show who was on the list at that time.
 * Uses ON CONFLICT DO NOTHING so existing records (e.g., already marked present) are preserved.
 *
 * @param {object} conn - Database connection (within transaction)
 * @param {number} sessionId - The attendance session ID
 * @param {number} gatheringTypeId - The gathering type ID
 * @param {string} churchId - The church ID
 * @param {string} date - The session date (YYYY-MM-DD)
 */
async function createRosterSnapshot(conn, sessionId, gatheringTypeId, churchId, date) {
  try {
    // Check if already snapshotted
    const session = await conn.query(
      'SELECT roster_snapshotted FROM attendance_sessions WHERE id = ?',
      [sessionId]
    );
    if (session.length > 0 && session[0].roster_snapshotted === 1) {
      return; // Already snapshotted
    }

    // Don't snapshot future dates
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sessionDate = new Date(date);
    sessionDate.setHours(0, 0, 0, 0);
    if (sessionDate > today) {
      return;
    }

    // Only snapshot standard attendance type gatherings (not headcount)
    const gathering = await conn.query(
      'SELECT attendance_type FROM gathering_types WHERE id = ? AND church_id = ?',
      [gatheringTypeId, churchId]
    );
    if (gathering.length === 0 || gathering[0].attendance_type !== 'standard') {
      return;
    }

    // Get all active individuals on this gathering's roster
    const rosterMembers = await conn.query(`
      SELECT gl.individual_id, COALESCE(i.people_type, 'regular') as people_type
      FROM gathering_lists gl
      JOIN individuals i ON gl.individual_id = i.id
      WHERE gl.gathering_type_id = ?
        AND i.is_active = 1
        AND i.church_id = ?
    `, [gatheringTypeId, churchId]);

    // Bulk-insert with ON CONFLICT DO NOTHING to preserve existing records
    for (const member of rosterMembers) {
      await conn.query(`
        INSERT INTO attendance_records (session_id, individual_id, present, church_id, people_type_at_time)
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(session_id, individual_id) DO NOTHING
      `, [sessionId, member.individual_id, churchId, member.people_type]);
    }

    // Mark session as snapshotted
    await conn.query(
      'UPDATE attendance_sessions SET roster_snapshotted = 1 WHERE id = ?',
      [sessionId]
    );

    logger.debugLog('Roster snapshot created', {
      sessionId,
      gatheringTypeId,
      rosterSize: rosterMembers.length
    });
  } catch (error) {
    // Log but don't fail the parent operation
    logger.error('Error creating roster snapshot', { error: error.message, sessionId });
  }
}

router.use(verifyToken);

// Debug middleware to log all requests
router.use((req, res, next) => {
  if (req.path.includes('headcount')) {
    logger.debugLog('HEADCOUNT REQUEST', {
      method: req.method,
      path: req.path,
      body: req.body,
      params: req.params,
      query: req.query
    });
  }
  next();
});

// Middleware to disable caching for attendance endpoints
const disableCache = (req, res, next) => {
  res.set({
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.removeHeader('ETag');
  next();
};

// ===== HEADCOUNT ENDPOINTS (MUST BE FIRST TO AVOID ROUTE CONFLICTS) =====

// Get headcount for a specific gathering and date
router.get('/headcount/:gatheringTypeId/:date', (req, res, next) => {
  logger.debugLog('HEADCOUNT ROUTE: Matched headcount route', {
    path: req.path,
    params: req.params
  });
  next();
}, disableCache, requireGatheringAccess, async (req, res) => {
  logger.debugLog('HEADCOUNT ENDPOINT: Starting execution');
  try {
    logger.debugLog('HEADCOUNT GET: Request received', {
      gatheringTypeId: req.params.gatheringTypeId,
      date: req.params.date,
      userId: req.user?.id,
      churchId: req.user?.church_id
    });
    
    const { gatheringTypeId, date } = req.params;
    const { mode = 'separate' } = req.query; // Default to separate mode

    // First, verify this is a headcount gathering
    const gathering = await Database.query(`
      SELECT attendance_type FROM gathering_types 
      WHERE id = ? AND church_id = ?
    `, [gatheringTypeId, req.user.church_id]);

    if (gathering.length === 0) {
      return res.status(404).json({ error: 'Gathering not found.' });
    }

    if (gathering[0].attendance_type !== 'headcount') {
      return res.status(400).json({ error: 'This gathering is not configured for headcount attendance.' });
    }

    // Get or create attendance session (use transaction for consistency)
    let sessionId;
    let sessionMode = 'separate';
    await Database.transaction(async (conn) => {
      let sessionResult = await conn.query(`
        SELECT id, headcount_mode FROM attendance_sessions 
        WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?
      `, [gatheringTypeId, date, req.user.church_id]);

      if (sessionResult.length === 0) {
        // Create new session with default mode
        const newSession = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id, headcount_mode)
          VALUES (?, ?, ?, ?, ?)
        `, [gatheringTypeId, date, req.user.id, req.user.church_id, mode]);
        sessionId = newSession.insertId;
        sessionMode = mode;
      } else {
        sessionId = sessionResult[0].id;
        sessionMode = sessionResult[0].headcount_mode || 'separate';
      }
    });

    // Get headcount records based on mode
    let headcountData;
    let otherUsersData = [];
    let userHeadcount = 0; // User's individual contribution

    // Always get the current user's individual headcount
    const userHeadcountResult = await Database.query(`
      SELECT h.headcount, h.updated_at, u.first_name, u.last_name
      FROM headcount_records h
      LEFT JOIN users u ON h.updated_by = u.id
      WHERE h.session_id = ? AND h.updated_by = ?
    `, [sessionId, req.user.id]);

    userHeadcount = userHeadcountResult.length > 0 ? userHeadcountResult[0].headcount : 0;

    if (mode === 'separate') {
      // In separate mode, the user's headcount is the display headcount
      headcountData = userHeadcountResult.length > 0 ? userHeadcountResult[0] : null;

      // Get other users' headcounts for display
      const otherUsersResult = await Database.query(`
        SELECT h.headcount, h.updated_at, u.first_name, u.last_name, u.id
        FROM headcount_records h
        LEFT JOIN users u ON h.updated_by = u.id
        WHERE h.session_id = ? AND h.updated_by != ?
        ORDER BY h.updated_at DESC
      `, [sessionId, req.user.id]);

      otherUsersData = otherUsersResult;

    } else if (mode === 'combined') {
      // Get sum of all headcounts
      const combinedResult = await Database.query(`
        SELECT 
          COALESCE(SUM(h.headcount), 0) as total_headcount,
          MAX(h.updated_at) as last_updated,
          COUNT(DISTINCT h.updated_by) as user_count
        FROM headcount_records h
        WHERE h.session_id = ?
      `, [sessionId]);

      // Get individual user contributions
      const userContributions = await Database.query(`
        SELECT h.headcount, h.updated_at, u.first_name, u.last_name, u.id
        FROM headcount_records h
        LEFT JOIN users u ON h.updated_by = u.id
        WHERE h.session_id = ?
        ORDER BY h.updated_at DESC
      `, [sessionId]);

      headcountData = {
        headcount: combinedResult[0].total_headcount,
        updated_at: combinedResult[0].last_updated,
        first_name: 'Combined',
        last_name: `(${combinedResult[0].user_count} users)`
      };
      otherUsersData = userContributions;

    } else if (mode === 'averaged') {
      // Get average of all headcounts
      const averagedResult = await Database.query(`
        SELECT 
          COALESCE(ROUND(AVG(h.headcount)), 0) as avg_headcount,
          MAX(h.updated_at) as last_updated,
          COUNT(DISTINCT h.updated_by) as user_count
        FROM headcount_records h
        WHERE h.session_id = ?
      `, [sessionId]);

      // Get individual user contributions
      const userContributions = await Database.query(`
        SELECT h.headcount, h.updated_at, u.first_name, u.last_name, u.id
        FROM headcount_records h
        LEFT JOIN users u ON h.updated_by = u.id
        WHERE h.session_id = ?
        ORDER BY h.updated_at DESC
      `, [sessionId]);

      headcountData = {
        headcount: averagedResult[0].avg_headcount,
        updated_at: averagedResult[0].last_updated,
        first_name: 'Averaged',
        last_name: `(${averagedResult[0].user_count} users)`
      };
      otherUsersData = userContributions;
    }

    const response = {
      headcount: headcountData ? headcountData.headcount : 0,
      userHeadcount: userHeadcount, // User's individual contribution
      lastUpdated: headcountData ? headcountData.updated_at : null,
      lastUpdatedBy: headcountData ? 
        `${headcountData.first_name} ${headcountData.last_name}` : null,
      sessionId,
      mode,
      sessionMode,
      otherUsers: otherUsersData
        .map(user => ({
          userId: user.id,
          name: user.id === req.user.id ? 'You' : `${user.first_name} ${user.last_name}`,
          headcount: user.headcount,
          lastUpdated: user.updated_at,
          isCurrentUser: user.id === req.user.id
        }))
        .sort((a, b) => {
          // Put current user first, then sort others alphabetically
          if (a.isCurrentUser && !b.isCurrentUser) return -1;
          if (!a.isCurrentUser && b.isCurrentUser) return 1;
          if (a.isCurrentUser && b.isCurrentUser) return 0;
          return a.name.localeCompare(b.name);
        })
    };

    logger.debugLog('HEADCOUNT: Sending response', response);
    res.json(response);

  } catch (error) {
    console.error('🚨 HEADCOUNT ERROR:', error);
    res.status(500).json({ error: 'Failed to retrieve headcount.' });
  }
});

// Update headcount for a specific gathering and date
router.post('/headcount/update/:gatheringTypeId/:date', disableCache, requireGatheringAccess, auditLog('UPDATE_HEADCOUNT'), async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { headcount, mode = 'separate' } = req.body;
    
    logger.debugLog('POST /headcount received', {
      gatheringTypeId,
      date,
      headcount,
      mode,
      userId: req.user.id
    });

    if (typeof headcount !== 'number' || headcount < 0) {
      return res.status(400).json({ error: 'Valid headcount number is required.' });
    }

    // First, verify this is a headcount gathering
    const gathering = await Database.query(`
      SELECT attendance_type FROM gathering_types 
      WHERE id = ? AND church_id = ?
    `, [gatheringTypeId, req.user.church_id]);

    if (gathering.length === 0) {
      return res.status(404).json({ error: 'Gathering not found.' });
    }

    if (gathering[0].attendance_type !== 'headcount') {
      return res.status(400).json({ error: 'This gathering is not configured for headcount attendance.' });
    }

    let sessionId;
    let sessionMode = 'separate';
    await Database.transaction(async (conn) => {
      // Get or create attendance session
      let sessionResult = await conn.query(`
        SELECT id, headcount_mode FROM attendance_sessions 
        WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?
      `, [gatheringTypeId, date, req.user.church_id]);

      if (sessionResult.length === 0) {
        // Create new session with the specified mode
        const newSession = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id, headcount_mode)
          VALUES (?, ?, ?, ?, ?)
        `, [gatheringTypeId, date, req.user.id, req.user.church_id, mode]);
        sessionId = newSession.insertId;
        sessionMode = mode;
      } else {
        sessionId = sessionResult[0].id;
        sessionMode = sessionResult[0].headcount_mode || 'separate';
        
        // Update session mode if it's different
        if (sessionMode !== mode) {
          await conn.query(`
            UPDATE attendance_sessions 
            SET headcount_mode = ? 
            WHERE id = ?
          `, [mode, sessionId]);
          sessionMode = mode;
        }
      }

      // Insert or update headcount record (now supports per-user records)
      await conn.query(`
        INSERT INTO headcount_records (session_id, headcount, updated_by, church_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id, updated_by) DO UPDATE SET
        headcount = excluded.headcount,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
      `, [sessionId, headcount, req.user.id, req.user.church_id]);
    });

    // Calculate the display value based on mode
    let displayHeadcount = headcount;
    let displayMode = mode;
    
    if (mode === 'combined') {
      const combinedResult = await Database.query(`
        SELECT COALESCE(SUM(headcount), 0) as total_headcount
        FROM headcount_records 
        WHERE session_id = ?
      `, [sessionId]);
      displayHeadcount = combinedResult[0].total_headcount;
      logger.debugLog('Combined calculation', {
        userHeadcount: headcount,
        displayHeadcount: displayHeadcount,
        sessionId: sessionId
      });
    } else if (mode === 'averaged') {
      const averagedResult = await Database.query(`
        SELECT COALESCE(ROUND(AVG(headcount)), 0) as avg_headcount
        FROM headcount_records 
        WHERE session_id = ?
      `, [sessionId]);
      displayHeadcount = averagedResult[0].avg_headcount;
      logger.debugLog('Averaged calculation', {
        userHeadcount: headcount,
        displayHeadcount: displayHeadcount,
        sessionId: sessionId
      });
    }

    // Get other users data for the broadcast
    const otherUsersForBroadcast = await Database.query(`
      SELECT h.headcount, h.updated_at, u.first_name, u.last_name, u.id
      FROM headcount_records h
      LEFT JOIN users u ON h.updated_by = u.id
      WHERE h.session_id = ?
      ORDER BY h.updated_at DESC
    `, [sessionId]);

    // Broadcast the update via WebSocket
    try {
      const broadcastData = {
        gatheringId: parseInt(gatheringTypeId),
        date,
        headcount: displayHeadcount,
        userHeadcount: headcount, // The user's individual headcount
        mode: displayMode,
        updatedBy: req.user.id,
        updatedByName: `${req.user.first_name} ${req.user.last_name}`,
        timestamp: new Date().toISOString(),
        churchId: req.user.church_id,
        otherUsers: otherUsersForBroadcast
          .map(user => ({
            userId: user.id,
            name: user.id === req.user.id ? 'You' : `${user.first_name} ${user.last_name}`,
            headcount: user.headcount,
            lastUpdated: user.updated_at,
            isCurrentUser: user.id === req.user.id
          }))
          .sort((a, b) => {
            // Put current user first, then sort others alphabetically
            if (a.isCurrentUser && !b.isCurrentUser) return -1;
            if (!a.isCurrentUser && b.isCurrentUser) return 1;
            if (a.isCurrentUser && b.isCurrentUser) return 0;
            return a.name.localeCompare(b.name);
          })
      };
      
      logger.debugLog('WebSocket broadcast data', {
        headcount: broadcastData.headcount,
        userHeadcount: broadcastData.userHeadcount,
        mode: broadcastData.mode,
        displayHeadcount: displayHeadcount,
        originalHeadcount: headcount
      });
      
      websocketBroadcast('headcount_updated', broadcastData);
    } catch (wsError) {
      console.error('WebSocket broadcast error:', wsError);
      // Don't fail the request if WebSocket fails
    }

    res.json({ 
      message: 'Headcount updated successfully',
      headcount: displayHeadcount,
      userHeadcount: headcount,
      mode: displayMode,
      updatedBy: `${req.user.first_name} ${req.user.last_name}`,
      otherUsers: otherUsersForBroadcast
        .map(user => ({
          userId: user.id,
          name: user.id === req.user.id ? 'You' : `${user.first_name} ${user.last_name}`,
          headcount: user.headcount,
          lastUpdated: user.updated_at,
          isCurrentUser: user.id === req.user.id
        }))
        .sort((a, b) => {
          // Put current user first, then sort others alphabetically
          if (a.isCurrentUser && !b.isCurrentUser) return -1;
          if (!a.isCurrentUser && b.isCurrentUser) return 1;
          if (a.isCurrentUser && b.isCurrentUser) return 0;
          return a.name.localeCompare(b.name);
        })
    });

  } catch (error) {
    console.error('Update headcount error:', error);
    res.status(500).json({ error: 'Failed to update headcount.' });
  }
});

// Update headcount mode for a specific gathering and date
router.put('/headcount/mode/:gatheringTypeId/:date', disableCache, requireGatheringAccess, auditLog('UPDATE_HEADCOUNT_MODE'), async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { mode } = req.body;

    if (!['separate', 'combined', 'averaged'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Must be separate, combined, or averaged.' });
    }

    // First, verify this is a headcount gathering
    const gathering = await Database.query(`
      SELECT attendance_type FROM gathering_types 
      WHERE id = ? AND church_id = ?
    `, [gatheringTypeId, req.user.church_id]);

    if (gathering.length === 0) {
      return res.status(404).json({ error: 'Gathering not found.' });
    }

    if (gathering[0].attendance_type !== 'headcount') {
      return res.status(400).json({ error: 'This gathering is not configured for headcount attendance.' });
    }

    // Get or create attendance session
    let sessionId;
    await Database.transaction(async (conn) => {
      let sessionResult = await conn.query(`
        SELECT id FROM attendance_sessions 
        WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?
      `, [gatheringTypeId, date, req.user.church_id]);

      if (sessionResult.length === 0) {
        // Create new session with the specified mode
        const newSession = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id, headcount_mode)
          VALUES (?, ?, ?, ?, ?)
        `, [gatheringTypeId, date, req.user.id, req.user.church_id, mode]);
        sessionId = newSession.insertId;
      } else {
        sessionId = sessionResult[0].id;
        // Update existing session mode
        await conn.query(`
          UPDATE attendance_sessions 
          SET headcount_mode = ? 
          WHERE id = ?
        `, [mode, sessionId]);
      }
    });

    // Broadcast the mode change via WebSocket
    try {
      websocketBroadcast('headcount_mode_updated', {
        gatheringId: parseInt(gatheringTypeId),
        date,
        mode,
        updatedBy: req.user.id,
        updatedByName: `${req.user.first_name} ${req.user.last_name}`,
        timestamp: new Date().toISOString(),
        churchId: req.user.church_id
      });
    } catch (wsError) {
      console.error('WebSocket broadcast error:', wsError);
      // Don't fail the request if WebSocket fails
    }

    res.json({ 
      message: 'Headcount mode updated successfully',
      mode,
      sessionId
    });

  } catch (error) {
    console.error('Update headcount mode error:', error);
    res.status(500).json({ error: 'Failed to update headcount mode.' });
  }
});

// Update another user's headcount (Admin and Coordinator only)
router.post('/headcount/update-user/:gatheringTypeId/:date/:targetUserId', 
  disableCache, 
  requireGatheringAccess, 
  requireRole(['admin', 'coordinator']),
  auditLog('UPDATE_OTHER_USER_HEADCOUNT'), 
  async (req, res) => {
    try {
      const { gatheringTypeId, date, targetUserId } = req.params;
      const { headcount } = req.body;
      
      logger.debugLog('POST /headcount/update-user received', {
        gatheringTypeId,
        date,
        targetUserId,
        headcount,
        updatedBy: req.user.id,
        updatedByRole: req.user.role
      });

      if (typeof headcount !== 'number' || headcount < 0) {
        return res.status(400).json({ error: 'Valid headcount number is required.' });
      }

      // Verify the target user exists and is in the same church
      const targetUser = await Database.query(`
        SELECT id, first_name, last_name, role, church_id 
        FROM users 
        WHERE id = ? AND church_id = ? AND is_active = 1
      `, [targetUserId, req.user.church_id]);

      if (targetUser.length === 0) {
        return res.status(404).json({ error: 'Target user not found or not in your church.' });
      }

      // First, verify this is a headcount gathering
      const gathering = await Database.query(`
        SELECT attendance_type FROM gathering_types 
        WHERE id = ? AND church_id = ?
      `, [gatheringTypeId, req.user.church_id]);

      if (gathering.length === 0) {
        return res.status(404).json({ error: 'Gathering not found.' });
      }

      if (gathering[0].attendance_type !== 'headcount') {
        return res.status(400).json({ error: 'This gathering is not configured for headcount attendance.' });
      }

      let sessionId;
      let sessionMode = 'separate';
      await Database.transaction(async (conn) => {
        // Get or create attendance session
        let sessionResult = await conn.query(`
          SELECT id, headcount_mode FROM attendance_sessions 
          WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?
        `, [gatheringTypeId, date, req.user.church_id]);

        if (sessionResult.length === 0) {
          // Create new session with separate mode
          const newSession = await conn.query(`
            INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id, headcount_mode)
            VALUES (?, ?, ?, ?, ?)
          `, [gatheringTypeId, date, req.user.id, req.user.church_id, 'separate']);
          sessionId = newSession.insertId;
          sessionMode = 'separate';
        } else {
          sessionId = sessionResult[0].id;
          sessionMode = sessionResult[0].headcount_mode || 'separate';
        }

        // Insert or update headcount record for the target user
        await conn.query(`
          INSERT INTO headcount_records (session_id, headcount, updated_by, church_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id, updated_by) DO UPDATE SET
          headcount = excluded.headcount,
          updated_by = excluded.updated_by,
          updated_at = CURRENT_TIMESTAMP
        `, [sessionId, headcount, parseInt(targetUserId), req.user.church_id]);
      });

      // Calculate the display value based on mode
      let displayHeadcount = headcount;
      let displayMode = sessionMode;
      
      if (sessionMode === 'combined') {
        const combinedResult = await Database.query(`
          SELECT SUM(headcount) as total FROM headcount_records 
          WHERE session_id = ?
        `, [sessionId]);
        displayHeadcount = combinedResult[0].total || 0;
      } else if (sessionMode === 'averaged') {
        const avgResult = await Database.query(`
          SELECT AVG(headcount) as average FROM headcount_records 
          WHERE session_id = ?
        `, [sessionId]);
        displayHeadcount = Math.round(avgResult[0].average || 0);
      }

      // Get all users' headcounts for this session for broadcast
      const otherUsersForBroadcast = await Database.query(`
        SELECT h.headcount, h.updated_at, u.first_name, u.last_name, u.id
        FROM headcount_records h
        LEFT JOIN users u ON h.updated_by = u.id
        WHERE h.session_id = ?
        ORDER BY h.updated_at DESC
      `, [sessionId]);

      // Broadcast the update via WebSocket
      try {
        const broadcastData = {
          gatheringId: parseInt(gatheringTypeId),
          date,
          headcount: displayHeadcount,
          userHeadcount: headcount, // The target user's individual headcount
          mode: displayMode,
          updatedBy: parseInt(targetUserId),
          updatedByName: `${targetUser[0].first_name} ${targetUser[0].last_name}`,
          updatedByAdmin: `${req.user.first_name} ${req.user.last_name}`,
          timestamp: new Date().toISOString(),
          churchId: req.user.church_id,
          otherUsers: otherUsersForBroadcast
            .map(user => ({
              userId: user.id,
              name: user.id === req.user.id ? 'You' : `${user.first_name} ${user.last_name}`,
              headcount: user.headcount,
              lastUpdated: user.updated_at,
              isCurrentUser: user.id === req.user.id
            }))
            .sort((a, b) => {
              // Put current user first, then sort others alphabetically
              if (a.isCurrentUser && !b.isCurrentUser) return -1;
              if (!a.isCurrentUser && b.isCurrentUser) return 1;
              if (a.isCurrentUser && b.isCurrentUser) return 0;
              return a.name.localeCompare(b.name);
            })
        };
        
        logger.debugLog('WebSocket broadcast data for user headcount update', {
          headcount: broadcastData.headcount,
          userHeadcount: broadcastData.userHeadcount,
          mode: broadcastData.mode,
          updatedBy: broadcastData.updatedBy,
          updatedByAdmin: broadcastData.updatedByAdmin
        });
        
        websocketBroadcast('headcount_updated', broadcastData);
      } catch (wsError) {
        console.error('WebSocket broadcast error:', wsError);
        // Don't fail the request if WebSocket fails
      }

      res.json({ 
        message: 'User headcount updated successfully',
        headcount: displayHeadcount,
        userHeadcount: headcount,
        mode: displayMode,
        updatedUser: {
          id: parseInt(targetUserId),
          name: `${targetUser[0].first_name} ${targetUser[0].last_name}`
        },
        updatedBy: `${req.user.first_name} ${req.user.last_name}`,
        otherUsers: otherUsersForBroadcast
          .map(user => ({
            userId: user.id,
            name: user.id === req.user.id ? 'You' : `${user.first_name} ${user.last_name}`,
            headcount: user.headcount,
            lastUpdated: user.updated_at,
            isCurrentUser: user.id === req.user.id
          }))
          .sort((a, b) => {
            // Put current user first, then sort others alphabetically
            if (a.isCurrentUser && !b.isCurrentUser) return -1;
            if (!a.isCurrentUser && b.isCurrentUser) return 1;
            if (a.isCurrentUser && b.isCurrentUser) return 0;
            return a.name.localeCompare(b.name);
          })
      });

    } catch (error) {
      console.error('Update user headcount error:', error);
      res.status(500).json({ error: 'Failed to update user headcount.' });
    }
  }
);

// Helper function to get the last N service dates for a gathering type
// If upToDate is provided, only returns services up to and including that date
const getLastNServiceDates = async (gatheringTypeId, churchId, serviceCount, upToDate = null) => {
  try {
    let query = `
      SELECT DISTINCT session_date
      FROM attendance_sessions
      WHERE gathering_type_id = ? AND church_id = ?
        AND excluded_from_stats = 0
    `;
    const params = [gatheringTypeId, churchId];
    
    if (upToDate) {
      query += ` AND session_date <= ?`;
      params.push(upToDate);
    }
    
    query += ` ORDER BY session_date DESC LIMIT ?`;
    params.push(serviceCount);
    
    const serviceDates = await Database.query(query, params);
    
    return serviceDates.map(row => ({ session_date: row.session_date }));
  } catch (error) {
    console.error('Error getting service dates:', error);
    return [];
  }
};

// Helper function to get visitor configuration for a church
const getVisitorConfig = async (churchId) => {
  try {
    const config = await Database.query(
      'SELECT local_visitor_service_limit, traveller_visitor_service_limit FROM visitor_config WHERE church_id = ?',
      [churchId]
    );
    
    if (config.length === 0) {
      // Return defaults if no config exists
      return {
        localVisitorServiceLimit: 6,
        travellerVisitorServiceLimit: 2
      };
    }
    
    return {
      localVisitorServiceLimit: config[0].local_visitor_service_limit,
      travellerVisitorServiceLimit: config[0].traveller_visitor_service_limit
    };
  } catch (error) {
    console.error('Error getting visitor config:', error);
    return {
      localVisitorServiceLimit: 6,
      travellerVisitorServiceLimit: 2
    };
  }
};

/**
 * Get recent visitors: visitors who were marked present in the last N sessions.
 * Local visitors use localVisitorServiceLimit, traveller visitors use travellerVisitorServiceLimit.
 * Returns { visitors: [...], recentlyPresentIds: Set }.
 * This is the single source of truth — used by both the /full endpoint and the standalone recent visitors endpoint.
 */
const getRecentVisitors = async (gatheringTypeId, churchId, date, visitorConfig) => {
  const maxLimit = Math.max(visitorConfig.localVisitorServiceLimit, visitorConfig.travellerVisitorServiceLimit);
  const recentSessionDates = await getLastNServiceDates(gatheringTypeId, churchId, maxLimit, date);

  if (recentSessionDates.length === 0) return { visitors: [], recentlyPresentIds: new Set() };

  const localDates = new Set(recentSessionDates.slice(0, visitorConfig.localVisitorServiceLimit).map(r => r.session_date));
  const travellerDates = new Set(recentSessionDates.slice(0, visitorConfig.travellerVisitorServiceLimit).map(r => r.session_date));

  const allDates = recentSessionDates.map(r => r.session_date);
  const placeholders = allDates.map(() => '?').join(',');

  const rows = await Database.query(`
    SELECT DISTINCT
      i.id, i.first_name, i.last_name, i.people_type, i.is_child,
      f.id as family_id, f.family_name, f.family_notes, f.family_type,
      MAX(s.session_date) as last_present_date
    FROM attendance_records ar
    JOIN attendance_sessions s ON ar.session_id = s.id
    JOIN individuals i ON ar.individual_id = i.id
    JOIN families f ON i.family_id = f.id
    WHERE s.gathering_type_id = ?
      AND s.church_id = ?
      AND s.session_date IN (${placeholders})
      AND ar.present = 1
      AND i.people_type IN ('local_visitor', 'traveller_visitor')
      AND i.is_active = 1
    GROUP BY i.id
    ORDER BY f.family_name, i.is_child, i.first_name
  `, [gatheringTypeId, churchId, ...allDates]);

  const visitors = [];
  const recentlyPresentIds = new Set();
  for (const v of rows) {
    const isLocal = v.people_type === 'local_visitor';
    const relevantDates = isLocal ? localDates : travellerDates;
    if (!relevantDates.has(v.last_present_date)) continue;

    recentlyPresentIds.add(v.id);
    visitors.push({
      id: v.id,
      name: `${v.first_name} ${v.last_name}`,
      isChild: Boolean(v.is_child),
      visitorType: isLocal ? 'potential_regular' : 'temporary_other',
      visitorFamilyGroup: v.family_id.toString(),
      notes: v.family_notes,
      lastAttended: v.last_present_date,
      familyId: v.family_id,
      familyName: v.family_name
    });
  }
  return { visitors, recentlyPresentIds };
};

/**
 * Filter visitors to only show those who were present in the last N sessions.
 * @param {Array} visitors - Array of visitor objects with id, present, peopleType
 * @param {object} options - { recentlyPresentIds }
 * @returns {Array} Filtered visitors
 */
const filterVisitorsByAbsence = (visitors, options) => {
  const { recentlyPresentIds } = options;

  return visitors.filter(visitor => {
    // Always show visitors who are marked present in the current session
    if (visitor.present) return true;
    // Show if they were present in any session within their type's window
    return recentlyPresentIds.has(visitor.id);
  });
};

// Church-wide people (all gatherings, all time) — define BEFORE param routes to avoid shadowing
router.get('/people/all', disableCache, async (req, res) => {
  try {
    const allFamilies = await Database.query(`
      SELECT DISTINCT 
        f.id as family_id,
        f.family_name,
        f.family_notes,
        f.family_type,
        COALESCE(f.last_attended, f.created_at) as last_activity
      FROM families f
      JOIN individuals i ON f.id = i.family_id
      WHERE i.is_active = 1
        AND f.church_id = ?
      GROUP BY f.id
      ORDER BY last_activity DESC, f.family_name
    `, [req.user.church_id]);

    const processedPeople = [];
    for (const family of allFamilies) {
      const familyMembers = await Database.query(`
        SELECT id, first_name, last_name, people_type, is_child
        FROM individuals
        WHERE family_id = ? AND is_active = 1 AND church_id = ?
        ORDER BY first_name
      `, [family.family_id, req.user.church_id]);

      for (const member of familyMembers) {
        const isVisitor = ['local_visitor', 'traveller_visitor'].includes(member.people_type);
        processedPeople.push({
          id: member.id,
          name: `${member.first_name} ${member.last_name}`,
          isChild: Boolean(member.is_child),
          visitorType: isVisitor ? (member.people_type === 'local_visitor' ? 'potential_regular' : 'temporary_other') : 'regular',
          visitorFamilyGroup: family.family_id.toString(),
          notes: family.family_notes,
          lastAttended: family.last_activity,
          familyId: family.family_id,
          familyName: family.family_name
        });
      }
    }

    res.json({ visitors: processedPeople }); // Keep 'visitors' key for compatibility
  } catch (error) {
    console.error('Get all people error:', error);
    res.status(500).json({ error: 'Failed to retrieve all people.' });
  }
});

// Church-wide visitors (all gatherings, all time) — define BEFORE param routes to avoid shadowing
router.get('/visitors/all', disableCache, async (req, res) => {
  try {
    const allVisitorFamilies = await Database.query(`
      SELECT DISTINCT 
        f.id as family_id,
        f.family_name,
        f.family_notes,
        f.family_type,
        COALESCE(f.last_attended, f.created_at) as last_activity
      FROM families f
      JOIN individuals i ON f.id = i.family_id
      WHERE f.family_type IN ('local_visitor', 'traveller_visitor')
        AND i.people_type IN ('local_visitor', 'traveller_visitor')
        AND i.is_active = 1
        AND f.church_id = ?
      GROUP BY f.id
      ORDER BY last_activity DESC, f.family_name
    `, [req.user.church_id]);

    const processedVisitors = [];
    for (const family of allVisitorFamilies) {
      const familyMembers = await Database.query(`
        SELECT id, first_name, last_name, people_type
        FROM individuals 
        WHERE family_id = ? AND is_active = 1 AND church_id = ?
        ORDER BY first_name
      `, [family.family_id, req.user.church_id]);

      for (const member of familyMembers) {
        const isLocal = member.people_type === 'local_visitor';
        processedVisitors.push({
          id: member.id,
          name: `${member.first_name} ${member.last_name}`,
          visitorType: isLocal ? 'potential_regular' : 'temporary_other',
          visitorFamilyGroup: family.family_id.toString(),
          notes: family.family_notes,
          lastAttended: family.last_activity,
          familyId: family.family_id,
          familyName: family.family_name
        });
      }
    }

    res.json({ visitors: processedVisitors });
  } catch (error) {
    console.error('Get all visitors error:', error);
    res.status(500).json({ error: 'Failed to retrieve all visitors.' });
  }
});

// Toggle exclude from stats for a session (Admin and Coordinator only)
router.patch('/sessions/:sessionId/exclude',
  disableCache,
  requireRole(['admin', 'coordinator']),
  async (req, res) => {
    try {
      const { sessionId } = req.params;

      // Find session with church isolation
      const sessions = await Database.query(
        'SELECT id, excluded_from_stats, gathering_type_id, session_date FROM attendance_sessions WHERE id = ? AND church_id = ?',
        [sessionId, req.user.church_id]
      );

      if (sessions.length === 0) {
        return res.status(404).json({ error: 'Session not found.' });
      }

      const session = sessions[0];
      const newValue = session.excluded_from_stats ? 0 : 1;

      await Database.query(
        'UPDATE attendance_sessions SET excluded_from_stats = ? WHERE id = ? AND church_id = ?',
        [newValue, sessionId, req.user.church_id]
      );

      // Broadcast to other connected clients
      const { broadcastSessionExcluded } = require('../utils/websocketBroadcast');
      broadcastSessionExcluded(
        session.gathering_type_id,
        session.session_date,
        req.user.church_id,
        { excludedFromStats: newValue === 1 }
      );

      res.json({
        message: newValue ? 'Session excluded from stats.' : 'Session included in stats.',
        excludedFromStats: newValue === 1,
        sessionId: parseInt(sessionId)
      });
    } catch (error) {
      console.error('Toggle exclude from stats error:', error);
      res.status(500).json({ error: 'Failed to update session.' });
    }
  }
);

// COMBINED ENDPOINT: Get all attendance data in one call (attendance + visitors + recent + all people)
// This optimizes page load by reducing 5 separate API calls to 1
router.get('/:gatheringTypeId/:date/full', disableCache, requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { search } = req.query;

    // We'll reuse the logic from the individual endpoints but execute in parallel where possible
    const results = {};

    try {
      // PARALLEL BATCH 1: Fetch all church people (single JOIN query instead of N+1)
      const allPeoplePromise = (async () => {
        const allMembers = await Database.query(`
          SELECT
            i.id, i.first_name, i.last_name, i.people_type, i.is_child,
            f.id as family_id, f.family_name, f.family_notes, f.family_type,
            COALESCE(f.last_attended, f.created_at) as last_activity
          FROM individuals i
          JOIN families f ON i.family_id = f.id
          WHERE i.is_active = 1
            AND i.church_id = ?
          ORDER BY f.family_name, i.first_name
        `, [req.user.church_id]);

        return allMembers.map(member => {
          const isVisitor = ['local_visitor', 'traveller_visitor'].includes(member.people_type);
          return {
            id: member.id,
            name: `${member.first_name} ${member.last_name}`,
            isChild: Boolean(member.is_child),
            visitorType: isVisitor ? (member.people_type === 'local_visitor' ? 'potential_regular' : 'temporary_other') : 'regular',
            visitorFamilyGroup: member.family_id.toString(),
            notes: member.family_notes,
            lastAttended: member.last_activity,
            familyId: member.family_id,
            familyName: member.family_name
          };
        });
      })();

      // PARALLEL BATCH 2: Fetch recent visitors (doesn't depend on main attendance)
      const recentVisitorsPromise = (async () => {
        const visitorConfig = await getVisitorConfig(req.user.church_id);
        return await getRecentVisitors(gatheringTypeId, req.user.church_id, date, visitorConfig);
      })();

      // Wait for parallel operations
      const [allChurchPeople, recentVisitorsResult] = await Promise.all([
        allPeoplePromise,
        recentVisitorsPromise
      ]);

      results.allChurchPeople = allChurchPeople;
      results.recentVisitors = recentVisitorsResult.visitors;
      results.recentlyPresentIds = recentVisitorsResult.recentlyPresentIds;

    } catch (parallelError) {
      console.error('Error in parallel data fetch:', parallelError);
      // Continue execution - we'll fetch main attendance data next
    }

    // Now fetch main attendance data (this is the bulk of the existing endpoint logic)
    // NOTE: This duplicates the logic from the main GET endpoint below
    // We could refactor to share this code, but for now keeping it inline for clarity

    const thresholdDays = 7; // default weekly
    try {
      const gt = await Database.query('SELECT frequency FROM gathering_types WHERE id = ?', [gatheringTypeId]);
      if (gt && gt.length > 0) {
        const freq = (gt[0].frequency || '').toLowerCase();
        if (freq === 'biweekly') thresholdDays = 14;
        else if (freq === 'monthly') thresholdDays = 31;
      }
    } catch {}

    const thresholdDate = new Date(date);
    thresholdDate.setDate(thresholdDate.getDate() - thresholdDays);
    const thresholdDateStr = thresholdDate.toISOString().split('T')[0];

    // Get attendance session
    const hasSessionsChurchId = await columnExists('attendance_sessions', 'church_id');
    const sessions = hasSessionsChurchId
      ? await Database.query(
          'SELECT id, roster_snapshotted, excluded_from_stats FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
          [gatheringTypeId, date, req.user.church_id]
        )
      : await Database.query(
          'SELECT id, roster_snapshotted, excluded_from_stats FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
          [gatheringTypeId, date]
        );

    let sessionId = null;
    let rosterSnapshotted = false;
    let visitors = [];

    // Reuse recentlyPresentIds from the parallel batch above (avoids duplicate DB call)
    const recentlyPresentIds = results.recentlyPresentIds || new Set();

    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      rosterSnapshotted = sessions[0].roster_snapshotted === 1;

      // Get visitor families (using the fixed query with people_type_at_time)
      // Include both current visitors AND people who were visitors at that time (even if now regular)
      const visitorFamilies = await Database.query(`
        SELECT
          i.id,
          i.first_name,
          i.last_name,
          i.is_child,
          i.last_attendance_date,
          i.created_at as individual_created_at,
          COALESCE(ar.people_type_at_time, i.people_type) as people_type,
          f.id as family_id,
          f.family_name,
          f.family_notes,
          f.family_type,
          f.last_attended,
          COALESCE(ar.present, 0) as present
        FROM individuals i
        JOIN families f ON i.family_id = f.id
        JOIN gathering_lists gl ON gl.individual_id = i.id AND gl.gathering_type_id = ?
        LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
        WHERE (
            f.family_type IN ('local_visitor', 'traveller_visitor')
            OR ar.people_type_at_time IN ('local_visitor', 'traveller_visitor')
          )
          AND i.is_active = 1
          AND (
            COALESCE(ar.people_type_at_time, i.people_type) IN ('local_visitor', 'traveller_visitor')
          )
          AND i.church_id = ?
        ORDER BY f.family_name, i.first_name
      `, [gatheringTypeId, sessionId, req.user.church_id]);

      // Group and format visitors
      const familyGroups = {};
      visitorFamilies.forEach(individual => {
        const familyId = individual.family_id;
        if (!familyGroups[familyId]) {
          familyGroups[familyId] = {
            familyId: familyId,
            familyName: individual.family_name,
            familyNotes: individual.family_notes,
            familyType: individual.family_type,
            lastAttended: individual.last_attended,
            members: []
          };
        }
        
        familyGroups[familyId].members.push({
          id: individual.id,
          name: `${individual.first_name} ${individual.last_name}`,
          firstName: individual.first_name,
          lastName: individual.last_name,
          isChild: Boolean(individual.is_child),
          present: individual.present === 1 || individual.present === true,
          lastAttendanceDate: individual.last_attendance_date,
          createdAt: individual.individual_created_at,
          peopleType: individual.people_type,
          notes: null
        });
      });

      const allVisitors = Object.values(familyGroups).flatMap(family =>
        family.members.map(member => {
          const visitorTypeFromFamily = family.familyType === 'local_visitor' ? 'potential_regular' : 'temporary_other';
          const notesFromFamily = family.familyNotes || '';
          const isTraveller = (member.peopleType === 'traveller_visitor') || (family.familyType === 'traveller_visitor');
          const lastDate = member.lastAttendanceDate ? String(member.lastAttendanceDate).split('T')[0] : null;
          const isInfrequent = isTraveller && lastDate && lastDate < thresholdDateStr;

          return {
            id: member.id,
            name: member.name,
            isChild: member.isChild,
            visitorType: visitorTypeFromFamily,
            visitorStatus: isInfrequent ? 'infrequent' : (isTraveller ? 'traveller' : 'local'),
            visitorFamilyGroup: family.familyId.toString(),
            notes: notesFromFamily || member.notes,
            lastAttended: family.lastAttended,
            familyId: family.familyId,
            familyName: family.familyName,
            present: member.present,
            peopleType: member.peopleType,
            lastAttendanceDate: member.lastAttendanceDate,
            createdAt: member.createdAt
          };
        })
      );

      // Filter to only show visitors who attended within their type's session window
      visitors = filterVisitorsByAbsence(allVisitors, { recentlyPresentIds });
    }

    // Get regular attendance list
    const hasPeopleTypeAtTime = await columnExists('attendance_records', 'people_type_at_time');
    const hasGatheringListsChurchIdFull = await columnExists('gathering_lists', 'church_id');
    const peopleTypeExpression = hasPeopleTypeAtTime
      ? `COALESCE(ar.people_type_at_time, i.people_type) as people_type`
      : `i.people_type`;
    const glChurchFilterFull = hasGatheringListsChurchIdFull ? ` AND (gl.church_id = ? OR gl.church_id IS NULL)` : '';

    let attendanceListQuery = `
      SELECT i.id, i.first_name, i.last_name, i.is_child,
             i.badge_text, i.badge_color, i.badge_icon,
             f.family_name, f.id as family_id,
             f.family_notes,
             COALESCE(ar.present, 0) as present,
             ${peopleTypeExpression},
             f.family_type AS familyType,
             f.last_attended AS lastAttended
      FROM gathering_lists gl
      JOIN individuals i ON gl.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
      WHERE gl.gathering_type_id = ?
        AND i.is_active = 1
        AND i.church_id = ?
        ${glChurchFilterFull}
    `;

    const currentDate = new Date(date);
    const sixWeeksAgo = new Date(currentDate);
    sixWeeksAgo.setDate(sixWeeksAgo.getDate() - 42);

    const twoWeeksAgo = new Date(currentDate);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    let attendanceListParams = [sessionId, gatheringTypeId, req.user.church_id];
    if (hasGatheringListsChurchIdFull) {
      attendanceListParams.push(req.user.church_id);
    }

    // Treat NULL people_type as 'regular' for imported/live data compatibility
    const effectivePeopleTypeFull = hasPeopleTypeAtTime
      ? 'COALESCE(ar.people_type_at_time, i.people_type, \'regular\')'
      : 'COALESCE(i.people_type, \'regular\')';
    if (search && search.trim()) {
      attendanceListQuery += ` AND (
        (f.family_type = 'regular' OR f.family_type IS NULL) AND ${effectivePeopleTypeFull} = 'regular'
      ) AND (
        i.first_name LIKE ? OR
        i.last_name LIKE ? OR
        f.family_name LIKE ?
      )`;
      const searchTerm = `%${search.trim()}%`;
      attendanceListParams.push(searchTerm, searchTerm, searchTerm);
    } else {
      attendanceListQuery += ` AND (
        (f.family_type = 'regular' OR f.family_type IS NULL) AND ${effectivePeopleTypeFull} = 'regular'
      )`;
    }

    attendanceListQuery += ` ORDER BY f.family_name, i.first_name`;

    let attendanceList = await Database.query(attendanceListQuery, attendanceListParams);

    // For legacy (non-snapshotted) sessions, include people with attendance_records
    // but no longer on the gathering list
    if (sessionId && !rosterSnapshotted) {
      const attendanceListIds = new Set(attendanceList.map(a => a.id));
      const orphanedRecords = await Database.query(`
        SELECT i.id, i.first_name, i.last_name, i.is_child,
               i.badge_text, i.badge_color, i.badge_icon,
               f.family_name, f.id as family_id,
               f.family_notes,
               ar.present,
               COALESCE(ar.people_type_at_time, i.people_type) as people_type,
               f.family_type AS familyType,
               f.last_attended AS lastAttended
        FROM attendance_records ar
        JOIN individuals i ON ar.individual_id = i.id
        LEFT JOIN families f ON i.family_id = f.id
        WHERE ar.session_id = ?
          AND ar.church_id = ?
          AND COALESCE(ar.people_type_at_time, i.people_type, 'regular') = 'regular'
          AND (f.family_type = 'regular' OR f.family_type IS NULL)
        ORDER BY i.last_name, i.first_name
      `, [sessionId, req.user.church_id]);

      for (const record of orphanedRecords) {
        if (!attendanceListIds.has(record.id)) {
          attendanceList.push(record);
        }
      }
      attendanceList.sort((a, b) => {
        const lastCmp = (a.family_name || '').localeCompare(b.family_name || '');
        return lastCmp !== 0 ? lastCmp : (a.first_name || '').localeCompare(b.first_name || '');
      });
    }

    // Get potential visitors (people who haven't been for a while)
    const potentialVisitors = await Database.query(`
      SELECT DISTINCT
        i.id,
        i.first_name,
        i.last_name,
        i.people_type,
        i.last_attendance_date,
        i.created_at as individual_created_at,
        f.id as family_id,
        f.family_name,
        f.family_notes,
        f.family_type,
        f.last_attended,
        CASE
          WHEN i.last_attendance_date IS NULL THEN 0
          WHEN i.last_attendance_date < ? THEN 0
          WHEN i.last_attendance_date >= ? THEN 1
          ELSE 0
        END as within_absence_limit
      FROM individuals i
      JOIN families f ON i.family_id = f.id
      WHERE i.people_type IN ('local_visitor', 'traveller_visitor')
        AND f.family_type IN ('local_visitor', 'traveller_visitor')
        AND i.is_active = 1
        AND i.church_id = ?
      ORDER BY f.family_name, i.first_name
    `, [sixWeeksAgo.toISOString().split('T')[0], twoWeeksAgo.toISOString().split('T')[0], req.user.church_id]);

    // Filter potential visitors: only show those present in recent sessions
    const filteredPotentialVisitors = potentialVisitors.filter(visitor => {
      return recentlyPresentIds.has(visitor.id);
    });

    // Format and return combined response
    const responseData = processApiResponse({
      sessionId: sessionId,
      excludedFromStats: sessions.length > 0 ? (sessions[0].excluded_from_stats === 1) : false,
      attendanceList: attendanceList.map(attendee => ({
        ...attendee,
        present: attendee.present === 1 || attendee.present === true,
        isChild: Boolean(attendee.is_child),
        badgeText: attendee.badge_text || null,
        badgeColor: attendee.badge_color || null,
        badgeIcon: attendee.badge_icon || null,
        familyNotes: attendee.family_notes || null,
        peopleType: attendee.people_type,
        lastAttended: attendee.last_attended
      })),
      visitors,
      potentialVisitors: filteredPotentialVisitors.map(visitor => ({
        ...visitor,
        withinAbsenceLimit: visitor.within_absence_limit === 1 || visitor.within_absence_limit === true
      })),
      recentVisitors: results.recentVisitors || [],
      allChurchPeople: results.allChurchPeople || []
    });

    res.json(responseData);
  } catch (error) {
    console.error('Get full attendance data error:', error);
    res.status(500).json({ error: 'Failed to retrieve full attendance data.' });
  }
});

// Get attendance for a specific date and gathering
router.get('/:gatheringTypeId/:date', disableCache, requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { search } = req.query; // Add search parameter
    
    // Determine gathering frequency to compute an "infrequent" threshold
    let thresholdDays = 7; // default weekly
    try {
      const gt = await Database.query('SELECT frequency FROM gathering_types WHERE id = ?', [gatheringTypeId]);
      if (gt && gt.length > 0) {
        const freq = (gt[0].frequency || '').toLowerCase();
        if (freq === 'biweekly') thresholdDays = 14;
        else if (freq === 'monthly') thresholdDays = 31;
        else thresholdDays = 7;
      }
    } catch {}
    const thresholdDate = new Date(date);
    thresholdDate.setDate(thresholdDate.getDate() - thresholdDays);
    const thresholdDateStr = thresholdDate.toISOString().split('T')[0];

    // Get attendance session (support schemas with/without church_id)
    const hasSessionsChurchId = await columnExists('attendance_sessions', 'church_id');
    const sessions = hasSessionsChurchId
      ? await Database.query(
          'SELECT id, roster_snapshotted, excluded_from_stats FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
          [gatheringTypeId, date, req.user.church_id]
        )
      : await Database.query(
          'SELECT id, roster_snapshotted, excluded_from_stats FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
          [gatheringTypeId, date]
        );

    let sessionId = null;
    let rosterSnapshotted = false;
    let visitors = [];

    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      rosterSnapshotted = sessions[0].roster_snapshotted === 1;
    }

    // Get visitor configuration for filtering
    const visitorConfig = await getVisitorConfig(req.user.church_id);
    const { recentlyPresentIds } = await getRecentVisitors(gatheringTypeId, req.user.church_id, date, visitorConfig);

    // ===== PATH A: Snapshotted session — use attendance_records as source of truth =====
    if (rosterSnapshotted && sessionId) {
      // Regular attendees from the snapshot (not current gathering list)
      // No is_active filter — show archived people who were on the historical roster
      let snapshotAttendanceQuery = `
        SELECT i.id, i.first_name, i.last_name, i.is_child,
               i.badge_text, i.badge_color, i.badge_icon,
               f.family_name, f.id as family_id,
               f.family_notes,
               ar.present,
               COALESCE(ar.people_type_at_time, i.people_type) as people_type,
               f.family_type AS familyType,
               f.last_attended AS lastAttended,
               i.is_active
        FROM attendance_records ar
        JOIN individuals i ON ar.individual_id = i.id
        LEFT JOIN families f ON i.family_id = f.id
        WHERE ar.session_id = ?
          AND ar.church_id = ?
          AND COALESCE(ar.people_type_at_time, i.people_type, 'regular') = 'regular'
          AND (f.family_type = 'regular' OR f.family_type IS NULL)
      `;
      let snapshotAttendanceParams = [sessionId, req.user.church_id];

      if (search && search.trim()) {
        snapshotAttendanceQuery += ` AND (
          i.first_name LIKE ? OR
          i.last_name LIKE ? OR
          f.family_name LIKE ?
        )`;
        const searchTerm = `%${search.trim()}%`;
        snapshotAttendanceParams.push(searchTerm, searchTerm, searchTerm);
      }

      snapshotAttendanceQuery += ` ORDER BY i.last_name, i.first_name`;
      const attendanceList = await Database.query(snapshotAttendanceQuery, snapshotAttendanceParams);

      // Visitor families from the snapshot
      const snapshotVisitorFamilies = await Database.query(`
        SELECT
          i.id,
          i.first_name,
          i.last_name,
          i.is_child,
          i.last_attendance_date,
          i.created_at as individual_created_at,
          COALESCE(ar.people_type_at_time, i.people_type) as people_type,
          f.id as family_id,
          f.family_name,
          f.family_notes,
          f.family_type,
          f.last_attended,
          ar.present,
          i.is_active
        FROM attendance_records ar
        JOIN individuals i ON ar.individual_id = i.id
        JOIN families f ON i.family_id = f.id
        WHERE ar.session_id = ?
          AND ar.church_id = ?
          AND COALESCE(ar.people_type_at_time, i.people_type) IN ('local_visitor', 'traveller_visitor')
        ORDER BY f.family_name, i.first_name
      `, [sessionId, req.user.church_id]);

      // Group visitor families and format
      const familyGroups = {};
      snapshotVisitorFamilies.forEach(individual => {
        const familyId = individual.family_id;
        if (!familyGroups[familyId]) {
          familyGroups[familyId] = {
            familyId: familyId,
            familyName: individual.family_name,
            familyNotes: individual.family_notes,
            familyType: individual.family_type,
            lastAttended: individual.last_attended,
            members: []
          };
        }
        familyGroups[familyId].members.push({
          id: individual.id,
          name: `${individual.first_name} ${individual.last_name}`,
          firstName: individual.first_name,
          lastName: individual.last_name,
          isChild: Boolean(individual.is_child),
          present: individual.present === 1 || individual.present === true,
          lastAttendanceDate: individual.last_attendance_date,
          createdAt: individual.individual_created_at,
          peopleType: individual.people_type,
          notes: null
        });
      });

      const allSnapshotVisitors = Object.values(familyGroups).flatMap(family =>
        family.members.map(member => {
          const visitorTypeFromFamily = family.familyType === 'local_visitor' ? 'potential_regular' : 'temporary_other';
          const notesFromFamily = family.familyNotes || '';
          const isTraveller = (member.peopleType === 'traveller_visitor') || (family.familyType === 'traveller_visitor');
          const lastDate = member.lastAttendanceDate ? String(member.lastAttendanceDate).split('T')[0] : null;
          const isInfrequent = isTraveller && lastDate && lastDate < thresholdDateStr;
          return {
            id: member.id,
            name: member.name,
            isChild: member.isChild,
            visitorType: visitorTypeFromFamily,
            visitorStatus: isInfrequent ? 'infrequent' : (isTraveller ? 'traveller' : 'local'),
            visitorFamilyGroup: family.familyId.toString(),
            notes: notesFromFamily || member.notes,
            lastAttended: family.lastAttended,
            familyId: family.familyId,
            familyName: family.familyName,
            present: member.present,
            peopleType: member.peopleType,
            lastAttendanceDate: member.lastAttendanceDate,
            createdAt: member.createdAt
          };
        })
      );

      // Filter to only show visitors who attended within their type's session window
      visitors = filterVisitorsByAbsence(allSnapshotVisitors, { recentlyPresentIds });

      const responseData = processApiResponse({
        sessionId: sessionId,
        excludedFromStats: sessions.length > 0 ? (sessions[0].excluded_from_stats === 1) : false,
        attendanceList: attendanceList.map(attendee => ({
          ...attendee,
          present: attendee.present === 1 || attendee.present === true,
          isChild: Boolean(attendee.is_child),
          badgeText: attendee.badge_text || null,
          badgeColor: attendee.badge_color || null,
          badgeIcon: attendee.badge_icon || null,
          familyNotes: attendee.family_notes || null,
          peopleType: attendee.people_type,
          lastAttended: attendee.last_attended,
          isActive: attendee.is_active === 1
        })),
        visitors,
        potentialVisitors: []
      });

      return res.json(responseData);
    }

    // ===== PATH B: No snapshot (new/future sessions, or legacy sessions) — use gathering_lists =====

    if (sessionId) {
      // Get visitor families for this session limited to the active gathering (via gathering_lists)
      // Use people_type_at_time to show historical visitor records even if type has changed
      const visitorFamilies = await Database.query(`
        SELECT
          i.id,
          i.first_name,
          i.last_name,
          i.is_child,
          i.last_attendance_date,
          i.created_at as individual_created_at,
          COALESCE(ar.people_type_at_time, i.people_type) as people_type,
          f.id as family_id,
          f.family_name,
          f.family_notes,
          f.family_type,
          f.last_attended,
          COALESCE(ar.present, 0) as present
        FROM individuals i
        JOIN families f ON i.family_id = f.id
        JOIN gathering_lists gl ON gl.individual_id = i.id AND gl.gathering_type_id = ?
        LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
        WHERE f.family_type IN ('local_visitor', 'traveller_visitor')
          AND i.is_active = 1
          AND (
            COALESCE(ar.people_type_at_time, i.people_type) IN ('local_visitor', 'traveller_visitor')
          )
          AND i.church_id = ?
        ORDER BY f.family_name, i.first_name
      `, [gatheringTypeId, sessionId, req.user.church_id]);

      // Group by family and format for frontend
      const familyGroups = {};
      visitorFamilies.forEach(individual => {
        const familyId = individual.family_id;
        if (!familyGroups[familyId]) {
          familyGroups[familyId] = {
            familyId: familyId,
            familyName: individual.family_name,
            familyNotes: individual.family_notes,
            familyType: individual.family_type,
            lastAttended: individual.last_attended,
            members: []
          };
        }

        familyGroups[familyId].members.push({
          id: individual.id,
          name: `${individual.first_name} ${individual.last_name}`,
          firstName: individual.first_name,
          lastName: individual.last_name,
          isChild: Boolean(individual.is_child),
          present: individual.present === 1 || individual.present === true,
          lastAttendanceDate: individual.last_attendance_date,
          createdAt: individual.individual_created_at,
          peopleType: individual.people_type,
          notes: null
        });
      });

      // Convert to flat list for backward compatibility
      const allVisitors = Object.values(familyGroups).flatMap(family =>
        family.members.map(member => {
          const visitorTypeFromFamily = family.familyType === 'local_visitor' ? 'potential_regular' : 'temporary_other';
          const notesFromFamily = family.familyNotes || '';
          const isTraveller = (member.peopleType === 'traveller_visitor') || (family.familyType === 'traveller_visitor');
          const lastDate = member.lastAttendanceDate ? String(member.lastAttendanceDate).split('T')[0] : null;
          const isInfrequent = isTraveller && lastDate && lastDate < thresholdDateStr;

          return {
            id: member.id,
            name: member.name,
            isChild: member.isChild,
            visitorType: visitorTypeFromFamily,
            visitorStatus: isInfrequent ? 'infrequent' : (isTraveller ? 'traveller' : 'local'),
            visitorFamilyGroup: family.familyId.toString(),
            notes: notesFromFamily || member.notes,
            lastAttended: family.lastAttended,
            familyId: family.familyId,
            familyName: family.familyName,
            present: member.present,
            peopleType: member.peopleType,
            lastAttendanceDate: member.lastAttendanceDate,
            createdAt: member.createdAt
          };
        })
      );

      // For legacy (non-snapshotted) sessions, also include visitor records from
      // attendance_records for people no longer on the gathering list
      if (!rosterSnapshotted) {
        const existingVisitorIds = new Set(allVisitors.map(v => v.id));
        const orphanedVisitorFamilies = await Database.query(`
          SELECT
            i.id,
            i.first_name,
            i.last_name,
            i.is_child,
            i.last_attendance_date,
            i.created_at as individual_created_at,
            COALESCE(ar.people_type_at_time, i.people_type) as people_type,
            f.id as family_id,
            f.family_name,
            f.family_notes,
            f.family_type,
            f.last_attended,
            ar.present
          FROM attendance_records ar
          JOIN individuals i ON ar.individual_id = i.id
          JOIN families f ON i.family_id = f.id
          WHERE ar.session_id = ?
            AND ar.church_id = ?
            AND COALESCE(ar.people_type_at_time, i.people_type) IN ('local_visitor', 'traveller_visitor')
          ORDER BY f.family_name, i.first_name
        `, [sessionId, req.user.church_id]);

        for (const individual of orphanedVisitorFamilies) {
          if (existingVisitorIds.has(individual.id)) continue;
          existingVisitorIds.add(individual.id);

          const familyId = individual.family_id;
          if (!familyGroups[familyId]) {
            familyGroups[familyId] = {
              familyId: familyId,
              familyName: individual.family_name,
              familyNotes: individual.family_notes,
              familyType: individual.family_type,
              lastAttended: individual.last_attended,
              members: []
            };
          }
          familyGroups[familyId].members.push({
            id: individual.id,
            name: `${individual.first_name} ${individual.last_name}`,
            firstName: individual.first_name,
            lastName: individual.last_name,
            isChild: Boolean(individual.is_child),
            present: individual.present === 1 || individual.present === true,
            lastAttendanceDate: individual.last_attendance_date,
            createdAt: individual.individual_created_at,
            peopleType: individual.people_type,
            notes: null
          });

          const visitorTypeFromFamily = individual.family_type === 'local_visitor' ? 'potential_regular' : 'temporary_other';
          const isTraveller = (individual.people_type === 'traveller_visitor') || (individual.family_type === 'traveller_visitor');
          const lastDate = individual.last_attendance_date ? String(individual.last_attendance_date).split('T')[0] : null;
          const isInfrequent = isTraveller && lastDate && lastDate < thresholdDateStr;
          allVisitors.push({
            id: individual.id,
            name: `${individual.first_name} ${individual.last_name}`,
            isChild: Boolean(individual.is_child),
            visitorType: visitorTypeFromFamily,
            visitorStatus: isInfrequent ? 'infrequent' : (isTraveller ? 'traveller' : 'local'),
            visitorFamilyGroup: familyId.toString(),
            notes: individual.family_notes || null,
            lastAttended: individual.last_attended,
            familyId: familyId,
            familyName: individual.family_name,
            present: individual.present === 1 || individual.present === true,
            peopleType: individual.people_type,
            lastAttendanceDate: individual.last_attendance_date,
            createdAt: individual.individual_created_at
          });
        }
      }

      // Filter to only show visitors who attended within their type's session window
      visitors = filterVisitorsByAbsence(allVisitors, { recentlyPresentIds });
    }

    // Get regular attendees and visitor families with attendance status
    // Check if people_type_at_time column exists for historical type support
    const hasPeopleTypeAtTime = await columnExists('attendance_records', 'people_type_at_time');
    const hasGatheringListsChurchId = await columnExists('gathering_lists', 'church_id');

    // Use historical people_type if available, otherwise fall back to current type
    const peopleTypeExpression = hasPeopleTypeAtTime
      ? `COALESCE(ar.people_type_at_time, i.people_type) as people_type`
      : `i.people_type`;

    // Regular attendees: on gathering list, not visitors. Include gl.church_id filter when column exists for multi-tenant isolation.
    const glChurchFilter = hasGatheringListsChurchId ? ` AND (gl.church_id = ? OR gl.church_id IS NULL)` : '';
    let attendanceListQuery = `
      SELECT i.id, i.first_name, i.last_name, i.is_child,
             i.badge_text, i.badge_color, i.badge_icon,
             f.family_name, f.id as family_id,
             f.family_notes,
             COALESCE(ar.present, 0) as present,
             ${peopleTypeExpression},
             f.family_type AS familyType,
             f.last_attended AS lastAttended
      FROM gathering_lists gl
      JOIN individuals i ON gl.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
      WHERE gl.gathering_type_id = ?
        AND i.is_active = 1
        AND i.church_id = ?
        ${glChurchFilter}
    `;

    // Calculate date ranges for filtering
    const currentDate = new Date(date);
    const sixWeeksAgo = new Date(currentDate);
    sixWeeksAgo.setDate(sixWeeksAgo.getDate() - 42); // 6 weeks = 42 days

    const twoWeeksAgo = new Date(currentDate);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14); // 2 weeks = 14 days

    let attendanceListParams = [sessionId, gatheringTypeId, req.user.church_id];
    if (hasGatheringListsChurchId) {
      attendanceListParams.push(req.user.church_id);
    }

    // Add filtering logic - use historical people_type for filtering
    // For future dates (no attendance records), check current people_type
    // For past dates, use historical type if available
    if (search && search.trim()) {
      // When searching, only include regular attendees (exclude visitor families)
      // Treat NULL people_type as 'regular' for imported/live data compatibility
      const effectivePeopleType = hasPeopleTypeAtTime
        ? 'COALESCE(ar.people_type_at_time, i.people_type, \'regular\')'
        : 'COALESCE(i.people_type, \'regular\')';
      attendanceListQuery += ` AND (
        (f.family_type = 'regular' OR f.family_type IS NULL) AND ${effectivePeopleType} = 'regular'
      ) AND (
        i.first_name LIKE ? OR
        i.last_name LIKE ? OR
        f.family_name LIKE ?
      )`;
      const searchTerm = `%${search.trim()}%`;
      attendanceListParams.push(searchTerm, searchTerm, searchTerm);
    } else {
      // When not searching, filter to only include regular attendees (exclude visitor families)
      // Include regular families and individuals without families (but not visitors)
      // Use historical type if available. Treat NULL people_type as 'regular' (common in imported/live data).
      const effectivePeopleType = hasPeopleTypeAtTime
        ? 'COALESCE(ar.people_type_at_time, i.people_type, \'regular\')'
        : 'COALESCE(i.people_type, \'regular\')';
      attendanceListQuery += ` AND (
        (f.family_type = 'regular' OR f.family_type IS NULL) AND ${effectivePeopleType} = 'regular'
      )`;
    }

    attendanceListQuery += ` ORDER BY i.last_name, i.first_name`;

    let attendanceList = await Database.query(attendanceListQuery, attendanceListParams);

    // For legacy (non-snapshotted) sessions with existing records, also include people who
    // have attendance_records but are no longer on the gathering list (e.g., removed from roster)
    if (sessionId && !rosterSnapshotted) {
      const attendanceListIds = new Set(attendanceList.map(a => a.id));
      const orphanedRecords = await Database.query(`
        SELECT i.id, i.first_name, i.last_name, i.is_child,
               i.badge_text, i.badge_color, i.badge_icon,
               f.family_name, f.id as family_id,
               f.family_notes,
               ar.present,
               COALESCE(ar.people_type_at_time, i.people_type) as people_type,
               f.family_type AS familyType,
               f.last_attended AS lastAttended
        FROM attendance_records ar
        JOIN individuals i ON ar.individual_id = i.id
        LEFT JOIN families f ON i.family_id = f.id
        WHERE ar.session_id = ?
          AND ar.church_id = ?
          AND COALESCE(ar.people_type_at_time, i.people_type, 'regular') = 'regular'
          AND (f.family_type = 'regular' OR f.family_type IS NULL)
        ORDER BY i.last_name, i.first_name
      `, [sessionId, req.user.church_id]);

      for (const record of orphanedRecords) {
        if (!attendanceListIds.has(record.id)) {
          attendanceList.push(record);
        }
      }
      // Re-sort after merging
      attendanceList.sort((a, b) => {
        const lastCmp = (a.last_name || '').localeCompare(b.last_name || '');
        return lastCmp !== 0 ? lastCmp : (a.first_name || '').localeCompare(b.first_name || '');
      });
    }

    // Get potential visitor attendees based on service-based filtering
    // (visitor config and service dates already fetched above for reuse)

    // Build the visitor query using service-based filtering
    // Use historical people_type if available
    const visitorPeopleTypeExpression = hasPeopleTypeAtTime
      ? `COALESCE(ar.people_type_at_time, i.people_type) as people_type`
      : `i.people_type`;

    let visitorQuery = `
      SELECT DISTINCT
        i.first_name || ' ' || i.last_name as name,
        CASE WHEN ${hasPeopleTypeAtTime ? 'COALESCE(ar.people_type_at_time, i.people_type)' : 'i.people_type'} = 'local_visitor' THEN 'potential_regular' ELSE 'temporary_other' END as visitor_type,
        f.id as visitor_family_group,
        f.family_notes as notes,
        i.last_attendance_date as last_attended,
        i.created_at as individual_created_at,
        f.family_name,
        f.id as family_id,
        i.id,
        ${visitorPeopleTypeExpression},
        i.is_active
      FROM individuals i
      JOIN families f ON i.family_id = f.id
      JOIN gathering_lists gl ON i.id = gl.individual_id AND gl.gathering_type_id = ?
      LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
      WHERE ${hasPeopleTypeAtTime
        ? `(COALESCE(ar.people_type_at_time, i.people_type) IN ('local_visitor', 'traveller_visitor') OR (ar.people_type_at_time IS NULL AND i.people_type IN ('local_visitor', 'traveller_visitor')))`
        : `i.people_type IN ('local_visitor', 'traveller_visitor')`}
        AND (i.is_active = 1 OR ar.present = 1 OR ar.present = 1)
        AND f.family_type IN ('local_visitor', 'traveller_visitor')
        AND i.church_id = ?
    `;

    let visitorParams = [gatheringTypeId, sessionId, req.user.church_id];

    // Add search filter if provided
    if (search && search.trim()) {
      visitorQuery += ` AND (i.first_name || ' ' || i.last_name LIKE ? OR f.family_name LIKE ?)`;
      const searchTerm = `%${search.trim()}%`;
      visitorParams.push(searchTerm, searchTerm);
    }

    visitorQuery += ` ORDER BY i.last_attendance_date DESC, f.family_name`;

    let allPotentialVisitors = await Database.query(visitorQuery, visitorParams);

    // For legacy (non-snapshotted) sessions, also include visitors with attendance_records
    // but no longer on the gathering list
    if (sessionId && !rosterSnapshotted) {
      const existingVisitorIds = new Set(allPotentialVisitors.map(v => v.id));
      const orphanedVisitors = await Database.query(`
        SELECT DISTINCT
          i.first_name || ' ' || i.last_name as name,
          CASE WHEN COALESCE(ar.people_type_at_time, i.people_type) = 'local_visitor' THEN 'potential_regular' ELSE 'temporary_other' END as visitor_type,
          f.id as visitor_family_group,
          f.family_notes as notes,
          i.last_attendance_date as last_attended,
          i.created_at as individual_created_at,
          f.family_name,
          f.id as family_id,
          i.id,
          COALESCE(ar.people_type_at_time, i.people_type) as people_type,
          i.is_active
        FROM attendance_records ar
        JOIN individuals i ON ar.individual_id = i.id
        JOIN families f ON i.family_id = f.id
        WHERE ar.session_id = ?
          AND ar.church_id = ?
          AND COALESCE(ar.people_type_at_time, i.people_type) IN ('local_visitor', 'traveller_visitor')
        ORDER BY i.last_attendance_date DESC, f.family_name
      `, [sessionId, req.user.church_id]);

      for (const visitor of orphanedVisitors) {
        if (!existingVisitorIds.has(visitor.id)) {
          allPotentialVisitors.push(visitor);
        }
      }
    }

    // Filter visitors based on recent presence (not when searching)
    const potentialVisitors = search && search.trim() ?
      allPotentialVisitors :
      allPotentialVisitors.filter(visitor => {
        const currentDate = new Date(date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const isPastGathering = currentDate < today;

        // For archived visitors: only show them if they have attendance records for past gatherings
        if (visitor.is_active === false || visitor.is_active === 0) {
          if (isPastGathering) {
            return visitor.present === 1 || visitor.present === true;
          }
          return false;
        }

        // Show if marked present in current session or present in recent sessions
        if (visitor.present === 1 || visitor.present === true) return true;
        return recentlyPresentIds.has(visitor.id);
      });

    // Use systematic conversion utility to handle BigInt and snake_case to camelCase conversion
    const responseData = processApiResponse({
      attendanceList: attendanceList.map(attendee => ({
        ...attendee,
        present: attendee.present === 1 || attendee.present === true,
        isChild: Boolean(attendee.is_child),
        badgeText: attendee.badge_text || null,
        badgeColor: attendee.badge_color || null,
        badgeIcon: attendee.badge_icon || null,
        familyNotes: attendee.family_notes || null,
        peopleType: attendee.people_type,
        lastAttended: attendee.last_attended
      })),
      visitors,
      potentialVisitors: potentialVisitors.map(visitor => ({
        ...visitor,
        withinAbsenceLimit: visitor.within_absence_limit === 1 || visitor.within_absence_limit === true
      }))
    });

    res.json(responseData);
  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ error: 'Failed to retrieve attendance.' });
  }
});

// Record attendance
router.post('/:gatheringTypeId/:date', disableCache, requireGatheringAccess, auditLog('RECORD_ATTENDANCE'), async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { attendanceRecords, visitors, clientTimeOffset = 0 } = req.body;

    logger.debugLog('GENERIC ROUTE MATCHED', {
      path: req.path,
      gatheringTypeId,
      date,
      body: req.body
    });

    logger.debugLog('Recording attendance', { gatheringTypeId, date, attendanceRecords, visitors });

    // Track skipped records for conflict detection
    const skippedRecords = [];

    await Database.transaction(async (conn) => {
      const hasSessionsChurchId = await columnExists('attendance_sessions', 'church_id');
      const hasIndividualsChurchId = await columnExists('individuals', 'church_id');
      const hasAttendanceRecordsChurchId = await columnExists('attendance_records', 'church_id');
      // Create or get attendance session
      let sessionResult;
      if (hasSessionsChurchId) {
        sessionResult = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(gathering_type_id, session_date, church_id) DO UPDATE SET updated_at = datetime('now')
        `, [gatheringTypeId, date, req.user.id, req.user.church_id]);
      } else {
        sessionResult = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
          VALUES (?, ?, ?)
          ON CONFLICT(gathering_type_id, session_date, church_id) DO UPDATE SET updated_at = datetime('now')
        `, [gatheringTypeId, date, req.user.id]);
      }

      logger.debugLog('Session result', sessionResult);

      // Always SELECT the session ID after UPSERT — lastInsertRowid is unreliable
      // when ON CONFLICT DO UPDATE fires (it returns a stale value from a prior INSERT)
      const sessions1 = hasSessionsChurchId
        ? await conn.query(
            'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
            [gatheringTypeId, date, req.user.church_id]
          )
        : await conn.query(
            'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
            [gatheringTypeId, date]
          );
      if (sessions1.length === 0) {
        throw new Error('Failed to create or retrieve attendance session');
      }
      const sessionId = Number(sessions1[0].id);

      logger.debugLog('Session ID', sessionId);

      // Snapshot roster when any record is being marked present
      if (attendanceRecords && attendanceRecords.some(r => r.present)) {
        await createRosterSnapshot(conn, sessionId, gatheringTypeId, req.user.church_id, date);
      }

      // Update individual attendance records with timestamp-based conflict detection
      if (attendanceRecords && attendanceRecords.length > 0) {
        // Check if people_type_at_time column exists
        const hasPeopleTypeAtTime = await columnExists('attendance_records', 'people_type_at_time');

        for (const record of attendanceRecords) {
          // Get client timestamp (with offset applied on client side already, or default to now)
          const clientTimestamp = record.clientTimestamp ? new Date(record.clientTimestamp) : new Date();

          // Check if record already exists and get its last update time
          const existingRecords = hasAttendanceRecordsChurchId
            ? await conn.query(`
                SELECT updated_at, present, updated_by
                FROM attendance_records
                WHERE session_id = ? AND individual_id = ? AND church_id = ?
              `, [sessionId, record.individualId, req.user.church_id])
            : await conn.query(`
                SELECT updated_at, present, updated_by
                FROM attendance_records
                WHERE session_id = ? AND individual_id = ?
              `, [sessionId, record.individualId]);

          // Conflict detection: skip update if existing record is newer
          if (existingRecords.length > 0) {
            const existingRecord = existingRecords[0];
            const serverTimestamp = new Date(existingRecord.updated_at);

            // If server record is newer than client's change, skip this update
            if (serverTimestamp > clientTimestamp) {
              logger.debugLog('Skipping stale update', {
                individualId: record.individualId,
                clientTime: clientTimestamp,
                serverTime: serverTimestamp,
                clientValue: record.present,
                serverValue: existingRecord.present
              });
              skippedRecords.push({
                individualId: record.individualId,
                reason: 'stale_data',
                serverValue: existingRecord.present,
                clientValue: record.present,
                serverTimestamp: serverTimestamp,
                clientTimestamp: clientTimestamp
              });
              continue; // Skip this record
            }
          }

          // Fetch current people_type to store as historical type
          let peopleTypeAtTime = null;
          if (hasPeopleTypeAtTime) {
            const individualResult = hasIndividualsChurchId
              ? await conn.query(`
                  SELECT people_type FROM individuals WHERE id = ? AND church_id = ?
                `, [record.individualId, req.user.church_id])
              : await conn.query(`
                  SELECT people_type FROM individuals WHERE id = ?
                `, [record.individualId]);

            if (individualResult.length > 0 && individualResult[0].people_type) {
              peopleTypeAtTime = individualResult[0].people_type;
            }
          }

          // Use INSERT ... ON CONFLICT DO UPDATE SET with timestamp and user tracking
          if (hasAttendanceRecordsChurchId) {
            if (hasPeopleTypeAtTime && peopleTypeAtTime) {
              await conn.query(`
                INSERT INTO attendance_records (session_id, individual_id, present, church_id, people_type_at_time, updated_by)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id, individual_id) DO UPDATE SET
                  present = excluded.present,
                  people_type_at_time = excluded.people_type_at_time,
                  updated_by = excluded.updated_by,
                  updated_at = CURRENT_TIMESTAMP
              `, [sessionId, record.individualId, record.present, req.user.church_id, peopleTypeAtTime, req.user.id]);
            } else {
              await conn.query(`
                INSERT INTO attendance_records (session_id, individual_id, present, church_id, updated_by)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(session_id, individual_id) DO UPDATE SET
                  present = excluded.present,
                  updated_by = excluded.updated_by,
                  updated_at = CURRENT_TIMESTAMP
              `, [sessionId, record.individualId, record.present, req.user.church_id, req.user.id]);
            }
          } else {
            if (hasPeopleTypeAtTime && peopleTypeAtTime) {
              await conn.query(`
                INSERT INTO attendance_records (session_id, individual_id, present, people_type_at_time, updated_by)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(session_id, individual_id) DO UPDATE SET
                  present = excluded.present,
                  people_type_at_time = excluded.people_type_at_time,
                  updated_by = excluded.updated_by,
                  updated_at = CURRENT_TIMESTAMP
              `, [sessionId, record.individualId, record.present, peopleTypeAtTime, req.user.id]);
            } else {
              await conn.query(`
                INSERT INTO attendance_records (session_id, individual_id, present, updated_by)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(session_id, individual_id) DO UPDATE SET
                  present = excluded.present,
                  updated_by = excluded.updated_by,
                  updated_at = CURRENT_TIMESTAMP
              `, [sessionId, record.individualId, record.present, req.user.id]);
            }
          }

          // Update last_attendance_date if person is marked present
          if (record.present) {
            if (hasIndividualsChurchId) {
              await conn.query(`
                UPDATE individuals
                SET last_attendance_date = ?
                WHERE id = ? AND church_id = ?
              `, [date, record.individualId, req.user.church_id]);
            } else {
              await conn.query(`
                UPDATE individuals
                SET last_attendance_date = ?
                WHERE id = ?
              `, [date, record.individualId]);
            }
          }
        }
        logger.debugLog('Updated attendance records for session', sessionId);
        if (skippedRecords.length > 0) {
          logger.debugLog('Skipped stale records', { count: skippedRecords.length, records: skippedRecords });
        }
      } else {
        logger.debugLog('No attendance records to update');
      }

      // CRITICAL FIX: Do NOT manage visitors in the regular attendance endpoint
      // Visitors should only be managed through dedicated visitor endpoints:
      // - POST /:gatheringTypeId/:date/visitors (add visitors)
      // - PUT /:gatheringTypeId/:date/visitors/:visitorId (update visitors)
      // This prevents accidental deletion of visitors when updating regular attendance
      
      logger.debugLog('Regular attendance update - preserving existing visitors');
    });

    // Trigger notifications (moved outside transaction to avoid scope issues)
    try {
      const { triggerAttendanceNotifications } = require('../utils/attendanceNotifications');
      await triggerAttendanceNotifications(gatheringTypeId, date);
    } catch (notificationError) {
      console.error('Error triggering notifications:', notificationError);
      // Don't fail the attendance save if notifications fail
    }

    // Broadcast WebSocket update for real-time attendance changes
    try {
      if (attendanceRecords && attendanceRecords.length > 0) {
        websocketBroadcast.broadcastAttendanceRecords(
          gatheringTypeId, 
          date, 
          req.user.church_id, 
          attendanceRecords,
          { updatedBy: req.user.id, updatedAt: new Date().toISOString() }
        );
        logger.debugLog('Broadcasted attendance update via WebSocket');
      }
    } catch (broadcastError) {
      console.error('Error broadcasting attendance update:', broadcastError);
      // Don't fail the attendance save if broadcast fails
    }

    res.json({
      message: 'Attendance recorded successfully',
      skippedRecords: skippedRecords.length > 0 ? skippedRecords : undefined,
      hasConflicts: skippedRecords.length > 0
    });
  } catch (error) {
    console.error('Record attendance error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to record attendance.', details: error.message });
  }
});

// Get recent visitors (for suggestions)
router.get('/:gatheringTypeId/visitors/recent', disableCache, requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId } = req.params;
    const today = new Date().toISOString().split('T')[0];
    const visitorConfig = await getVisitorConfig(req.user.church_id);
    const { visitors } = await getRecentVisitors(gatheringTypeId, req.user.church_id, today, visitorConfig);
    res.json({ visitors });
  } catch (error) {
    console.error('Get recent visitors error:', error);
    res.status(500).json({ error: 'Failed to retrieve recent visitors.' });
  }
});

// Church-wide visitors (all gatherings, all time)
router.get('/visitors/all', async (req, res) => {
  try {
    // Fetch all visitor families for this church
    const allVisitorFamilies = await Database.query(`
      SELECT DISTINCT 
        f.id as family_id,
        f.family_name,
        f.family_notes,
        f.family_type,
        COALESCE(f.last_attended, f.created_at) as last_activity
      FROM families f
      JOIN individuals i ON f.id = i.family_id
      WHERE f.family_type IN ('local_visitor', 'traveller_visitor')
        AND i.people_type IN ('local_visitor', 'traveller_visitor')
        AND i.is_active = 1
        AND f.church_id = ?
      GROUP BY f.id
      ORDER BY last_activity DESC, f.family_name
    `, [req.user.church_id]);

    // Convert family data to individual visitor format to match main API
    const processedVisitors = [];
    for (const family of allVisitorFamilies) {
      const familyMembers = await Database.query(`
        SELECT id, first_name, last_name, people_type
        FROM individuals 
        WHERE family_id = ? AND is_active = 1 AND church_id = ?
        ORDER BY first_name
      `, [family.family_id, req.user.church_id]);

      for (const member of familyMembers) {
        const isLocal = member.people_type === 'local_visitor';
        processedVisitors.push({
          id: member.id,
          name: `${member.first_name} ${member.last_name}`,
          visitorType: isLocal ? 'potential_regular' : 'temporary_other',
          visitorFamilyGroup: family.family_id.toString(),
          notes: family.family_notes,
          lastAttended: family.last_activity,
          familyId: family.family_id,
          familyName: family.family_name
        });
      }
    }

    res.json({ visitors: processedVisitors });
  } catch (error) {
    console.error('Get all visitors error:', error);
    res.status(500).json({ error: 'Failed to retrieve all visitors.' });
  }
});

// Add visitor to a session and create individual
router.post('/:gatheringTypeId/:date/visitors', requireGatheringAccess, auditLog('ADD_VISITOR'), async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { name, visitorType, visitorFamilyGroup, familyName, notes, people } = req.body;

    if ((!name || !name.trim()) && (!people || people.length === 0)) {
      return res.status(400).json({ error: 'Visitor information is required' });
    }

    await Database.transaction(async (conn) => {
      // Get or create attendance session
      let sessionResult = await conn.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(gathering_type_id, session_date, church_id) DO UPDATE SET created_by = excluded.created_by, updated_at = datetime('now')
      `, [gatheringTypeId, date, req.user.id, req.user.church_id]);

      // Always SELECT the session ID after UPSERT — lastInsertRowid is unreliable
      // when ON CONFLICT DO UPDATE fires (it returns a stale value from a prior INSERT)
      const sessionsLookup = await conn.query(
        'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
        [gatheringTypeId, date, req.user.church_id]
      );
      const sessionId = Number(sessionsLookup[0].id);

      // Prepare people to create
      let peopleToCreate = [];
      if (people && people.length > 0) {
        peopleToCreate = people;
      } else {
        // Fallback to parsing name
        const nameParts = name.trim().split(' & ');
        for (const namePart of nameParts) {
          const personParts = namePart.trim().split(' ');
          const firstName = personParts[0] || 'Unknown';
          const lastName = personParts.slice(1).join(' ') || 'Unknown';
          peopleToCreate.push({ firstName, lastName, isChild: false });
        }
      }

      // Create family if multiple people or if family name is provided
      let familyId = null;
      let familyLastName = 'Unknown';
      if (peopleToCreate.length > 1 || familyName) {
        // Use provided family name if available, otherwise generate one
        let finalFamilyName = familyName;
        
        if (!finalFamilyName) {
          // Find a known last name, preferring non-children
          for (const person of peopleToCreate) {
            if (!person.isChild && person.lastName && person.lastName !== 'Unknown') {
              familyLastName = person.lastName;
              break;
            }
          }
          if (familyLastName === 'Unknown') {
            for (const person of peopleToCreate) {
              if (person.lastName && person.lastName !== 'Unknown') {
                familyLastName = person.lastName;
                break;
              }
            }
          }

          // If surnames are unknown, name family by first names only (limited to 2 names)
          if (familyLastName === 'Unknown') {
            const firstNames = peopleToCreate.slice(0, 2).map(p => p.firstName || 'Unknown').filter(name => name !== 'Unknown');
            if (firstNames.length === 1) {
              finalFamilyName = firstNames[0];
            } else if (firstNames.length > 1) {
              finalFamilyName = firstNames.join(' and ');
            } else {
              finalFamilyName = 'Visitor Family';
            }
          } else {
            const mainFirstName = peopleToCreate[0].firstName !== 'Unknown' ? peopleToCreate[0].firstName : 'Visitor';
            finalFamilyName = `${mainFirstName} ${familyLastName} Family`;
          }
        }

        // Determine family_type based on visitorType
        const familyType = visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor';
        
        const familyResult = await conn.query(`
            INSERT INTO families (family_name, family_type, created_by, church_id)
            VALUES (?, ?, ?, ?)
          `, [finalFamilyName, familyType, req.user.id, req.user.church_id]);
        familyId = Number(familyResult.insertId);
      }

      // Process and create individuals
      const createdIndividuals = [];
      let childCount = 0;
      for (let i = 0; i < peopleToCreate.length; i++) {
        let { firstName, lastName, firstUnknown = false, lastUnknown = false, isChild = false } = peopleToCreate[i];

        // Handle unknown first name
        if (firstUnknown || !firstName.trim()) {
          if (isChild) {
            childCount++;
            firstName = `Child ${childCount}`;
          } else {
            firstName = 'Unknown';
          }
        } else {
          firstName = firstName.trim() || 'Unknown';
        }

        // Handle unknown last name
        if (lastUnknown || !lastName || !lastName.trim()) {
          lastName = familyId && familyLastName ? familyLastName : 'Unknown';
        } else {
          lastName = lastName.trim() || 'Unknown';
        }

        // Check if individual already exists (only match visitors)
        const existingIndividual = await conn.query(`
          SELECT id FROM individuals 
          WHERE LOWER(first_name) = LOWER(?) 
            AND LOWER(last_name) = LOWER(?) 
            AND people_type IN ('local_visitor', 'traveller_visitor')
            AND church_id = ?
        `, [firstName, lastName, req.user.church_id]);

        let individualId;
        if (existingIndividual.length === 0) {
          // Create new individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, is_child, people_type, created_by, church_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, [firstName, lastName, familyId, isChild ? true : false, visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor', req.user.id, req.user.church_id]);

          individualId = Number(individualResult.insertId);
        } else {
          // Use existing individual
          individualId = Number(existingIndividual[0].id);
          
          // Determine the people_type based on visitorType
          const peopleType = visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor';
          
          // Get old family_id before update for sync
          const oldIndividual = await conn.query(
            'SELECT family_id FROM individuals WHERE id = ?',
            [individualId]
          );
          const oldFamilyId = oldIndividual.length > 0 ? oldIndividual[0].family_id : null;
          
          // Update family_id and people_type if creating/joining a new family
          // This ensures existing individuals get the correct type when added to a visitor family
          if (familyId) {
            await conn.query(`
              UPDATE individuals 
              SET family_id = ?, people_type = ?, updated_at = datetime('now')
              WHERE id = ?
            `, [familyId, peopleType, individualId]);
            
            // Sync family_type for new family
            const newFamilyMembers = await conn.query(
              'SELECT DISTINCT people_type FROM individuals WHERE family_id = ? AND is_active = 1',
              [familyId]
            );
            if (newFamilyMembers.length === 1 && newFamilyMembers[0].people_type) {
              await conn.query(
                `UPDATE families SET family_type = ?, updated_at = datetime('now') WHERE id = ?`,
                [newFamilyMembers[0].people_type, familyId]
              );
            }
            
            // Sync old family if family_id changed
            if (oldFamilyId && oldFamilyId !== familyId) {
              const oldFamilyMembers = await conn.query(
                'SELECT DISTINCT people_type FROM individuals WHERE family_id = ? AND is_active = 1',
                [oldFamilyId]
              );
              if (oldFamilyMembers.length === 1 && oldFamilyMembers[0].people_type) {
                await conn.query(
                  `UPDATE families SET family_type = ?, updated_at = datetime('now') WHERE id = ?`,
                  [oldFamilyMembers[0].people_type, oldFamilyId]
                );
              }
            }
          } else {
            // Even if not joining a family, update people_type to match visitor type
            await conn.query(`
              UPDATE individuals 
              SET people_type = ?, updated_at = datetime('now')
              WHERE id = ?
            `, [peopleType, individualId]);
            
            // Sync old family if individual was in a family
            if (oldFamilyId) {
              const oldFamilyMembers = await conn.query(
                'SELECT DISTINCT people_type FROM individuals WHERE family_id = ? AND is_active = 1',
                [oldFamilyId]
              );
              if (oldFamilyMembers.length === 1 && oldFamilyMembers[0].people_type) {
                await conn.query(
                  `UPDATE families SET family_type = ?, updated_at = datetime('now') WHERE id = ?`,
                  [oldFamilyMembers[0].people_type, oldFamilyId]
                );
              }
            }
          }
        }

        // Add visitor to gathering list so they appear in subsequent weeks
        const existingGatheringList = await conn.query(`
          SELECT id FROM gathering_lists 
          WHERE gathering_type_id = ? AND individual_id = ?
        `, [gatheringTypeId, individualId]);

        if (existingGatheringList.length === 0) {
          await conn.query(`
            INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
            VALUES (?, ?, ?, ?)
          `, [gatheringTypeId, individualId, req.user.id, req.user.church_id]);
        }

        createdIndividuals.push({
          id: individualId,
          firstName,
          lastName
        });
      }

      // Compute full name for visitors table
      const fullName = createdIndividuals.map(ind => `${ind.firstName} ${ind.lastName}`).join(' & ');

      // Generate a single family group ID for all family members
      const familyGroupId = peopleToCreate.length > 1 ? visitorFamilyGroup || `family_${sessionId}_${Date.now()}` : null;

      // Build visitors payload for immediate UI update
      const visitorsPayload = createdIndividuals.map(ind => ({
        name: `${ind.firstName} ${ind.lastName}`,
        visitorType: visitorType || 'temporary_other',
        visitorFamilyGroup: familyGroupId || undefined,
        lastAttended: date
      }));

      // Return success without writing to legacy visitors table
      res.json({ 
        message: 'Visitor(s) added successfully',
        individuals: createdIndividuals,
        sessionId: sessionId,
        familyGroupId: familyGroupId,
        visitors: visitorsPayload
      });
    });

    // Broadcast WebSocket update for new visitors
    try {
      websocketBroadcast.broadcastVisitorFamilyAdded(
        gatheringTypeId,
        date,
        req.user.church_id,
        { id: familyId, name: familyName },
        visitorsPayload
      );
      logger.debugLog('Broadcasted visitor addition via WebSocket');
    } catch (broadcastError) {
      console.error('Error broadcasting visitor addition:', broadcastError);
      // Don't fail the visitor save if broadcast fails
    }
  } catch (error) {
    console.error('Add visitor error:', error);
    res.status(500).json({ error: 'Failed to add visitor.' });
  }
});

// Update visitor
router.put('/:gatheringTypeId/:date/visitors/:visitorId', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date, visitorId } = req.params;
    const { people, visitorType, familyName, notes } = req.body;

    if (!people || people.length === 0) {
      return res.status(400).json({ error: 'Visitor information is required' });
    }

    await Database.transaction(async (conn) => {
      // Get or create attendance session
      let sessionResult = await conn.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(gathering_type_id, session_date, church_id) DO UPDATE SET created_by = excluded.created_by, updated_at = datetime('now')
      `, [gatheringTypeId, date, req.user.id, req.user.church_id]);

      // Always SELECT the session ID after UPSERT — lastInsertRowid is unreliable
      // when ON CONFLICT DO UPDATE fires (it returns a stale value from a prior INSERT)
      const sessionsLookup = await conn.query(
        'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
        [gatheringTypeId, date, req.user.church_id]
      );
      const sessionId = Number(sessionsLookup[0].id);

      // Treat visitorId as individual_id; update or replace the individuals and gathering list
      // Remove the old individual's attendance and gathering list assignment for this session
      await conn.query(
        'DELETE FROM attendance_records WHERE session_id = ? AND individual_id = ? AND church_id = ?',
        [sessionId, visitorId, req.user.church_id]
      );
      await conn.query(
        'DELETE FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?',
        [gatheringTypeId, visitorId, req.user.church_id]
      );

      // Optionally create a new family if multiple people or familyName provided
      let familyId = null;
      let familyLastName = null;
      if (people.length > 1 || familyName) {
        let finalFamilyName = familyName;
        if (!finalFamilyName) {
          const mainPerson = people.find(p => !p.isChild) || people[0];
          familyLastName = (mainPerson.lastName || 'Unknown').toUpperCase();
          
          // If surnames are unknown, name family by first names only (limited to 2 names)
          if (familyLastName === 'UNKNOWN' || !mainPerson.lastName || mainPerson.lastUnknown) {
            const firstNames = people.slice(0, 2).map(p => p.firstName || 'Unknown').filter(name => name !== 'Unknown');
            if (firstNames.length === 1) {
              finalFamilyName = firstNames[0];
            } else if (firstNames.length > 1) {
              finalFamilyName = firstNames.join(' and ');
            } else {
              finalFamilyName = 'Visitor Family';
            }
          } else {
            finalFamilyName = `${familyLastName}, ${people.slice(0, 2).map(p => p.firstName || 'Unknown').join(' & ')}`;
          }
        }
        // Determine family_type based on visitorType (regular attendees use 'regular')
        const familyType = visitorType === 'potential_regular' ? 'local_visitor' : (visitorType === 'temporary_other' ? 'traveller_visitor' : 'regular');
        const familyResult = await conn.query(
          'INSERT INTO families (family_name, family_type, created_by, church_id) VALUES (?, ?, ?, ?)',
          [finalFamilyName, familyType, req.user.id, req.user.church_id]
        );
        familyId = Number(familyResult.insertId);
      }

      const createdIndividuals = [];
      let childCount = 0;
      for (const person of people) {
        let { firstName, lastName, firstUnknown, lastUnknown, isChild } = person;
        if (firstUnknown || !firstName?.trim()) {
          firstName = isChild ? `Child ${++childCount}` : 'Unknown';
        } else {
          firstName = firstName.trim();
        }
        if (lastUnknown || !lastName?.trim()) {
          lastName = familyId && familyLastName ? familyLastName : 'Unknown';
        } else {
          lastName = lastName.trim();
        }

        // Create or reuse individual as a visitor type
        const individualResult = await conn.query(
          'INSERT INTO individuals (first_name, last_name, family_id, is_child, people_type, created_by, church_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [firstName, lastName, familyId, isChild ? true : false, visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor', req.user.id, req.user.church_id]
        );
        const individualId = Number(individualResult.insertId);

        // Add to gathering list so they appear for future services
        await conn.query(
          'INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id) VALUES (?, ?, ?, ?)',
          [gatheringTypeId, individualId, req.user.id, req.user.church_id]
        );

        createdIndividuals.push({ id: individualId, firstName, lastName });
      }

      const updatedVisitors = createdIndividuals.map(ind => ({
        name: `${ind.firstName} ${ind.lastName}`,
        visitorType: visitorType || 'temporary_other',
        lastAttended: date
      }));

      res.json({ message: 'Visitor updated successfully', individuals: createdIndividuals, visitors: updatedVisitors });
    });

    // Broadcast WebSocket update for visitor changes
    try {
      const updatedVisitors = createdIndividuals.map(ind => ({
        name: `${ind.firstName} ${ind.lastName}`,
        visitorType: visitorType || 'temporary_other',
        lastAttended: date
      }));

      websocketBroadcast.broadcastVisitorFamilyUpdated(
        gatheringTypeId,
        date,
        req.user.church_id,
        { name: familyName },
        updatedVisitors
      );
      logger.debugLog('Broadcasted visitor update via WebSocket');
    } catch (broadcastError) {
      console.error('Error broadcasting visitor update:', broadcastError);
      // Don't fail the visitor save if broadcast fails
    }
  } catch (error) {
    console.error('Update visitor error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to update visitor.', details: error.message });
  }
});

// Add regular attendee to a gathering from attendance page
router.post('/:gatheringTypeId/:date/regulars', requireGatheringAccess, auditLog('ADD_REGULAR_ATTENDEE'), async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { people } = req.body;

    if (!people || people.length === 0) {
      return res.status(400).json({ error: 'People information is required' });
    }

    await Database.transaction(async (conn) => {
      // Create family if multiple people
      let familyId = null;
      let familyLastName = 'Unknown';
      let childCount = 0;
      const createdIndividuals = [];

      if (people.length > 1) {
        const mainPerson = people.find(p => !p.isChild);
        if (mainPerson && !mainPerson.lastUnknown) {
          familyLastName = mainPerson.lastName.toUpperCase();
          const familyName = `${familyLastName}, ${people.map(p => p.firstName).join(' & ')}`;
          
          // Regular attendees - set family_type to 'regular'
          const familyResult = await conn.query(`
            INSERT INTO families (family_name, family_type) VALUES (?, 'regular')
          `, [familyName]);
          
          familyId = Number(familyResult.insertId);
        }
      }

      for (const person of people) {
        let { firstName, lastName, firstUnknown, lastUnknown, isChild } = person;

        // Handle unknown first name
        if (firstUnknown || !firstName.trim()) {
          if (isChild) {
            childCount++;
            firstName = `Child ${childCount}`;
          } else {
            firstName = 'Unknown';
          }
        } else {
          firstName = firstName.trim();
        }

        // Handle unknown last name
        if (lastUnknown || !lastName || !lastName.trim()) {
          lastName = familyId ? familyLastName : 'Unknown';
        } else {
          lastName = lastName.trim();
        }

        // Check if individual already exists (only match non-visitors)
        const existingIndividual = await conn.query(`
          SELECT id FROM individuals 
          WHERE LOWER(first_name) = LOWER(?) 
            AND LOWER(last_name) = LOWER(?) 
            AND (people_type = 'regular' OR people_type IS NULL)
            AND is_active = 1
        `, [firstName, lastName]);

        let individualId;
        if (existingIndividual.length === 0) {
          // Create new individual as regular (not visitor)
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, people_type, created_by)
            VALUES (?, ?, ?, 'regular', ?)
          `, [firstName, lastName, familyId, req.user.id]);

          individualId = Number(individualResult.insertId);
        } else {
          // Use existing individual
          individualId = Number(existingIndividual[0].id);
          
          // Update family_id if creating a new family
          if (familyId) {
            await conn.query(`
              UPDATE individuals 
              SET family_id = ? 
              WHERE id = ?
            `, [familyId, individualId]);
          }
        }

        // Add to gathering list if not already there
        const existingAssignment = await conn.query(
          'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?',
          [gatheringTypeId, individualId, req.user.church_id]
        );
        
        if (existingAssignment.length === 0) {
          await conn.query(`
            INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
            VALUES (?, ?, ?, ?)
          `, [gatheringTypeId, individualId, req.user.id, req.user.church_id]);
        }

        createdIndividuals.push({
          id: individualId,
          firstName,
          lastName
        });
      }

      res.json({ 
        message: 'Regular attendee(s) added successfully',
        individuals: createdIndividuals
      });
    });
  } catch (error) {
    console.error('Add regular attendee error:', error);
    res.status(500).json({ error: 'Failed to add regular attendee.' });
  }
});

// Delete visitor(s)
router.delete('/:gatheringTypeId/:date/visitors/:visitorId', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date, visitorId } = req.params;
    const { deleteFamily } = req.query;

    await Database.transaction(async (conn) => {
      const sessions = await conn.query(
        'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
        [gatheringTypeId, date, req.user.church_id]
      );
      if (sessions.length === 0) {
        return res.status(404).json({ error: 'Attendance session not found' });
      }
      const sessionId = Number(sessions[0].id);

      // New system: treat visitorId as individual_id and remove from this session and gathering list
      const individual = await conn.query(
        'SELECT id, first_name, last_name, family_id FROM individuals WHERE id = ? AND church_id = ?',
        [visitorId, req.user.church_id]
      );
      if (individual.length === 0) {
        return res.status(404).json({ error: 'Visitor not found' });
      }
      const ind = individual[0];

      let targetIds = [ind.id];
      let deletedNames = [`${ind.first_name} ${ind.last_name}`];

      if (deleteFamily === 'true' && ind.family_id) {
        const familyMembers = await conn.query(
          'SELECT id, first_name, last_name FROM individuals WHERE family_id = ? AND is_active = 1 AND church_id = ?',
          [ind.family_id, req.user.church_id]
        );
        targetIds = familyMembers.map(m => Number(m.id));
        deletedNames = familyMembers.map(m => `${m.first_name} ${m.last_name}`);
      }

      if (targetIds.length > 0) {
        await conn.query(
          `DELETE FROM attendance_records WHERE session_id = ? AND individual_id IN (${targetIds.map(() => '?').join(',')}) AND church_id = ?`,
          [sessionId, ...targetIds, req.user.church_id]
        );
        await conn.query(
          `DELETE FROM gathering_lists WHERE gathering_type_id = ? AND individual_id IN (${targetIds.map(() => '?').join(',')}) AND church_id = ?`,
          [gatheringTypeId, ...targetIds, req.user.church_id]
        );
      }

      const message = deleteFamily === 'true' && ind.family_id 
        ? `Removed visitor family from service: ${deletedNames.join(', ')}`
        : `Removed visitor from service: ${deletedNames[0]}`;

      return res.json({ message, removed: targetIds.length, deletedNames, visitors: [] });
    });
  } catch (error) {
    console.error('Delete visitor error:', error);
    res.status(500).json({ error: 'Failed to delete visitor.' });
  }
});

// Add visitor family to service
router.post('/:gatheringTypeId/:date/visitor-family/:familyId', requireGatheringAccess, auditLog('ADD_VISITOR_FAMILY_TO_SERVICE'), async (req, res) => {
  try {
    const gatheringTypeId = Number(req.params.gatheringTypeId);
    const date = req.params.date;
    const familyId = Number(req.params.familyId);

    if (!Number.isInteger(gatheringTypeId) || gatheringTypeId <= 0) {
      return res.status(400).json({ error: 'Invalid gathering type' });
    }
    if (!Number.isInteger(familyId) || familyId <= 0) {
      return res.status(400).json({ error: 'Invalid family' });
    }

    // Validate gathering type exists in this church (prevents FOREIGN KEY failure on gathering_lists)
    const hasGatheringChurchId = await columnExists('gathering_types', 'church_id');
    const gatheringCheck = hasGatheringChurchId
      ? await Database.query('SELECT id FROM gathering_types WHERE id = ? AND church_id = ?', [gatheringTypeId, req.user.church_id])
      : await Database.query('SELECT id FROM gathering_types WHERE id = ?', [gatheringTypeId]);
    if (gatheringCheck.length === 0) {
      return res.status(404).json({ error: 'Gathering not found' });
    }

    await Database.transaction(async (conn) => {
      // Verify the family exists and is a visitor family
      const familyResult = await conn.query(`
        SELECT id, family_name, family_type 
        FROM families 
        WHERE id = ? AND family_type IN ('local_visitor', 'traveller_visitor')
      `, [familyId]);

      if (familyResult.length === 0) {
        return res.status(404).json({ error: 'Visitor family not found' });
      }

      // Get or create attendance session
      const hasSessionsChurchId = await columnExists('attendance_sessions', 'church_id');
      let sessionResult;
      if (hasSessionsChurchId) {
        sessionResult = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(gathering_type_id, session_date, church_id) DO UPDATE SET created_by = excluded.created_by, updated_at = datetime('now')
        `, [gatheringTypeId, date, req.user.id, req.user.church_id]);
      } else {
        sessionResult = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
          VALUES (?, ?, ?)
          ON CONFLICT(gathering_type_id, session_date, church_id) DO UPDATE SET created_by = excluded.created_by, updated_at = datetime('now')
        `, [gatheringTypeId, date, req.user.id]);
      }

      // Always SELECT the session ID after UPSERT — lastInsertRowid is unreliable
      // when ON CONFLICT DO UPDATE fires (it returns a stale value from a prior INSERT)
      const sessionsLookup = hasSessionsChurchId
        ? await conn.query(
            'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
            [gatheringTypeId, date, req.user.church_id]
          )
        : await conn.query(
            'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
            [gatheringTypeId, date]
          );
      const sessionId = Number(sessionsLookup[0].id);

      // Snapshot roster before recording visitor attendance
      await createRosterSnapshot(conn, sessionId, gatheringTypeId, req.user.church_id, date);

      // Get all individuals in the visitor family (use numeric id for FK consistency)
      const individuals = await conn.query(`
        SELECT id, first_name, last_name, people_type 
        FROM individuals 
        WHERE family_id = ? AND is_active = 1
      `, [familyId]);

      if (individuals.length === 0) {
        return res.status(400).json({ error: 'No individuals found in visitor family' });
      }

      const createdIndividuals = [];
      const addedBy = req.user.id != null ? Number(req.user.id) : null;

      // Add each individual to the gathering list and mark as present
      for (const individual of individuals) {
        const individualId = Number(individual.id);
        // Add to gathering list if not already there
        const existingGatheringList = await conn.query(`
          SELECT id FROM gathering_lists 
          WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?
        `, [gatheringTypeId, individualId, req.user.church_id]);

        if (existingGatheringList.length === 0) {
        await conn.query(`
          INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
          VALUES (?, ?, ?, ?)
        `, [gatheringTypeId, individualId, addedBy, req.user.church_id]);
        }

        // Mark as present in attendance records
        // Store historical people_type if column exists
        const hasPeopleTypeAtTime = await columnExists('attendance_records', 'people_type_at_time');
        const peopleTypeAtTime = individual.people_type || null;

        if (hasPeopleTypeAtTime && peopleTypeAtTime) {
          await conn.query(`
            INSERT INTO attendance_records (session_id, individual_id, present, church_id, people_type_at_time)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(session_id, individual_id) DO UPDATE SET present = excluded.present, people_type_at_time = excluded.people_type_at_time
          `, [sessionId, individualId, req.user.church_id, peopleTypeAtTime]);
        } else {
          await conn.query(`
            INSERT INTO attendance_records (session_id, individual_id, present, church_id)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(session_id, individual_id) DO UPDATE SET present = excluded.present
          `, [sessionId, individualId, req.user.church_id]);
        }

        // Update last_attendance_date for the individual
      await conn.query(`
        UPDATE individuals 
        SET last_attendance_date = ? 
        WHERE id = ? AND church_id = ?
      `, [date, individualId, req.user.church_id]);

        createdIndividuals.push({
          id: individualId,
          firstName: individual.first_name,
          lastName: individual.last_name,
          present: true
        });
      }

      // Update family's last attended date
      await conn.query(`
        UPDATE families 
        SET last_attended = ? 
        WHERE id = ? AND church_id = ?
      `, [date, familyId, req.user.church_id]);

      const visitorsPayload = createdIndividuals.map(ci => ({ 
        name: `${ci.firstName} ${ci.lastName}`, 
        visitorType: 'temporary_other', 
        lastAttended: date 
      }));

      res.json({ 
        message: 'Visitor family added and marked present',
        individuals: createdIndividuals,
        visitors: visitorsPayload
      });
    });

    // Broadcast WebSocket update for visitor family addition
    try {
      const visitorsPayload = createdIndividuals.map(ci => ({ 
        name: `${ci.firstName} ${ci.lastName}`, 
        visitorType: 'temporary_other', 
        lastAttended: date 
      }));

      websocketBroadcast.broadcastVisitorFamilyAdded(
        gatheringTypeId,
        date,
        req.user.church_id,
        { id: familyId },
        visitorsPayload
      );
      logger.debugLog('Broadcasted visitor family addition via WebSocket');
    } catch (broadcastError) {
      console.error('Error broadcasting visitor family addition:', broadcastError);
      // Don't fail the operation if broadcast fails
    }
  } catch (error) {
    console.error('Add visitor family to service error:', error);
    res.status(500).json({ error: 'Failed to add visitor family to service.' });
  }
});

// Add individual person to service
router.post('/:gatheringTypeId/:date/individual/:individualId', requireGatheringAccess, auditLog('ADD_INDIVIDUAL_TO_SERVICE'), async (req, res) => {
  try {
    const { gatheringTypeId, date, individualId } = req.params;
    
    logger.debugLog('🔍 Adding individual to service:', {
      gatheringTypeId,
      date,
      individualId,
      churchId: req.user.church_id,
      userId: req.user.id
    });

    await Database.transaction(async (conn) => {
      // Check which columns exist for backward compatibility
      const hasSessionsChurchId = await columnExists('attendance_sessions', 'church_id');
      const hasAttendanceRecordsChurchId = await columnExists('attendance_records', 'church_id');
      const hasIndividualsChurchId = await columnExists('individuals', 'church_id');
      const hasGatheringListsChurchId = await columnExists('gathering_lists', 'church_id');

      // Verify the individual exists
      const individualCheck = await conn.query(`
        SELECT i.id, i.first_name, i.last_name, i.family_id, f.family_type 
        FROM individuals i
        LEFT JOIN families f ON i.family_id = f.id
        WHERE i.id = ? AND i.church_id = ?
      `, [individualId, req.user.church_id]);

      if (individualCheck.length === 0) {
        throw new Error('Individual not found');
      }

      const individual = individualCheck[0];

      // Get or create attendance session
      let sessionResult;
      if (hasSessionsChurchId) {
        sessionResult = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(gathering_type_id, session_date, church_id) DO UPDATE SET created_by = excluded.created_by, updated_at = datetime('now')
        `, [gatheringTypeId, date, req.user.id, req.user.church_id]);
      } else {
        sessionResult = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
          VALUES (?, ?, ?)
          ON CONFLICT(gathering_type_id, session_date, church_id) DO UPDATE SET created_by = excluded.created_by, updated_at = datetime('now')
        `, [gatheringTypeId, date, req.user.id]);
      }

      // Always SELECT the session ID after UPSERT — lastInsertRowid is unreliable
      // when ON CONFLICT DO UPDATE fires (it returns a stale value from a prior INSERT)
      const sessionsLookup = await conn.query(
        hasSessionsChurchId
          ? 'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?'
          : 'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
        hasSessionsChurchId
          ? [gatheringTypeId, date, req.user.church_id]
          : [gatheringTypeId, date]
      );
      const sessionId = Number(sessionsLookup[0].id);

      // Snapshot roster before recording individual attendance
      await createRosterSnapshot(conn, sessionId, gatheringTypeId, req.user.church_id, date);

      // Add individual to gathering list if not already there
      const existingGatheringList = await conn.query(
        hasGatheringListsChurchId
          ? 'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?'
          : 'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
        hasGatheringListsChurchId
          ? [gatheringTypeId, individualId, req.user.church_id]
          : [gatheringTypeId, individualId]
      );

      if (existingGatheringList.length === 0) {
        await conn.query(
          hasGatheringListsChurchId
            ? 'INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id) VALUES (?, ?, ?, ?)'
            : 'INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by) VALUES (?, ?, ?)',
          hasGatheringListsChurchId
            ? [gatheringTypeId, individualId, req.user.id, req.user.church_id]
            : [gatheringTypeId, individualId, req.user.id]
        );
      }

      // Add attendance record and mark as present
      // Store historical people_type if column exists
      const hasPeopleTypeAtTime = await columnExists('attendance_records', 'people_type_at_time');
      let peopleTypeAtTime = null;
      
      if (hasPeopleTypeAtTime) {
        const individualResult = hasIndividualsChurchId
          ? await conn.query('SELECT people_type FROM individuals WHERE id = ? AND church_id = ?', [individualId, req.user.church_id])
          : await conn.query('SELECT people_type FROM individuals WHERE id = ?', [individualId]);
        
        if (individualResult.length > 0 && individualResult[0].people_type) {
          peopleTypeAtTime = individualResult[0].people_type;
        }
      }
      
      if (hasAttendanceRecordsChurchId) {
        if (hasPeopleTypeAtTime && peopleTypeAtTime) {
          await conn.query(`
            INSERT INTO attendance_records (session_id, individual_id, present, church_id, people_type_at_time)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(session_id, individual_id) DO UPDATE SET present = 1, people_type_at_time = excluded.people_type_at_time
          `, [sessionId, individualId, req.user.church_id, peopleTypeAtTime]);
        } else {
          await conn.query(`
            INSERT INTO attendance_records (session_id, individual_id, present, church_id)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(session_id, individual_id) DO UPDATE SET present = 1
          `, [sessionId, individualId, req.user.church_id]);
        }
      } else {
        if (hasPeopleTypeAtTime && peopleTypeAtTime) {
          await conn.query(`
            INSERT INTO attendance_records (session_id, individual_id, present, people_type_at_time)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(session_id, individual_id) DO UPDATE SET present = 1, people_type_at_time = excluded.people_type_at_time
          `, [sessionId, individualId, peopleTypeAtTime]);
        } else {
          await conn.query(`
            INSERT INTO attendance_records (session_id, individual_id, present)
            VALUES (?, ?, 1)
            ON CONFLICT(session_id, individual_id) DO UPDATE SET present = 1
          `, [sessionId, individualId]);
        }
      }

      // Update last_attendance_date for the individual
      if (hasIndividualsChurchId) {
        await conn.query(`
          UPDATE individuals 
          SET last_attendance_date = ? 
          WHERE id = ? AND church_id = ?
        `, [date, individualId, req.user.church_id]);
      } else {
        await conn.query(`
          UPDATE individuals 
          SET last_attendance_date = ? 
          WHERE id = ?
        `, [date, individualId]);
      }

      logger.debugLog('✅ Successfully added individual to service:', {
        individualId: individual.id,
        name: `${individual.first_name} ${individual.last_name}`,
        gatheringTypeId,
        date
      });
      
      res.json({ 
        message: 'Individual added and marked present',
        individual: {
          id: individual.id,
          firstName: individual.first_name,
          lastName: individual.last_name
        }
      });
    });

    // Broadcast WebSocket update for individual addition
    try {
      websocketBroadcast.broadcastAttendanceRecords(
        gatheringTypeId,
        date,
        req.user.church_id,
        [{
          individualId: parseInt(individualId),
          present: true
        }]
      );
      logger.debugLog('Broadcasted individual addition via WebSocket');
    } catch (broadcastError) {
      console.error('Error broadcasting individual addition:', broadcastError);
      // Don't fail the operation if broadcast fails
    }
  } catch (error) {
    console.error('Add individual to service error:', error);
    res.status(500).json({ error: 'Failed to add individual to service.' });
  }
});


module.exports = router; 