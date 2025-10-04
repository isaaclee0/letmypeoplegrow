const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireGatheringAccess, requireRole, auditLog } = require('../middleware/auth');
const { requireLastAttendedColumn, columnExists } = require('../utils/databaseSchema');
const { processApiResponse } = require('../utils/caseConverter');
const websocketBroadcast = require('../utils/websocketBroadcast');
const logger = require('../config/logger');

const router = express.Router();

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
        ON DUPLICATE KEY UPDATE 
        headcount = VALUES(headcount),
        updated_by = VALUES(updated_by),
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
        WHERE id = ? AND church_id = ? AND is_active = true
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
          ON DUPLICATE KEY UPDATE 
          headcount = VALUES(headcount),
          updated_by = VALUES(updated_by),
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
const getLastNServiceDates = async (gatheringTypeId, churchId, serviceCount) => {
  try {
    const serviceDates = await Database.query(`
      SELECT DISTINCT session_date 
      FROM attendance_sessions 
      WHERE gathering_type_id = ? AND church_id = ?
      ORDER BY session_date DESC 
      LIMIT ?
    `, [gatheringTypeId, churchId, serviceCount]);
    
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
      WHERE i.is_active = true
        AND f.church_id = ?
      GROUP BY f.id
      ORDER BY last_activity DESC, f.family_name
    `, [req.user.church_id]);

    const processedPeople = [];
    for (const family of allFamilies) {
      const familyMembers = await Database.query(`
        SELECT id, first_name, last_name, people_type
        FROM individuals 
        WHERE family_id = ? AND is_active = true AND church_id = ?
        ORDER BY first_name
      `, [family.family_id, req.user.church_id]);

      for (const member of familyMembers) {
        const isVisitor = ['local_visitor', 'traveller_visitor'].includes(member.people_type);
        processedPeople.push({
          id: member.id,
          name: `${member.first_name} ${member.last_name}`,
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
        AND i.is_active = true
        AND f.church_id = ?
      GROUP BY f.id
      ORDER BY last_activity DESC, f.family_name
    `, [req.user.church_id]);

    const processedVisitors = [];
    for (const family of allVisitorFamilies) {
      const familyMembers = await Database.query(`
        SELECT id, first_name, last_name, people_type
        FROM individuals 
        WHERE family_id = ? AND is_active = true AND church_id = ?
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
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
          [gatheringTypeId, date, req.user.church_id]
        )
      : await Database.query(
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
          [gatheringTypeId, date]
        );

    let sessionId = null;
    let visitors = [];
    
    // Get visitor configuration for filtering (moved here to use in both visitors and potentialVisitors)
    const visitorConfig = await getVisitorConfig(req.user.church_id);
    const localServiceDates = await getLastNServiceDates(gatheringTypeId, req.user.church_id, visitorConfig.localVisitorServiceLimit);
    const travellerServiceDates = await getLastNServiceDates(gatheringTypeId, req.user.church_id, visitorConfig.travellerVisitorServiceLimit);

    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      
      // Get visitor families for this session limited to the active gathering (via gathering_lists)
      const visitorFamilies = await Database.query(`
        SELECT 
          i.id,
          i.first_name,
          i.last_name,
          i.last_attendance_date,
          i.people_type,
          f.id as family_id,
          f.family_name,
          f.family_notes,
          f.family_type,
          f.last_attended,
          COALESCE(ar.present, false) as present
        FROM individuals i
        JOIN families f ON i.family_id = f.id
        JOIN gathering_lists gl ON gl.individual_id = i.id AND gl.gathering_type_id = ?
        LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
        WHERE f.family_type IN ('local_visitor', 'traveller_visitor') 
          AND i.is_active = true
          AND i.people_type IN ('local_visitor', 'traveller_visitor')
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
          present: individual.present === 1 || individual.present === true,
          lastAttendanceDate: individual.last_attendance_date,
          peopleType: individual.people_type,
          notes: null // Notes are not stored in attendance_records in current schema
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
            visitorType: visitorTypeFromFamily,
            visitorStatus: isInfrequent ? 'infrequent' : (isTraveller ? 'traveller' : 'local'),
            visitorFamilyGroup: family.familyId.toString(),
            notes: notesFromFamily || member.notes,
            lastAttended: family.lastAttended,
            familyId: family.familyId,
            familyName: family.familyName,
            present: member.present,
            peopleType: member.peopleType,
            lastAttendanceDate: member.lastAttendanceDate
          };
        })
      );
      
      // Apply service-limit filtering to visitors array (same logic as potentialVisitors)
      visitors = allVisitors.filter(visitor => {
        // Always show visitors who are marked present on this date
        if (visitor.present) return true;
        
        // For visitors not marked present, apply service-limit filtering
        if (!visitor.lastAttendanceDate) return true; // Include visitors who have never attended
        
        const relevantServiceDates = visitor.peopleType === 'local_visitor' ? 
          localServiceDates : travellerServiceDates;
        
        // Check if visitor's last attendance was within the relevant service dates
        const lastAttendedStr = visitor.lastAttendanceDate.toISOString ? 
          visitor.lastAttendanceDate.toISOString().split('T')[0] : 
          String(visitor.lastAttendanceDate).split('T')[0];
        
        // Check if visitor's last attendance is within the time window (on or after the oldest service date)
        if (relevantServiceDates.length === 0) return false;
        
        // Get the oldest service date (last in the array since they're ordered DESC)
        const oldestServiceDate = relevantServiceDates[relevantServiceDates.length - 1];
        if (!oldestServiceDate || !oldestServiceDate.session_date) return false;
        
        const oldestServiceDateStr = oldestServiceDate.session_date.toISOString().split('T')[0];
        return lastAttendedStr >= oldestServiceDateStr;
      });
    }

    // Get regular attendees and visitor families with attendance status
    let attendanceListQuery = `
      SELECT i.id, i.first_name, i.last_name, f.family_name, f.id as family_id,
             COALESCE(ar.present, false) as present,
             i.people_type,
             f.family_type AS familyType,
             f.last_attended AS lastAttended
      FROM gathering_lists gl
      JOIN individuals i ON gl.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
      -- Removed old visitors table reference - now using unified individuals/families system
      WHERE gl.gathering_type_id = ? 
        AND (
          i.is_active = true OR 
          ar.present = 1 OR 
          ar.present = true OR
          -- Include archived people only if they have attendance records for past gatherings
          (i.is_active = false AND ar.present = 1)
        )
        AND i.church_id = ?
    `;

    // Calculate date ranges for filtering
    const currentDate = new Date(date);
    const sixWeeksAgo = new Date(currentDate);
    sixWeeksAgo.setDate(sixWeeksAgo.getDate() - 42); // 6 weeks = 42 days
    
    const twoWeeksAgo = new Date(currentDate);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14); // 2 weeks = 14 days

    let attendanceListParams = [sessionId, gatheringTypeId, req.user.church_id];

    // Add filtering logic
    if (search && search.trim()) {
      // When searching, only include regular attendees (exclude visitor families)
      attendanceListQuery += ` AND (
        f.family_type = 'regular' OR 
        (f.family_type IS NULL AND i.people_type = 'regular')
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
      attendanceListQuery += ` AND (
        f.family_type = 'regular' OR 
        (f.family_type IS NULL AND i.people_type = 'regular')
      )`;
      // No parameters needed for regular attendee filtering
    }

    attendanceListQuery += ` ORDER BY i.last_name, i.first_name`;

    const attendanceList = await Database.query(attendanceListQuery, attendanceListParams);

    // Get potential visitor attendees based on service-based filtering
    // (visitor config and service dates already fetched above for reuse)
    
    // Build the visitor query using service-based filtering
    let visitorQuery = `
      SELECT DISTINCT 
        CONCAT(i.first_name, ' ', i.last_name) as name,
        CASE WHEN i.people_type = 'local_visitor' THEN 'potential_regular' ELSE 'temporary_other' END as visitor_type,
        f.id as visitor_family_group,
        f.family_notes as notes,
        i.last_attendance_date as last_attended,
        f.family_name,
        f.id as family_id,
        i.id,
        i.people_type,
        i.is_active
      FROM individuals i
      JOIN families f ON i.family_id = f.id
      JOIN gathering_lists gl ON i.id = gl.individual_id AND gl.gathering_type_id = ?
      LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
      WHERE i.people_type IN ('local_visitor', 'traveller_visitor')
        AND (i.is_active = true OR ar.present = 1 OR ar.present = true)
        AND f.family_type IN ('local_visitor', 'traveller_visitor')
        AND i.church_id = ?
    `;

    let visitorParams = [gatheringTypeId, sessionId, req.user.church_id];

    // Add search filter if provided
    if (search && search.trim()) {
      visitorQuery += ` AND (CONCAT(i.first_name, ' ', i.last_name) LIKE ? OR f.family_name LIKE ?)`;
      const searchTerm = `%${search.trim()}%`;
      visitorParams.push(searchTerm, searchTerm);
    }

    visitorQuery += ` ORDER BY i.last_attendance_date DESC, f.family_name`;

    const allPotentialVisitors = await Database.query(visitorQuery, visitorParams);

    // Filter visitors based on service-based logic (not when searching)
    const potentialVisitors = search && search.trim() ? 
      allPotentialVisitors : 
      allPotentialVisitors.filter(visitor => {
        const currentDate = new Date(date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const isPastGathering = currentDate < today;
        
        // For archived visitors: only show them if they have attendance records for past gatherings
        if (visitor.is_active === false || visitor.is_active === 0) {
          // For past gatherings: show archived visitors only if they have attendance records
          if (isPastGathering) {
            return visitor.present === 1 || visitor.present === true;
          }
          // For current/future gatherings: don't show archived visitors
          return false;
        }
        
        // For active visitors: apply normal service date filtering
        if (!visitor.last_attended) return true; // Include visitors who have never attended
        
        const relevantServiceDates = visitor.people_type === 'local_visitor' ? 
          localServiceDates : travellerServiceDates;
        
        // Check if visitor's last attendance was within the relevant service dates
        const lastAttendedStr = visitor.last_attended.toISOString().split('T')[0];
        
        // Debug logging for specific families
        if (visitor.name && (visitor.name.includes('REMMINGA') || visitor.name.includes('JARVELA') || visitor.name.includes('Vanderschoor'))) {
          console.log('🔍 Visitor filtering debug:', {
            name: visitor.name,
            people_type: visitor.people_type,
            last_attended: lastAttendedStr,
            relevantServiceDates: relevantServiceDates.map(s => s.session_date ? s.session_date.toISOString().split('T')[0] : 'undefined'),
            shouldAppear: relevantServiceDates.some(serviceDate => {
              const serviceDateStr = serviceDate.session_date ? serviceDate.session_date.toISOString().split('T')[0] : 'undefined';
              return lastAttendedStr >= serviceDateStr;
            })
          });
        }
        
        // Check if visitor's last attendance is within the time window (on or after the oldest service date)
        if (relevantServiceDates.length === 0) return false;
        
        // Get the oldest service date (last in the array since they're ordered DESC)
        const oldestServiceDate = relevantServiceDates[relevantServiceDates.length - 1];
        if (!oldestServiceDate || !oldestServiceDate.session_date) return false;
        
        const oldestServiceDateStr = oldestServiceDate.session_date.toISOString().split('T')[0];
        return lastAttendedStr >= oldestServiceDateStr;
      });

    // Use systematic conversion utility to handle BigInt and snake_case to camelCase conversion
    const responseData = processApiResponse({
      attendanceList: attendanceList.map(attendee => ({
        ...attendee,
        present: attendee.present === 1 || attendee.present === true,
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
    const { attendanceRecords, visitors } = req.body;

    logger.debugLog('GENERIC ROUTE MATCHED', {
      path: req.path,
      gatheringTypeId,
      date,
      body: req.body
    });

    logger.debugLog('Recording attendance', { gatheringTypeId, date, attendanceRecords, visitors });

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
          ON DUPLICATE KEY UPDATE updated_at = NOW()
        `, [gatheringTypeId, date, req.user.id, req.user.church_id]);
      } else {
        sessionResult = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE updated_at = NOW()
        `, [gatheringTypeId, date, req.user.id]);
      }

      logger.debugLog('Session result', sessionResult);

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = Number(sessionResult.insertId);
      } else {
        // If no insertId, the session already exists, so get its ID
        const sessions = hasSessionsChurchId
          ? await conn.query(
              'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
              [gatheringTypeId, date, req.user.church_id]
            )
          : await conn.query(
              'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
              [gatheringTypeId, date]
            );
        if (sessions.length === 0) {
          throw new Error('Failed to create or retrieve attendance session');
        }
        sessionId = Number(sessions[0].id);
      }

      logger.debugLog('Session ID', sessionId);

      // Update individual attendance records with better concurrency handling
      if (attendanceRecords && attendanceRecords.length > 0) {
        for (const record of attendanceRecords) {
          // Use REPLACE INTO to handle concurrent updates more reliably
          if (hasAttendanceRecordsChurchId) {
            await conn.query(`
              REPLACE INTO attendance_records (session_id, individual_id, present, church_id)
              VALUES (?, ?, ?, ?)
            `, [sessionId, record.individualId, record.present, req.user.church_id]);
          } else {
            await conn.query(`
              REPLACE INTO attendance_records (session_id, individual_id, present)
              VALUES (?, ?, ?)
            `, [sessionId, record.individualId, record.present]);
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

    res.json({ message: 'Attendance recorded successfully' });
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
    
    // Get visitor configuration for this church
    const visitorConfig = await getVisitorConfig(req.user.church_id);
    
    // Get the last N service dates for filtering
    const localServiceDates = await getLastNServiceDates(gatheringTypeId, req.user.church_id, visitorConfig.localVisitorServiceLimit);
    const travellerServiceDates = await getLastNServiceDates(gatheringTypeId, req.user.church_id, visitorConfig.travellerVisitorServiceLimit);
    
    // Get all visitor families who have attended this gathering OR were created recently
    const allVisitorFamilies = await Database.query(`
      SELECT DISTINCT 
        f.id as family_id,
        f.family_name,
        f.family_notes,
        f.family_type,
        COALESCE(f.last_attended, f.created_at) as last_activity,
        GROUP_CONCAT(CONCAT(i.first_name, ' ', i.last_name) ORDER BY i.first_name SEPARATOR ' & ') as member_names,
        GROUP_CONCAT(DISTINCT i.people_type ORDER BY i.people_type SEPARATOR ',') as people_types
      FROM families f
      JOIN individuals i ON f.id = i.family_id
      WHERE f.family_type IN ('local_visitor', 'traveller_visitor')
        AND i.people_type IN ('local_visitor', 'traveller_visitor')
        AND i.is_active = true
        AND f.church_id = ?
        AND EXISTS (
          SELECT 1 FROM attendance_records ar2 
          JOIN attendance_sessions s2 ON ar2.session_id = s2.id 
          WHERE ar2.individual_id = i.id AND s2.gathering_type_id = ? AND ar2.church_id = ?
        )
      GROUP BY f.id
      ORDER BY last_activity DESC, f.family_name
    `, [req.user.church_id, gatheringTypeId, req.user.church_id]);
    
    // Filter families based on service dates
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    
    const recentVisitorFamilies = allVisitorFamilies.filter(family => {
      // Apply service-based filtering for all families (remove the 2-month bypass)
      const familyTypes = family.people_types.split(',');
      const isLocal = familyTypes.includes('local_visitor');
      const relevantServiceDates = isLocal ? localServiceDates : travellerServiceDates;
      
      if (!family.last_activity) return false;
      
      const lastActivityStr = family.last_activity.toISOString().split('T')[0];
      
      // Debug logging for REMMINGA family in recent visitors
      if (family.family_name && family.family_name.includes('REMMINGA')) {
        console.log('🔍 REMMINGA recent visitors filtering debug:', {
          family_name: family.family_name,
          family_type: family.family_type,
          people_types: family.people_types,
          last_activity: lastActivityStr,
          isLocal: isLocal,
          relevantServiceDates: relevantServiceDates.map(s => s.session_date ? s.session_date.toISOString().split('T')[0] : 'undefined'),
          shouldAppear: relevantServiceDates.some(serviceDate => {
            const serviceDateStr = serviceDate.session_date ? serviceDate.session_date.toISOString().split('T')[0] : 'undefined';
            return lastActivityStr >= serviceDateStr;
          })
        });
      }
      
      // Check if visitor's last activity is within the time window (on or after the oldest service date)
      if (relevantServiceDates.length === 0) return false;
      
      // Get the oldest service date (last in the array since they're ordered DESC)
      const oldestServiceDate = relevantServiceDates[relevantServiceDates.length - 1];
      if (!oldestServiceDate || !oldestServiceDate.session_date) return false;
      
      const oldestServiceDateStr = oldestServiceDate.session_date.toISOString().split('T')[0];
      return lastActivityStr >= oldestServiceDateStr;
    });

    // Convert family data to individual visitor format to match main API
    const processedVisitors = [];
    
    for (const family of recentVisitorFamilies) {
      // Get individual family members
      const familyMembers = await Database.query(`
        SELECT id, first_name, last_name, people_type
        FROM individuals 
        WHERE family_id = ? AND is_active = true AND church_id = ?
        ORDER BY first_name
      `, [family.family_id, req.user.church_id]);
      
      // Create visitor object for each individual
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
        AND i.is_active = true
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
        WHERE family_id = ? AND is_active = true AND church_id = ?
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
        ON DUPLICATE KEY UPDATE created_by = VALUES(created_by), updated_at = NOW()
      `, [gatheringTypeId, date, req.user.id, req.user.church_id]);

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = Number(sessionResult.insertId);
      } else {
        const sessions = await conn.query(
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
          [gatheringTypeId, date, req.user.church_id]
        );
        sessionId = Number(sessions[0].id);
      }

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

        const familyResult = await conn.query(`
            INSERT INTO families (family_name, created_by, church_id)
            VALUES (?, ?, ?)
          `, [finalFamilyName, req.user.id, req.user.church_id]);
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
            INSERT INTO individuals (first_name, last_name, family_id, people_type, created_by, church_id)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [firstName, lastName, familyId, visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor', req.user.id, req.user.church_id]);

          individualId = Number(individualResult.insertId);
        } else {
          // Use existing
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
        ON DUPLICATE KEY UPDATE created_by = VALUES(created_by), updated_at = NOW()
      `, [gatheringTypeId, date, req.user.id, req.user.church_id]);

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = Number(sessionResult.insertId);
      } else {
        const sessions = await conn.query(
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
          [gatheringTypeId, date, req.user.church_id]
        );
        sessionId = Number(sessions[0].id);
      }

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
        const familyResult = await conn.query(
          'INSERT INTO families (family_name, created_by, church_id) VALUES (?, ?, ?)',
          [finalFamilyName, req.user.id, req.user.church_id]
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
          'INSERT INTO individuals (first_name, last_name, family_id, people_type, created_by, church_id) VALUES (?, ?, ?, ?, ?, ?)',
          [firstName, lastName, familyId, visitorType === 'potential_regular' ? 'local_visitor' : 'traveller_visitor', req.user.id, req.user.church_id]
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
          
          const familyResult = await conn.query(`
            INSERT INTO families (family_name) VALUES (?)
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
            AND is_active = true
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
          'SELECT id, first_name, last_name FROM individuals WHERE family_id = ? AND is_active = true AND church_id = ?',
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
    const { gatheringTypeId, date, familyId } = req.params;

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
          ON DUPLICATE KEY UPDATE created_by = VALUES(created_by), updated_at = NOW()
        `, [gatheringTypeId, date, req.user.id, req.user.church_id]);
      } else {
        sessionResult = await conn.query(`
          INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
          VALUES (?, ?, ?)
          ON DUPLICATE KEY UPDATE created_by = VALUES(created_by), updated_at = NOW()
        `, [gatheringTypeId, date, req.user.id]);
      }

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = Number(sessionResult.insertId);
      } else {
        const sessions = hasSessionsChurchId
          ? await conn.query(
              'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ? AND church_id = ?',
              [gatheringTypeId, date, req.user.church_id]
            )
          : await conn.query(
              'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
              [gatheringTypeId, date]
            );
        sessionId = Number(sessions[0].id);
      }

      // Get all individuals in the visitor family
      const individuals = await conn.query(`
        SELECT id, first_name, last_name 
        FROM individuals 
        WHERE family_id = ? AND is_active = true
      `, [familyId]);

      if (individuals.length === 0) {
        return res.status(400).json({ error: 'No individuals found in visitor family' });
      }

      const createdIndividuals = [];

      // Add each individual to the gathering list and mark as present
      for (const individual of individuals) {
        // Add to gathering list if not already there
        const existingGatheringList = await conn.query(`
          SELECT id FROM gathering_lists 
          WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?
        `, [gatheringTypeId, individual.id, req.user.church_id]);

        if (existingGatheringList.length === 0) {
        await conn.query(`
          INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
          VALUES (?, ?, ?, ?)
        `, [gatheringTypeId, individual.id, req.user.id, req.user.church_id]);
        }

        // Mark as present in attendance records
      await conn.query(`
        INSERT INTO attendance_records (session_id, individual_id, present, church_id)
        VALUES (?, ?, true, ?)
        ON DUPLICATE KEY UPDATE present = VALUES(present)
      `, [sessionId, individual.id, req.user.church_id]);

        // Update last_attendance_date for the individual
      await conn.query(`
        UPDATE individuals 
        SET last_attendance_date = ? 
        WHERE id = ? AND church_id = ?
      `, [date, individual.id, req.user.church_id]);

        createdIndividuals.push({
          id: Number(individual.id),
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


module.exports = router; 