const express = require('express');
const { body, validationResult } = require('express-validator');
const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');
const { ensureChurchIsolation } = require('../middleware/churchIsolation');
const { processApiResponse } = require('../utils/caseConverter');

const router = express.Router();
router.use(verifyToken);
router.use(ensureChurchIsolation);

// Get gathering types
router.get('/', async (req, res) => {
  try {
    let gatherings;
    
    // Admin users can see all gatherings, other users only see their assigned gatherings
    if (req.user.role === 'admin') {
      gatherings = await Database.query(`
        SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.end_time, gt.frequency, gt.attendance_type, gt.custom_schedule, gt.kiosk_enabled, gt.kiosk_end_time, gt.is_active, gt.created_at,
               COUNT(DISTINCT CASE WHEN gl_indiv.is_active = true AND gl_indiv.people_type = 'regular' THEN gl.individual_id END) as member_count,
               COUNT(DISTINCT CASE WHEN ar.individual_id IS NOT NULL AND i.people_type IN ('local_visitor', 'traveller_visitor') AND as_table.session_date >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH) AND ar.present = true THEN ar.individual_id END) as recent_visitor_count
        FROM gathering_types gt
        LEFT JOIN gathering_lists gl ON gt.id = gl.gathering_type_id
        LEFT JOIN individuals gl_indiv ON gl.individual_id = gl_indiv.id
        LEFT JOIN attendance_sessions as_table ON gt.id = as_table.gathering_type_id
        LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
        LEFT JOIN individuals i ON ar.individual_id = i.id
        WHERE gt.is_active = true AND gt.church_id = ?
        GROUP BY gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.end_time, gt.frequency, gt.attendance_type, gt.custom_schedule, gt.kiosk_enabled, gt.kiosk_end_time, gt.is_active, gt.created_at
        ORDER BY gt.id
      `, [req.user.church_id]);
    } else {
      gatherings = await Database.query(`
        SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.end_time, gt.frequency, gt.attendance_type, gt.custom_schedule, gt.kiosk_enabled, gt.kiosk_end_time, gt.is_active, gt.created_at,
               COUNT(DISTINCT CASE WHEN gl_indiv.is_active = true AND gl_indiv.people_type = 'regular' THEN gl.individual_id END) as member_count,
               COUNT(DISTINCT CASE WHEN ar.individual_id IS NOT NULL AND i.people_type IN ('local_visitor', 'traveller_visitor') AND as_table.session_date >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH) AND ar.present = true THEN ar.individual_id END) as recent_visitor_count
        FROM gathering_types gt
        LEFT JOIN gathering_lists gl ON gt.id = gl.gathering_type_id
        LEFT JOIN individuals gl_indiv ON gl.individual_id = gl_indiv.id
        LEFT JOIN attendance_sessions as_table ON gt.id = as_table.gathering_type_id
        LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
        LEFT JOIN individuals i ON ar.individual_id = i.id
        JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
        WHERE gt.is_active = true AND uga.user_id = ? AND gt.church_id = ?
        GROUP BY gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.end_time, gt.frequency, gt.attendance_type, gt.custom_schedule, gt.kiosk_enabled, gt.kiosk_end_time, gt.is_active, gt.created_at
        ORDER BY gt.id
      `, [req.user.id, req.user.church_id]);
    }
    
    // Use systematic conversion utility for field name conversion and BigInt handling
    const responseData = processApiResponse({ gatherings });
    
    res.json(responseData);
  } catch (error) {
    console.error('Get gatherings error:', error);
    res.status(500).json({ error: 'Failed to retrieve gatherings.' });
  }
});

// Create gathering type (Admin/Coordinator)
router.post('/', 
  requireRole(['admin', 'coordinator']), 
  auditLog('CREATE_GATHERING_TYPE'),
  [
    body('name')
      .trim()
      .isLength({ min: 1, max: 255 })
      .withMessage('Gathering name is required and must be less than 255 characters'),
    body('description')
      .optional()
      .trim(),
    body('dayOfWeek')
      .optional()
      .isIn(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
      .withMessage('Valid day of week is required'),
    body('startTime')
      .optional()
      .matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Valid start time is required (HH:MM format)'),
    body('frequency')
      .optional()
      .isIn(['weekly', 'biweekly', 'monthly'])
      .withMessage('Valid frequency is required'),
    body('attendanceType')
      .isIn(['standard', 'headcount'])
      .withMessage('Valid attendance type is required'),
    body('customSchedule')
      .optional()
      .custom((value) => {
        if (value && typeof value === 'object') {
          // Basic validation for custom schedule structure
          if (!value.type || !['one_off', 'recurring'].includes(value.type)) {
            throw new Error('Custom schedule must have valid type');
          }
          if (!value.startDate) {
            throw new Error('Custom schedule must have startDate');
          }
          if (value.type === 'recurring' && !value.endDate) {
            throw new Error('Recurring schedule must have endDate');
          }
        }
        return true;
      })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, description, dayOfWeek, startTime, endTime, frequency, attendanceType, customSchedule, setAsDefault, kioskEnabled, kioskEndTime, kioskMessage } = req.body;
    
    // Validate that standard gatherings have required fields
    if (attendanceType === 'standard' && (!dayOfWeek || !startTime || !frequency)) {
      return res.status(400).json({ 
        error: 'Standard gatherings require day of week, start time, and frequency' 
      });
    }

    // Validate that headcount gatherings have custom schedule or basic schedule
    if (attendanceType === 'headcount' && (!customSchedule || Object.keys(customSchedule).length === 0) && (!dayOfWeek || !startTime || !frequency)) {
      return res.status(400).json({ 
        error: 'Headcount gatherings require either a custom schedule or basic schedule fields' 
      });
    }
    
    // For headcount gatherings with custom schedules, don't save conflicting regular schedule fields
    const hasCustomSchedule = customSchedule && Object.keys(customSchedule).length > 0;
    const isHeadcountWithCustom = attendanceType === 'headcount' && hasCustomSchedule;
    
    const result = await Database.query(`
      INSERT INTO gathering_types (name, description, day_of_week, start_time, end_time, frequency, attendance_type, custom_schedule, kiosk_enabled, kiosk_end_time, kiosk_message, created_by, church_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      description,
      isHeadcountWithCustom ? null : dayOfWeek,
      isHeadcountWithCustom ? null : startTime,
      isHeadcountWithCustom ? null : (endTime || null),
      isHeadcountWithCustom ? null : (frequency || 'weekly'),
      attendanceType,
      customSchedule ? JSON.stringify(customSchedule) : null,
      attendanceType === 'standard' && kioskEnabled ? true : false,
      kioskEndTime || null,
      kioskMessage || null,
      req.user.id,
      req.user.church_id
    ]);

    // Auto-assign creator to the gathering
    await Database.query(`
      INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by, church_id)
      VALUES (?, ?, ?, ?)
    `, [req.user.id, result.insertId, req.user.id, req.user.church_id]);

    // Set as default gathering if requested
    if (setAsDefault) {
      await Database.query(`
        UPDATE users SET default_gathering_id = ? WHERE id = ?
      `, [result.insertId, req.user.id]);
    }

    const responseData = processApiResponse({ 
      message: 'Gathering type created', 
      id: result.insertId,
      setAsDefault: !!setAsDefault
    });
    
    res.status(201).json(responseData);
  } catch (error) {
    console.error('Create gathering error:', error);
    console.error('Request body:', req.body);
    res.status(500).json({ error: 'Failed to create gathering type.' });
  }
});

// Check if gathering has attendance records
const hasAttendanceRecords = async (gatheringId, churchId) => {
  const result = await Database.query(`
    SELECT COUNT(*) as count 
    FROM attendance_sessions 
    WHERE gathering_type_id = ? AND church_id = ?
  `, [gatheringId, churchId]);
  
  return result[0].count > 0;
};

// Update gathering type (Admin/Coordinator)
router.put('/:id', requireRole(['admin', 'coordinator']), auditLog('UPDATE_GATHERING_TYPE'), async (req, res) => {
  try {
    const gatheringId = parseInt(req.params.id);
    const { name, description, dayOfWeek, startTime, endTime, frequency, attendanceType, customSchedule, kioskEnabled, kioskEndTime, kioskMessage } = req.body;
    
    // Verify user has access to this gathering
    const assignments = await Database.query(
      'SELECT id FROM user_gathering_assignments WHERE user_id = ? AND gathering_type_id = ? AND church_id = ?',
      [req.user.id, gatheringId, req.user.church_id]
    );

    if (assignments.length === 0) {
      return res.status(403).json({ error: 'You do not have access to this gathering' });
    }

    // Get current gathering details
    const currentGathering = await Database.query(
      'SELECT attendance_type FROM gathering_types WHERE id = ? AND church_id = ?',
      [gatheringId, req.user.church_id]
    );

    if (currentGathering.length === 0) {
      return res.status(404).json({ error: 'Gathering not found' });
    }
    
    // If changing attendance type, check if there are attendance records
    if (attendanceType && currentGathering[0].attendance_type !== attendanceType) {
      const hasRecords = await hasAttendanceRecords(gatheringId, req.user.church_id);
      if (hasRecords) {
        return res.status(400).json({ 
          error: 'Cannot change gathering type when attendance records exist. Please delete all attendance records first.' 
        });
      }
    }

    // Validate that standard gatherings have required fields
    if (attendanceType === 'standard' && (!dayOfWeek || !startTime || !frequency)) {
      return res.status(400).json({ 
        error: 'Standard gatherings require day of week, start time, and frequency' 
      });
    }

    // Validate that headcount gatherings have custom schedule or basic schedule
    if (attendanceType === 'headcount' && (!customSchedule || Object.keys(customSchedule).length === 0) && (!dayOfWeek || !startTime || !frequency)) {
      return res.status(400).json({ 
        error: 'Headcount gatherings require either a custom schedule or basic schedule fields' 
      });
    }
    
    // For headcount gatherings with custom schedules, don't save conflicting regular schedule fields
    const hasCustomSchedule = customSchedule && Object.keys(customSchedule).length > 0;
    const isHeadcountWithCustom = attendanceType === 'headcount' && hasCustomSchedule;
    
    // Only allow kiosk for standard gatherings
    const kioskValue = attendanceType === 'standard' && kioskEnabled ? true : false;

    const result = await Database.query(`
      UPDATE gathering_types
      SET name = ?, description = ?, day_of_week = ?, start_time = ?, end_time = ?, frequency = ?,
          attendance_type = COALESCE(?, attendance_type),
          custom_schedule = ?,
          kiosk_enabled = ?,
          kiosk_end_time = ?,
          kiosk_message = ?
      WHERE id = ? AND church_id = ?
    `, [
      name,
      description,
      isHeadcountWithCustom ? null : dayOfWeek,
      isHeadcountWithCustom ? null : startTime,
      isHeadcountWithCustom ? null : (endTime || null),
      isHeadcountWithCustom ? null : (frequency || 'weekly'),
      attendanceType,
      customSchedule ? JSON.stringify(customSchedule) : null,
      kioskValue,
      kioskEndTime || null,
      kioskMessage || null,
      gatheringId,
      req.user.church_id
    ]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Gathering not found' });
    }

    res.json({ 
      message: 'Gathering updated successfully',
      id: gatheringId
    });
  } catch (error) {
    console.error('Update gathering error:', error);
    res.status(500).json({ error: 'Failed to update gathering type.' });
  }
});

// Get gathering members
router.get('/:id/members', async (req, res) => {
  try {
    const { id } = req.params;
    
    const members = await Database.query(`
      SELECT i.id, i.first_name, i.last_name, f.family_name
      FROM gathering_lists gl
      JOIN individuals i ON gl.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      WHERE gl.gathering_type_id = ? AND gl.church_id = ?
      ORDER BY i.last_name, i.first_name
    `, [id, req.user.church_id]);
    
    // Use systematic conversion utility for field name conversion and BigInt handling
    const responseData = processApiResponse({ members });
    res.json(responseData);
  } catch (error) {
    console.error('Get gathering members error:', error);
    res.status(500).json({ error: 'Failed to retrieve gathering members.' });
  }
});

// Duplicate a gathering
router.post('/:id/duplicate', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'New gathering name is required.' });
    }
    
    // Check if gathering exists and user has access
    const gathering = await Database.query(`
      SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.frequency, 
             gt.attendance_type, gt.custom_schedule, gt.group_by_family, gt.is_active, gt.created_at
      FROM gathering_types gt
      LEFT JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
      WHERE gt.id = ? AND gt.church_id = ? AND (
        ? = 'admin' OR uga.user_id = ?
      )
    `, [id, req.user.church_id, req.user.role, req.user.id]);
    
    if (gathering.length === 0) {
      return res.status(404).json({ error: 'Gathering not found or access denied.' });
    }
    
    const originalGathering = gathering[0];
    
    // Check if name already exists
    const existingGathering = await Database.query(
      'SELECT id FROM gathering_types WHERE name = ? AND church_id = ?',
      [name.trim(), req.user.church_id]
    );
    
    if (existingGathering.length > 0) {
      return res.status(400).json({ error: 'A gathering with this name already exists.' });
    }
    
    // Use transaction to ensure data consistency
    const result = await Database.transaction(async (conn) => {
      // Create new gathering with all original details
      // For headcount gatherings with custom schedules, don't save conflicting regular schedule fields
      const hasCustomSchedule = originalGathering.custom_schedule && Object.keys(originalGathering.custom_schedule).length > 0;
      const isHeadcountWithCustom = originalGathering.attendance_type === 'headcount' && hasCustomSchedule;
      
      const insertResult = await conn.query(`
        INSERT INTO gathering_types (
          name, description, day_of_week, start_time, end_time, frequency,
          attendance_type, custom_schedule, group_by_family, church_id, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        name.trim(),
        originalGathering.description,
        isHeadcountWithCustom ? null : originalGathering.day_of_week,
        isHeadcountWithCustom ? null : originalGathering.start_time,
        isHeadcountWithCustom ? null : originalGathering.end_time,
        isHeadcountWithCustom ? null : originalGathering.frequency,
        originalGathering.attendance_type,
        originalGathering.custom_schedule ? JSON.stringify(originalGathering.custom_schedule) : null,
        originalGathering.group_by_family !== undefined ? originalGathering.group_by_family : true,
        req.user.church_id,
        req.user.id
      ]);
      
      const newGatheringId = insertResult.insertId;
      
      // Copy people assignments (gathering_lists)
      await conn.query(`
        INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
        SELECT ?, individual_id, ?, ?
        FROM gathering_lists 
        WHERE gathering_type_id = ? AND church_id = ?
      `, [newGatheringId, req.user.id, req.user.church_id, id, req.user.church_id]);
      
      // Copy user assignments (user_gathering_assignments)
      await conn.query(`
        INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by, church_id)
        SELECT user_id, ?, ?, ?
        FROM user_gathering_assignments 
        WHERE gathering_type_id = ? AND church_id = ?
      `, [newGatheringId, req.user.id, req.user.church_id, id, req.user.church_id]);
      
      return newGatheringId;
    });
    
    // Get the new gathering details
    const newGathering = await Database.query(`
      SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.frequency, 
             gt.attendance_type, gt.custom_schedule, gt.is_active, gt.created_at,
             COUNT(DISTINCT gl.individual_id) as member_count
      FROM gathering_types gt
      LEFT JOIN gathering_lists gl ON gt.id = gl.gathering_type_id
      WHERE gt.id = ? AND gt.church_id = ?
      GROUP BY gt.id
    `, [result, req.user.church_id]);
    
    res.status(201).json({
      message: 'Gathering duplicated successfully.',
      gathering: newGathering[0]
    });
    
  } catch (error) {
    console.error('Duplicate gathering error:', error);
    res.status(500).json({ error: 'Failed to duplicate gathering.' });
  }
});

// Delete gathering type (Admin only)
router.delete('/:id', requireRole(['admin']), auditLog('DELETE_GATHERING_TYPE'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if gathering exists and user has permission
    const gathering = await Database.query(
      'SELECT id FROM gathering_types WHERE id = ? AND created_by = ? AND church_id = ?',
      [id, req.user.id, req.user.church_id]
    );
    
    if (gathering.length === 0) {
      return res.status(404).json({ error: 'Gathering not found or access denied.' });
    }
    
    // Delete gathering lists (member associations)
    await Database.query('DELETE FROM gathering_lists WHERE gathering_type_id = ? AND church_id = ?', [id, req.user.church_id]);
    
    // Delete user assignments
    await Database.query('DELETE FROM user_gathering_assignments WHERE gathering_type_id = ? AND church_id = ?', [id, req.user.church_id]);
    
    // Delete the gathering type
    await Database.query('DELETE FROM gathering_types WHERE id = ? AND church_id = ?', [id, req.user.church_id]);
    
    res.json({ message: 'Gathering deleted successfully.' });
  } catch (error) {
    console.error('Delete gathering error:', error);
    res.status(500).json({ error: 'Failed to delete gathering.' });
  }
});

module.exports = router; 