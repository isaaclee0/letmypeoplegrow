const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Test endpoint to check database tables
router.get('/test', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    console.log('Testing database tables...');
    
    // First, test basic connection
    const connectionTest = await Database.query('SELECT 1 as test');
    console.log('Connection test result:', connectionTest);
    
    // Check if attendance_sessions table exists and has data
    const sessionsCount = await Database.query('SELECT COUNT(*) as count FROM attendance_sessions');
    console.log('Attendance sessions count:', sessionsCount[0]?.count);
    
    // Check if attendance_records table exists and has data
    const recordsCount = await Database.query('SELECT COUNT(*) as count FROM attendance_records');
    console.log('Attendance records count:', recordsCount[0]?.count);
    
    // Check if gathering_types table exists and has data
    const gatheringsCount = await Database.query('SELECT COUNT(*) as count FROM gathering_types');
    console.log('Gathering types count:', gatheringsCount[0]?.count);
    
    // Check if individuals table exists and has data
    const individualsCount = await Database.query('SELECT COUNT(*) as count FROM individuals');
    console.log('Individuals count:', individualsCount[0]?.count);
    
    // Check if families table exists and has data
    const familiesCount = await Database.query('SELECT COUNT(*) as count FROM families');
    console.log('Families count:', familiesCount[0]?.count);
    
    // Test a simple query with the actual date range from the error
    const testQuery = await Database.query(`
      SELECT COUNT(*) as count 
      FROM attendance_sessions 
      WHERE session_date >= '2025-07-03' AND session_date <= '2025-07-31'
    `);
    console.log('Test query with future dates result:', testQuery[0]?.count);
    
    res.json({
      connection: 'OK',
      tables: {
        attendance_sessions: sessionsCount[0]?.count || 0,
        attendance_records: recordsCount[0]?.count || 0,
        gathering_types: gatheringsCount[0]?.count || 0,
        individuals: individualsCount[0]?.count || 0,
        families: familiesCount[0]?.count || 0
      },
      testQuery: testQuery[0]?.count || 0
    });
  } catch (error) {
    console.error('Test endpoint error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Database test failed',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Get dashboard metrics
router.get('/dashboard', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { gatheringTypeId, startDate, endDate } = req.query;
    
    console.log('Getting dashboard metrics:', { gatheringTypeId, startDate, endDate });
    
    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    // Validate date format
    const startDateObj = new Date(startDate);
    const endDateObj = new Date(endDate);
    if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }
    
    // Check if dates are in the future (which might cause issues)
    const today = new Date();
    if (startDateObj > today || endDateObj > today) {
      console.log('Warning: Date range includes future dates');
    }
    
    console.log('Querying attendance data...');
    
    // Get attendance sessions and records for the specified period
    let attendanceData = [];
    try {
      attendanceData = await Database.query(`
        SELECT 
          as_table.session_date,
          as_table.gathering_type_id,
          COUNT(DISTINCT ar.individual_id) as present_count,
          COUNT(DISTINCT CASE WHEN ar.present = true THEN ar.individual_id END) as present_individuals,
          COUNT(DISTINCT CASE WHEN ar.present = false THEN ar.individual_id END) as absent_individuals
        FROM attendance_sessions as_table
        LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
        WHERE as_table.session_date >= ? AND as_table.session_date <= ?
        ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
        GROUP BY as_table.session_date, as_table.gathering_type_id
        ORDER BY as_table.session_date DESC
      `, gatheringTypeId ? [startDate, endDate, gatheringTypeId] : [startDate, endDate]);
    } catch (err) {
      console.error('Error querying attendance data:', err);
      throw new Error(`Failed to query attendance data: ${err.message}`);
    }

    console.log('Attendance data query completed. Found', attendanceData.length, 'sessions');

    // If no data found, return empty metrics instead of error
    if (attendanceData.length === 0) {
      console.log('No attendance data found for the specified date range');
      const emptyMetrics = {
        totalSessions: 0,
        totalPresent: 0,
        totalAbsent: 0,
        averageAttendance: 0,
        growthRate: 0,
        totalIndividuals: 0,
        totalVisitors: 0,
        attendanceData: []
      };
      
      // Still try to get total individuals count
      try {
        const totalIndividuals = await Database.query(`
          SELECT COUNT(DISTINCT i.id) as total
          FROM individuals i
          JOIN families f ON i.family_id = f.id
          WHERE i.is_active = true
          ${gatheringTypeId ? 'AND f.gathering_type_id = ?' : ''}
        `, gatheringTypeId ? [gatheringTypeId] : []);
        
        emptyMetrics.totalIndividuals = totalIndividuals[0]?.total || 0;
      } catch (err) {
        console.log('Could not get total individuals count:', err.message);
      }
      
      return res.json({ metrics: emptyMetrics });
    }

    // Calculate basic metrics
    const totalSessions = attendanceData.length;
    const totalPresent = attendanceData.reduce((sum, session) => sum + (session.present_individuals || 0), 0);
    const totalAbsent = attendanceData.reduce((sum, session) => sum + (session.absent_individuals || 0), 0);
    const averageAttendance = totalSessions > 0 ? Math.round(totalPresent / totalSessions) : 0;
    
    console.log('Calculated basic metrics:', { totalSessions, totalPresent, totalAbsent, averageAttendance });
    
    // Calculate growth rate with weekly aggregation
    const weeklyData = {};
    attendanceData.forEach(session => {
      // Use native JavaScript to get week number instead of moment.js
      const date = new Date(session.session_date);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay()); // Start of week (Sunday)
      const weekKey = weekStart.toISOString().split('T')[0];
      
      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = { totalPresent: 0, sessionCount: 0 };
      }
      weeklyData[weekKey].totalPresent += session.present_individuals || 0;
      weeklyData[weekKey].sessionCount += 1;
    });

    const sortedWeeks = Object.keys(weeklyData).sort((a, b) => a.localeCompare(b));
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

    console.log('Calculated growth rate:', growthRate);

    // Get total individuals for context
    console.log('Querying total individuals...');
    let totalIndividuals = [{ total: 0 }];
    try {
      totalIndividuals = await Database.query(`
        SELECT COUNT(DISTINCT i.id) as total
        FROM individuals i
        JOIN families f ON i.family_id = f.id
        WHERE i.is_active = true
        ${gatheringTypeId ? 'AND f.gathering_type_id = ?' : ''}
      `, gatheringTypeId ? [gatheringTypeId] : []);
    } catch (err) {
      console.error('Error querying total individuals:', err);
      // Don't throw error, just use default value
    }

    console.log('Total individuals:', totalIndividuals[0]?.total || 0);

    // Get total visitors for the period
    console.log('Querying total visitors...');
    let totalVisitors = [{ total: 0 }];
    try {
      totalVisitors = await Database.query(`
        SELECT COUNT(DISTINCT ar.id) as total
        FROM attendance_records ar
        JOIN attendance_sessions as_table ON ar.session_id = as_table.id
        WHERE as_table.session_date >= ? AND as_table.session_date <= ?
        AND ar.visitor_name IS NOT NULL AND ar.visitor_name != ''
        ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
      `, gatheringTypeId ? [startDate, endDate, gatheringTypeId] : [startDate, endDate]);
    } catch (err) {
      console.error('Error querying total visitors:', err);
      // Don't throw error, just use default value
    }

    console.log('Total visitors:', totalVisitors[0]?.total || 0);

    const metrics = {
      totalSessions,
      totalPresent,
      totalAbsent,
      averageAttendance,
      growthRate,
      totalIndividuals: totalIndividuals[0]?.total || 0,
      totalVisitors: totalVisitors[0]?.total || 0,
      attendanceData: attendanceData.map(session => ({
        date: session.session_date,
        present: session.present_individuals || 0,
        absent: session.absent_individuals || 0,
        total: (session.present_individuals || 0) + (session.absent_individuals || 0)
      }))
    };

    console.log('Final metrics calculated successfully');

    res.json({ metrics });
  } catch (error) {
    console.error('Get dashboard error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to retrieve dashboard data.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Export data endpoint
router.get('/export', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { gatheringTypeId, startDate, endDate } = req.query;
    
    console.log('Exporting data:', { gatheringTypeId, startDate, endDate });
    
    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    // Get detailed attendance data for export
    const exportData = await Database.query(`
      SELECT 
        as_table.session_date,
        gt.name as gathering_name,
        i.first_name,
        i.last_name,
        f.family_name,
        ar.present,
        ar.visitor_name,
        ar.visitor_type,
        ar.notes,
        CASE 
          WHEN ar.individual_id IS NOT NULL THEN 'Regular Member'
          WHEN ar.visitor_name IS NOT NULL AND ar.visitor_name != '' THEN 'Visitor'
          ELSE 'Unknown'
        END as attendee_type
      FROM attendance_sessions as_table
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
      LEFT JOIN individuals i ON ar.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      WHERE as_table.session_date >= ? AND as_table.session_date <= ?
      ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
      ORDER BY as_table.session_date DESC, f.family_name, i.last_name, i.first_name
    `, gatheringTypeId ? [startDate, endDate, gatheringTypeId] : [startDate, endDate]);

    // Helper function to format date as DD-MM-YYYY
    const formatDate = (dateString) => {
      if (!dateString) return '';
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}-${month}-${year}`;
    };

    // Convert to CSV format
    const csvHeaders = ['Date', 'Gathering', 'First Name', 'Last Name', 'Family', 'Present', 'Attendee Type', 'Visitor Name', 'Visitor Type', 'Notes'];
    const csvRows = exportData.map(row => [
      formatDate(row.session_date),
      row.gathering_name,
      row.first_name || '',
      row.last_name || '',
      row.family_name || '',
      row.present ? 'Yes' : 'No',
      row.attendee_type,
      row.attendee_type === 'Visitor' ? (row.visitor_name || '') : '',
      row.attendee_type === 'Visitor' ? (row.visitor_type || '') : '',
      row.notes || ''
    ]);

    const csvContent = [csvHeaders, ...csvRows]
      .map(row => row.map(field => `"${field}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.csv"');
    res.send(csvContent);
    
  } catch (error) {
    console.error('Export data error:', error);
    res.status(500).json({ error: 'Failed to export data.' });
  }
});

module.exports = router; 