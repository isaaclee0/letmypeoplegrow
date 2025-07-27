const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const moment = require('moment');

const router = express.Router();
router.use(verifyToken);

// Get dashboard metrics
router.get('/dashboard', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { gatheringTypeId, weeks = 4 } = req.query;
    
    console.log('Getting dashboard metrics:', { gatheringTypeId, weeks });
    
    // Get attendance sessions and records for the specified period
    const attendanceData = await Database.query(`
      SELECT 
        as_table.session_date,
        as_table.gathering_type_id,
        COUNT(DISTINCT ar.individual_id) as present_count,
        COUNT(DISTINCT CASE WHEN ar.present = true THEN ar.individual_id END) as present_individuals,
        COUNT(DISTINCT CASE WHEN ar.present = false THEN ar.individual_id END) as absent_individuals
      FROM attendance_sessions as_table
      LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
      WHERE as_table.session_date >= DATE_SUB(CURDATE(), INTERVAL ? WEEK)
      ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
      GROUP BY as_table.session_date, as_table.gathering_type_id
      ORDER BY as_table.session_date DESC
    `, gatheringTypeId ? [weeks, gatheringTypeId] : [weeks]);

    console.log('Attendance data:', attendanceData);

    // Calculate basic metrics
    const totalSessions = attendanceData.length;
    const totalPresent = attendanceData.reduce((sum, session) => sum + (session.present_individuals || 0), 0);
    const totalAbsent = attendanceData.reduce((sum, session) => sum + (session.absent_individuals || 0), 0);
    const averageAttendance = totalSessions > 0 ? Math.round(totalPresent / totalSessions) : 0;
    
    // Calculate growth rate with weekly aggregation
    const weeklyData = {};
    attendanceData.forEach(session => {
      const week = moment(session.session_date).isoWeek();
      if (!weeklyData[week]) {
        weeklyData[week] = { totalPresent: 0, sessionCount: 0 };
      }
      weeklyData[week].totalPresent += session.present_individuals || 0;
      weeklyData[week].sessionCount += 1;
    });

    const sortedWeeks = Object.keys(weeklyData).sort((a, b) => a - b);
    let growthRate = 0;
    if (sortedWeeks.length >= 2) {
      const firstWeekAvg = weeklyData[sortedWeeks[0]].totalPresent / weeklyData[sortedWeeks[0]].sessionCount;
      const lastWeekAvg = weeklyData[sortedWeeks[sortedWeeks.length - 1]].totalPresent / weeklyData[sortedWeeks[sortedWeeks.length - 1]].sessionCount;
      if (firstWeekAvg > 0) {
        growthRate = Math.round(((lastWeekAvg - firstWeekAvg) / firstWeekAvg) * 100);
      } else if (lastWeekAvg > 0) {
        growthRate = 100; // From 0 to positive, consider 100% growth
      }
    }

    // Get total individuals for context
    const totalIndividuals = await Database.query(`
      SELECT COUNT(DISTINCT i.id) as total
      FROM individuals i
      JOIN families f ON i.family_id = f.id
      WHERE i.is_active = true
      ${gatheringTypeId ? 'AND f.gathering_type_id = ?' : ''}
    `, gatheringTypeId ? [gatheringTypeId] : []);

    const metrics = {
      totalSessions,
      totalPresent,
      totalAbsent,
      averageAttendance,
      growthRate,
      totalIndividuals: totalIndividuals[0]?.total || 0,
      attendanceData: attendanceData.map(session => ({
        date: session.session_date,
        present: session.present_individuals || 0,
        absent: session.absent_individuals || 0,
        total: (session.present_individuals || 0) + (session.absent_individuals || 0)
      }))
    };

    console.log('Calculated metrics:', metrics);

    res.json({ metrics });
  } catch (error) {
    console.error('Get dashboard error:', error);
    res.status(500).json({ error: 'Failed to retrieve dashboard data.' });
  }
});

module.exports = router; 