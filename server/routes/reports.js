const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Get dashboard metrics
router.get('/dashboard', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { gatheringTypeId, weeks = 4 } = req.query;
    
    // Basic metrics for now - can be expanded
    const totalAttendance = await Database.query(`
      SELECT COUNT(DISTINCT ar.individual_id) as regular_count,
             COUNT(DISTINCT v.id) as visitor_count,
             as_table.session_date
      FROM attendance_sessions as_table
      LEFT JOIN attendance_records ar ON as_table.id = ar.session_id AND ar.present = true
      LEFT JOIN visitors v ON as_table.id = v.session_id
      WHERE as_table.session_date >= DATE_SUB(CURDATE(), INTERVAL ? WEEK)
      ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
      GROUP BY as_table.session_date
      ORDER BY as_table.session_date DESC
    `, gatheringTypeId ? [weeks, gatheringTypeId] : [weeks]);

    res.json({ metrics: { totalAttendance } });
  } catch (error) {
    console.error('Get dashboard error:', error);
    res.status(500).json({ error: 'Failed to retrieve dashboard data.' });
  }
});

module.exports = router; 