const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Get gathering types
router.get('/', async (req, res) => {
  try {
    let gatherings;
    
    // Admin users can see all gatherings, other users only see their assigned gatherings
    if (req.user.role === 'admin') {
      gatherings = await Database.query(`
        SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.duration_minutes, gt.frequency, gt.is_active, gt.created_at,
               COUNT(DISTINCT gl.individual_id) as member_count,
               COUNT(DISTINCT CASE WHEN v.session_id IS NOT NULL AND as_table.session_date >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH) THEN v.id END) as recent_visitor_count
        FROM gathering_types gt
        LEFT JOIN gathering_lists gl ON gt.id = gl.gathering_type_id
        LEFT JOIN attendance_sessions as_table ON gt.id = as_table.gathering_type_id
        LEFT JOIN visitors v ON as_table.id = v.session_id
        WHERE gt.is_active = true
        GROUP BY gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.duration_minutes, gt.frequency, gt.is_active, gt.created_at
        ORDER BY gt.name
      `);
    } else {
      gatherings = await Database.query(`
        SELECT gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.duration_minutes, gt.frequency, gt.is_active, gt.created_at,
               COUNT(DISTINCT gl.individual_id) as member_count,
               COUNT(DISTINCT CASE WHEN v.session_id IS NOT NULL AND as_table.session_date >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH) THEN v.id END) as recent_visitor_count
        FROM gathering_types gt
        LEFT JOIN gathering_lists gl ON gt.id = gl.gathering_type_id
        LEFT JOIN attendance_sessions as_table ON gt.id = as_table.gathering_type_id
        LEFT JOIN visitors v ON as_table.id = v.session_id
        JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
        WHERE gt.is_active = true AND uga.user_id = ?
        GROUP BY gt.id, gt.name, gt.description, gt.day_of_week, gt.start_time, gt.duration_minutes, gt.frequency, gt.is_active, gt.created_at
        ORDER BY gt.name
      `, [req.user.id]);
    }
    
    // Convert BigInt values to regular numbers to avoid JSON serialization issues
    // Also convert snake_case to camelCase for frontend compatibility
    const processedGatherings = gatherings.map(gathering => ({
      id: Number(gathering.id),
      name: gathering.name,
      description: gathering.description,
      dayOfWeek: gathering.day_of_week,
      startTime: gathering.start_time,
      durationMinutes: Number(gathering.duration_minutes),
      frequency: gathering.frequency,

      isActive: Boolean(gathering.is_active),
      memberCount: Number(gathering.member_count),
      recentVisitorCount: Number(gathering.recent_visitor_count || 0),
      createdAt: gathering.created_at
    }));
    
    res.json({ gatherings: processedGatherings });
  } catch (error) {
    console.error('Get gatherings error:', error);
    res.status(500).json({ error: 'Failed to retrieve gatherings.' });
  }
});

// Create gathering type (Admin/Coordinator)
router.post('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { name, description, dayOfWeek, startTime, durationMinutes, frequency, setAsDefault } = req.body;
    
    const result = await Database.query(`
      INSERT INTO gathering_types (name, description, day_of_week, start_time, duration_minutes, frequency, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [name, description, dayOfWeek, startTime, durationMinutes || 90, frequency || 'weekly', req.user.id]);

    // Auto-assign creator to the gathering
    await Database.query(`
      INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by)
      VALUES (?, ?, ?)
    `, [req.user.id, result.insertId, req.user.id]);

    // Set as default gathering if requested
    if (setAsDefault) {
      await Database.query(`
        UPDATE users SET default_gathering_id = ? WHERE id = ?
      `, [result.insertId, req.user.id]);
    }

    res.status(201).json({ 
      message: 'Gathering type created', 
      id: result.insertId,
      setAsDefault: !!setAsDefault
    });
  } catch (error) {
    console.error('Create gathering error:', error);
    res.status(500).json({ error: 'Failed to create gathering type.' });
  }
});

// Update gathering type (Admin/Coordinator)
router.put('/:id', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const gatheringId = parseInt(req.params.id);
    const { name, description, dayOfWeek, startTime, durationMinutes, frequency } = req.body;
    
    // Verify user has access to this gathering
    const assignments = await Database.query(
      'SELECT id FROM user_gathering_assignments WHERE user_id = ? AND gathering_type_id = ?',
      [req.user.id, gatheringId]
    );

    if (assignments.length === 0) {
      return res.status(403).json({ error: 'You do not have access to this gathering' });
    }
    
    const result = await Database.query(`
      UPDATE gathering_types 
      SET name = ?, description = ?, day_of_week = ?, start_time = ?, duration_minutes = ?, frequency = ?
      WHERE id = ?
    `, [name, description, dayOfWeek, startTime, durationMinutes || 90, frequency || 'weekly', gatheringId]);

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
      WHERE gl.gathering_type_id = ?
      ORDER BY i.last_name, i.first_name
    `, [id]);
    
    // Convert BigInt values to regular numbers to avoid JSON serialization issues
    // Also convert snake_case to camelCase for frontend compatibility
    const processedMembers = members.map(member => ({
      id: Number(member.id),
      firstName: member.first_name,
      lastName: member.last_name,
      familyName: member.family_name
    }));
    
    res.json({ members: processedMembers });
  } catch (error) {
    console.error('Get gathering members error:', error);
    res.status(500).json({ error: 'Failed to retrieve gathering members.' });
  }
});

// Delete gathering type (Admin only)
router.delete('/:id', requireRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if gathering exists and user has permission
    const gathering = await Database.query(
      'SELECT id FROM gathering_types WHERE id = ? AND created_by = ?',
      [id, req.user.id]
    );
    
    if (gathering.length === 0) {
      return res.status(404).json({ error: 'Gathering not found or access denied.' });
    }
    
    // Delete gathering lists (member associations)
    await Database.query('DELETE FROM gathering_lists WHERE gathering_type_id = ?', [id]);
    
    // Delete user assignments
    await Database.query('DELETE FROM user_gathering_assignments WHERE gathering_type_id = ?', [id]);
    
    // Delete the gathering type
    await Database.query('DELETE FROM gathering_types WHERE id = ?', [id]);
    
    res.json({ message: 'Gathering deleted successfully.' });
  } catch (error) {
    console.error('Delete gathering error:', error);
    res.status(500).json({ error: 'Failed to delete gathering.' });
  }
});

module.exports = router; 