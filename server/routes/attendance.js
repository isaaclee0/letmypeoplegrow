const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireGatheringAccess } = require('../middleware/auth');

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
      
      // Get visitors for existing session
      visitors = await Database.query(`
        SELECT id, name, visitor_type, visitor_family_group, notes
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
      notes: visitor.notes
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

    await Database.transaction(async (conn) => {
      // Create or get attendance session
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

      // Clear existing attendance records
      await conn.query('DELETE FROM attendance_records WHERE session_id = ?', [sessionId]);
      await conn.query('DELETE FROM visitors WHERE session_id = ?', [sessionId]);

      // Insert attendance records
      if (attendanceRecords && attendanceRecords.length > 0) {
        const values = attendanceRecords.map(record => [sessionId, record.individualId, record.present]);
        await conn.batch(
          'INSERT INTO attendance_records (session_id, individual_id, present) VALUES (?, ?, ?)',
          values
        );
      }

      // Insert visitor records
      if (visitors && visitors.length > 0) {
        const visitorValues = visitors.map(visitor => [
          sessionId, visitor.name, visitor.visitorType, visitor.visitorFamilyGroup || null, visitor.notes || null
        ]);
        await conn.batch(
          'INSERT INTO visitors (session_id, name, visitor_type, visitor_family_group, notes) VALUES (?, ?, ?, ?, ?)',
          visitorValues
        );
      }
    });

    res.json({ message: 'Attendance recorded successfully' });
  } catch (error) {
    console.error('Record attendance error:', error);
    res.status(500).json({ error: 'Failed to record attendance.' });
  }
});

module.exports = router; 