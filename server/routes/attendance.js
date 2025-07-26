const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireGatheringAccess } = require('../middleware/auth');
const { requireIsVisitorColumn, requireLastAttendedColumn } = require('../utils/databaseSchema');

const router = express.Router();
router.use(verifyToken);

// Get attendance for a specific date and gathering
router.get('/:gatheringTypeId/:date', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    
    // Get attendance session
    const sessions = await Database.query(`
      SELECT id FROM attendance_sessions 
      WHERE gathering_type_id = ? AND session_date = ?
    `, [gatheringTypeId, date]);

    let sessionId = null;
    let visitors = [];

    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      
      // Get visitors for this session
      visitors = await Database.query(`
        SELECT id, name, visitor_type, visitor_family_group, notes, last_attended
        FROM visitors 
        WHERE session_id = ?
        ORDER BY name
      `, [sessionId]);
    }

    // Get regular attendees with attendance status (always return the list)
    const attendanceList = await Database.query(`
      SELECT i.id, i.first_name, i.last_name, f.family_name, f.id as family_id,
             COALESCE(ar.present, false) as present
      FROM gathering_lists gl
      JOIN individuals i ON gl.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
      WHERE gl.gathering_type_id = ? AND i.is_active = true
      ORDER BY i.last_name, i.first_name
    `, [sessionId, gatheringTypeId]);

    // Convert BigInt values to regular numbers to avoid JSON serialization issues
    // Also convert snake_case to camelCase for frontend compatibility
    const processedAttendanceList = attendanceList.map(attendee => ({
      id: Number(attendee.id),
      firstName: attendee.first_name,
      lastName: attendee.last_name,
      familyName: attendee.family_name,
      familyId: attendee.family_id ? Number(attendee.family_id) : null,
      present: Boolean(attendee.present)
    }));

    const processedVisitors = visitors.map(visitor => ({
      id: Number(visitor.id),
      name: visitor.name,
      visitorType: visitor.visitor_type,
      visitorFamilyGroup: visitor.visitor_family_group,
      notes: visitor.notes,
      lastAttended: visitor.last_attended
    }));

    res.json({ attendanceList: processedAttendanceList, visitors: processedVisitors });
  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ error: 'Failed to retrieve attendance.' });
  }
});

// Record attendance
router.post('/:gatheringTypeId/:date', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { attendanceRecords, visitors } = req.body;

    console.log('Recording attendance:', { gatheringTypeId, date, attendanceRecords, visitors });

    await Database.transaction(async (conn) => {
      // Create or get attendance session
      let sessionResult = await conn.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, recorded_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE recorded_by = VALUES(recorded_by), updated_at = NOW()
      `, [gatheringTypeId, date, req.user.id]);

      console.log('Session result:', sessionResult);

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = sessionResult.insertId;
      } else {
        const sessions = await conn.query(
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
          [gatheringTypeId, date]
        );
        sessionId = sessions[0].id;
      }

      console.log('Session ID:', sessionId);

      // Clear existing attendance records and visitors
      await conn.query('DELETE FROM attendance_records WHERE session_id = ?', [sessionId]);
      await conn.query('DELETE FROM visitors WHERE session_id = ?', [sessionId]);

      // Insert attendance records
      if (attendanceRecords && attendanceRecords.length > 0) {
        const values = attendanceRecords.map(record => [sessionId, record.individualId, record.present]);
        console.log('Inserting attendance records:', values);
        await conn.batch(
          'INSERT INTO attendance_records (session_id, individual_id, present) VALUES (?, ?, ?)',
          values
        );
      }

      // Insert visitors
      if (visitors && visitors.length > 0) {
        for (const visitor of visitors) {
          await conn.query(`
            INSERT INTO visitors (session_id, name, visitor_type, visitor_family_group, notes, last_attended)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [sessionId, visitor.name, visitor.visitorType, visitor.visitorFamilyGroup, visitor.notes, date]);
        }
      }
    });

    res.json({ message: 'Attendance recorded successfully' });
  } catch (error) {
    console.error('Record attendance error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to record attendance.', details: error.message });
  }
});

// Get recent visitors (for suggestions)
router.get('/:gatheringTypeId/visitors/recent', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId } = req.params;
    
    // Check if last_attended column exists
    await requireLastAttendedColumn();
    
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    
    // Get visitors who attended in the last 2 months
    const recentVisitors = await Database.query(`
      SELECT DISTINCT v.name, v.visitor_type, v.visitor_family_group, v.notes, v.last_attended
      FROM visitors v
      JOIN attendance_sessions s ON v.session_id = s.id
      WHERE s.gathering_type_id = ? 
        AND v.last_attended >= ?
      ORDER BY v.last_attended DESC, v.name
    `, [gatheringTypeId, twoMonthsAgo.toISOString().split('T')[0]]);

    const processedVisitors = recentVisitors.map(visitor => ({
      name: visitor.name,
      visitorType: visitor.visitor_type,
      visitorFamilyGroup: visitor.visitor_family_group,
      notes: visitor.notes,
      lastAttended: visitor.last_attended
    }));

    res.json({ visitors: processedVisitors });
  } catch (error) {
    console.error('Get recent visitors error:', error);
    res.status(500).json({ error: 'Failed to retrieve recent visitors.' });
  }
});

// Add visitor to a session and create individual
router.post('/:gatheringTypeId/:date/visitors', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { name, visitorType, visitorFamilyGroup, notes } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Visitor name is required' });
    }

    // Check if is_visitor column exists
    await requireIsVisitorColumn();

    await Database.transaction(async (conn) => {
      // Get or create attendance session
      let sessionResult = await conn.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, recorded_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE recorded_by = VALUES(recorded_by), updated_at = NOW()
      `, [gatheringTypeId, date, req.user.id]);

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = sessionResult.insertId;
      } else {
        const sessions = await conn.query(
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
          [gatheringTypeId, date]
        );
        sessionId = sessions[0].id;
      }

      // Parse visitor name to extract individual names
      const nameParts = name.trim().split(' & ');
      const individuals = [];

      for (const namePart of nameParts) {
        const personParts = namePart.trim().split(' ');
        const firstName = personParts[0] || 'Unknown';
        const lastName = personParts.slice(1).join(' ') || 'Unknown';

        // Check if individual already exists
        const existingIndividual = await conn.query(`
          SELECT id FROM individuals 
          WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?)
        `, [firstName, lastName]);

        if (existingIndividual.length === 0) {
          // Create new individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, is_visitor, created_by)
            VALUES (?, ?, true, ?)
          `, [firstName, lastName, req.user.id]);

          const individualId = individualResult.insertId;

          // Add to gathering list
          await conn.query(`
            INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
            VALUES (?, ?, ?)
          `, [gatheringTypeId, individualId, req.user.id]);

          // Mark as present in attendance
          await conn.query(`
            INSERT INTO attendance_records (session_id, individual_id, present)
            VALUES (?, ?, true)
          `, [sessionId, individualId]);

          individuals.push({
            id: individualId,
            firstName,
            lastName
          });
        } else {
          // Individual exists, just mark as present if not already
          const individualId = existingIndividual[0].id;
          
          // Check if already in gathering list
          const inGathering = await conn.query(`
            SELECT 1 FROM gathering_lists 
            WHERE gathering_type_id = ? AND individual_id = ?
          `, [gatheringTypeId, individualId]);

          if (inGathering.length === 0) {
            // Add to gathering list
            await conn.query(`
              INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
              VALUES (?, ?, ?)
            `, [gatheringTypeId, individualId, req.user.id]);
          }

          // Mark as present in attendance
          const existingAttendance = await conn.query(`
            SELECT 1 FROM attendance_records 
            WHERE session_id = ? AND individual_id = ?
          `, [sessionId, individualId]);

          if (existingAttendance.length === 0) {
            await conn.query(`
              INSERT INTO attendance_records (session_id, individual_id, present)
              VALUES (?, ?, true)
            `, [sessionId, individualId]);
          }

          individuals.push({
            id: individualId,
            firstName,
            lastName
          });
        }
      }

      // Also add to visitors table for historical tracking
      const visitorResult = await conn.query(`
        INSERT INTO visitors (session_id, name, visitor_type, visitor_family_group, notes, last_attended)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [sessionId, name.trim(), visitorType || 'temporary_other', visitorFamilyGroup || null, notes || null, date]);

      res.json({ 
        message: 'Visitor added successfully and converted to individual',
        visitorId: Number(visitorResult.insertId),
        individuals: individuals
      });
    });

  } catch (error) {
    console.error('Add visitor error:', error);
    res.status(500).json({ error: 'Failed to add visitor.' });
  }
});

module.exports = router; 