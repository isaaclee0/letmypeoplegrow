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
    const sessionsCount = await Database.query('SELECT COUNT(*) as count FROM attendance_sessions WHERE church_id = ?', [req.user.church_id]);
    console.log('Attendance sessions count:', sessionsCount[0]?.count);
    
    // Check if attendance_records table exists and has data
    const recordsCount = await Database.query('SELECT COUNT(*) as count FROM attendance_records WHERE church_id = ?', [req.user.church_id]);
    console.log('Attendance records count:', recordsCount[0]?.count);
    
    // Check if gathering_types table exists and has data
    const gatheringsCount = await Database.query('SELECT COUNT(*) as count FROM gathering_types WHERE church_id = ?', [req.user.church_id]);
    console.log('Gathering types count:', gatheringsCount[0]?.count);
    
    // Check if individuals table exists and has data
    const individualsCount = await Database.query('SELECT COUNT(*) as count FROM individuals WHERE church_id = ?', [req.user.church_id]);
    console.log('Individuals count:', individualsCount[0]?.count);
    
    // Check if families table exists and has data
    const familiesCount = await Database.query('SELECT COUNT(*) as count FROM families WHERE church_id = ?', [req.user.church_id]);
    console.log('Families count:', familiesCount[0]?.count);
    
    // Test a simple query with the actual date range from the error
    const testQuery = await Database.query(`
      SELECT COUNT(*) as count 
      FROM attendance_sessions 
      WHERE session_date >= '2025-07-03' AND session_date <= '2025-07-31' AND church_id = ?
    `, [req.user.church_id]);
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

    // Normalize any date-like value to an ISO YYYY-MM-DD string so
    // Map keys and comparisons use primitives instead of Date references
    const normalizeDateKey = (value) => {
      try {
        const d = new Date(value);
        if (isNaN(d.getTime())) return String(value);
        return d.toISOString().split('T')[0];
      } catch {
        return String(value);
      }
    };
    
    // Get attendance sessions and records for the specified period
    let attendanceData = [];
    try {
      attendanceData = await Database.query(`
        SELECT 
          as_table.session_date,
          as_table.gathering_type_id,
          COUNT(DISTINCT CASE WHEN ar.present = true THEN ar.individual_id END) as present_individuals,
          COUNT(DISTINCT gl.individual_id) - COUNT(DISTINCT CASE WHEN ar.present = true THEN ar.individual_id END) as absent_individuals,
          COUNT(DISTINCT gl.individual_id) as total_individuals
        FROM attendance_sessions as_table
        LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
        LEFT JOIN gathering_lists gl ON as_table.gathering_type_id = gl.gathering_type_id
        LEFT JOIN individuals i ON gl.individual_id = i.id
        WHERE as_table.session_date >= ? AND as_table.session_date <= ?
         AND (i.is_active = true OR ar.present = true)
        AND as_table.church_id = ?
        ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
        GROUP BY as_table.session_date, as_table.gathering_type_id
        ORDER BY as_table.session_date DESC
      `, gatheringTypeId ? [startDate, endDate, req.user.church_id, gatheringTypeId] : [startDate, endDate, req.user.church_id]);
    } catch (err) {
      console.error('Error querying attendance data:', err);
      throw new Error(`Failed to query attendance data: ${err.message}`);
    }

    console.log('Attendance data query completed. Found', attendanceData.length, 'sessions');

    // Prepare visitor breakdown per session first (used to decide which sessions to include in charts)
    console.log('Querying visitor breakdown per session...');
    let visitorsBySession = [];
    try {
      visitorsBySession = await Database.query(`
        SELECT 
          as_table.session_date,
          SUM(CASE WHEN i.people_type = 'local_visitor' AND ar.present = true THEN 1 ELSE 0 END) as local_visitors_present,
          SUM(CASE WHEN i.people_type = 'traveller_visitor' AND ar.present = true THEN 1 ELSE 0 END) as traveller_visitors_present
        FROM attendance_sessions as_table
        LEFT JOIN attendance_records ar ON ar.session_id = as_table.id
        LEFT JOIN individuals i ON i.id = ar.individual_id
        WHERE as_table.session_date >= ? AND as_table.session_date <= ?
          ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
          AND as_table.church_id = ?
        GROUP BY as_table.session_date
        ORDER BY as_table.session_date DESC
      `, gatheringTypeId ? [startDate, endDate, gatheringTypeId, req.user.church_id] : [startDate, endDate, req.user.church_id]);
    } catch (err) {
      console.error('Error querying visitors by session (attendance_records):', err);
    }

    // Also include counts from legacy visitors table where visitors were tracked separately
    let legacyVisitorsBySession = [];
    try {
      legacyVisitorsBySession = await Database.query(`
        SELECT 
          as_table.session_date,
          SUM(CASE WHEN v.visitor_type = 'potential_regular' THEN 1 ELSE 0 END) as local_visitors_present,
          SUM(CASE WHEN v.visitor_type = 'temporary_other' THEN 1 ELSE 0 END) as traveller_visitors_present
        FROM attendance_sessions as_table
        LEFT JOIN visitors v ON v.session_id = as_table.id
        WHERE as_table.session_date >= ? AND as_table.session_date <= ?
          ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
          AND as_table.church_id = ?
        GROUP BY as_table.session_date
        ORDER BY as_table.session_date DESC
      `, gatheringTypeId ? [startDate, endDate, gatheringTypeId, req.user.church_id] : [startDate, endDate, req.user.church_id]);
    } catch (err) {
      console.error('Error querying visitors by session (legacy visitors table):', err);
    }

    const visitorCountsByDate = new Map();
    // Seed with attendance_records based counts
    visitorsBySession.forEach((row) => {
      const key = normalizeDateKey(row.session_date);
      visitorCountsByDate.set(key, {
        local: row.local_visitors_present || 0,
        traveller: row.traveller_visitors_present || 0,
      });
    });
    // Merge legacy visitors table counts
    legacyVisitorsBySession.forEach((row) => {
      const key = normalizeDateKey(row.session_date);
      const existing = visitorCountsByDate.get(key) || { local: 0, traveller: 0 };
      visitorCountsByDate.set(key, {
        local: (existing.local || 0) + (row.local_visitors_present || 0),
        traveller: (existing.traveller || 0) + (row.traveller_visitors_present || 0),
      });
    });

    // For stats purposes ignore sessions with zero attendance (no one present)
    // BUT include sessions that have visitor counts > 0 so the visitor chart is populated
    const attendanceDataFiltered = attendanceData.filter((s) => {
      const present = (s.present_individuals || 0) > 0;
      const vc = visitorCountsByDate.get(normalizeDateKey(s.session_date)) || { local: 0, traveller: 0 };
      const visitorsPresent = (vc.local + vc.traveller) > 0;
      return present || visitorsPresent;
    });
    console.log('After filtering sessions (present>0 OR visitors>0):', attendanceDataFiltered.length);

    // If no data found, return empty metrics instead of error
    if (attendanceDataFiltered.length === 0) {
      console.log('No attendance data found for the specified date range');
      const emptyMetrics = {
        totalSessions: 0,
        totalPresent: 0,
        totalAbsent: 0,
        averageAttendance: 0,
        growthRate: 0,
        totalIndividuals: 0,
        totalRegulars: 0,
        addedRegularsInPeriod: 0,
        totalVisitors: 0,
        attendanceData: []
      };
      
      // Still try to get total regular individuals count
      try {
        const totalRegularIndividuals = await Database.query(`
          SELECT COUNT(DISTINCT i.id) as total
          FROM individuals i
          JOIN gathering_lists gl ON i.id = gl.individual_id
           WHERE i.is_active = true
            AND i.people_type = 'regular'
            AND i.church_id = ?
            ${gatheringTypeId ? 'AND gl.gathering_type_id = ?' : ''}
        `, gatheringTypeId ? [req.user.church_id, gatheringTypeId] : [req.user.church_id]);
        emptyMetrics.totalIndividuals = totalRegularIndividuals[0]?.total || 0;
        emptyMetrics.totalRegulars = totalRegularIndividuals[0]?.total || 0;
      } catch (err) {
        console.log('Could not get total regular individuals count:', err.message);
      }

      // Added regulars in selected period
      try {
        const addedRegularsInPeriod = await Database.query(`
          SELECT COUNT(DISTINCT gl.individual_id) as total
          FROM gathering_lists gl
          JOIN individuals i ON i.id = gl.individual_id
          WHERE gl.added_at >= ? AND gl.added_at <= ?
            ${gatheringTypeId ? 'AND gl.gathering_type_id = ?' : ''}
            AND i.people_type = 'regular'
            AND i.is_active = true
            AND i.church_id = ?
        `, gatheringTypeId ? [startDate, endDate, gatheringTypeId, req.user.church_id] : [startDate, endDate, req.user.church_id]);
        emptyMetrics.addedRegularsInPeriod = addedRegularsInPeriod[0]?.total || 0;
      } catch (err) {
        console.log('Could not get added regulars count:', err.message);
      }
      
      return res.json({ metrics: emptyMetrics });
    }

    // Calculate basic metrics
    const totalSessions = attendanceDataFiltered.length;
    const totalPresent = attendanceDataFiltered.reduce((sum, session) => sum + (session.present_individuals || 0), 0);
    const totalAbsent = attendanceDataFiltered.reduce((sum, session) => sum + (session.absent_individuals || 0), 0);
    const averageAttendance = totalSessions > 0 ? Math.round(totalPresent / totalSessions) : 0;
    
    console.log('Calculated basic metrics:', { totalSessions, totalPresent, totalAbsent, averageAttendance });
    
    // Calculate growth rate with weekly aggregation
    const weeklyData = {};
    attendanceDataFiltered.forEach(session => {
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

    // Get total regular individuals for context
    console.log('Querying total regular individuals...');
    let totalRegularIndividuals = [{ total: 0 }];
    try {
      totalRegularIndividuals = await Database.query(`
        SELECT COUNT(DISTINCT i.id) as total
        FROM individuals i
        JOIN gathering_lists gl ON i.id = gl.individual_id
        WHERE i.is_active = true
          AND i.people_type = 'regular'
          AND i.church_id = ?
          ${gatheringTypeId ? 'AND gl.gathering_type_id = ?' : ''}
      `, gatheringTypeId ? [req.user.church_id, gatheringTypeId] : [req.user.church_id]);
    } catch (err) {
      console.error('Error querying total regular individuals:', err);
      // Don't throw error, just use default value
    }

    console.log('Total regular individuals:', totalRegularIndividuals[0]?.total || 0);

    // Count regular individuals added in the selected period
    console.log('Querying regular individuals added in period...');
    let addedRegularsInPeriod = [{ total: 0 }];
    try {
      addedRegularsInPeriod = await Database.query(`
        SELECT COUNT(DISTINCT gl.individual_id) as total
        FROM gathering_lists gl
        JOIN individuals i ON i.id = gl.individual_id
        WHERE gl.added_at >= ? AND gl.added_at <= ?
          ${gatheringTypeId ? 'AND gl.gathering_type_id = ?' : ''}
          AND i.people_type = 'regular'
          AND i.is_active = true
          AND i.church_id = ?
      `, gatheringTypeId ? [startDate, endDate, gatheringTypeId, req.user.church_id] : [startDate, endDate, req.user.church_id]);
    } catch (err) {
      console.error('Error querying added regulars in period:', err);
    }

    // Get total visitors for the period from both systems
    console.log('Querying total visitors...');
    let totalVisitors = [{ total: 0 }];
    try {
      totalVisitors = await Database.query(`
        SELECT COUNT(DISTINCT ar.individual_id) as total
        FROM attendance_records ar
        JOIN attendance_sessions as_table ON ar.session_id = as_table.id
        JOIN individuals i ON ar.individual_id = i.id
        WHERE as_table.session_date >= ? AND as_table.session_date <= ?
         AND i.people_type IN ('local_visitor', 'traveller_visitor')
        AND ar.present = true
        ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
        AND as_table.church_id = ?
      `, gatheringTypeId ? [startDate, endDate, gatheringTypeId, req.user.church_id] : [startDate, endDate, req.user.church_id]);
      
      console.log(`Total visitors (attendance_records) found: ${totalVisitors[0]?.total || 0}`);
    } catch (err) {
      console.error('Error querying total visitors (attendance_records):', err);
      // Don't throw error, just use default value
    }

    // Legacy visitors table count
    let totalVisitorsLegacy = [{ total: 0 }];
    try {
      totalVisitorsLegacy = await Database.query(`
        SELECT COUNT(*) as total
        FROM visitors v
        JOIN attendance_sessions as_table ON v.session_id = as_table.id
        WHERE as_table.session_date >= ? AND as_table.session_date <= ?
          ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
          AND as_table.church_id = ?
      `, gatheringTypeId ? [startDate, endDate, gatheringTypeId, req.user.church_id] : [startDate, endDate, req.user.church_id]);
      console.log(`Total visitors (legacy visitors table) found: ${totalVisitorsLegacy[0]?.total || 0}`);
    } catch (err) {
      console.error('Error querying total visitors (legacy visitors table):', err);
    }

    const totalVisitorsCombined = (totalVisitors[0]?.total || 0) + (totalVisitorsLegacy[0]?.total || 0);
    console.log('Total visitors combined:', totalVisitorsCombined);

    // visitorsBySession and visitorCountsByDate already built above

    const metrics = {
      totalSessions,
      totalPresent,
      totalAbsent,
      averageAttendance,
      growthRate,
      totalIndividuals: totalRegularIndividuals[0]?.total || 0, // kept for backward compat
      totalRegulars: totalRegularIndividuals[0]?.total || 0,
      addedRegularsInPeriod: addedRegularsInPeriod[0]?.total || 0,
      totalVisitors: totalVisitorsCombined,
      attendanceData: attendanceDataFiltered.map(session => {
        const key = normalizeDateKey(session.session_date);
        const vc = visitorCountsByDate.get(key) || { local: 0, traveller: 0 };
        return {
          date: key,
          present: session.present_individuals || 0,
          absent: session.absent_individuals || 0,
          total: (session.present_individuals || 0) + (session.absent_individuals || 0),
          visitorsLocal: vc.local,
          visitorsTraveller: vc.traveller,
        };
      })
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
      console.log('Missing date parameters');
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    console.log('Executing database query for export...');
    
    // Query that works with the actual database schema
    const exportData = await Database.query(`
      SELECT 
        as_table.session_date,
        gt.name as gathering_name,
        COALESCE(i.first_name, '') as first_name,
        COALESCE(i.last_name, '') as last_name,
        COALESCE(f.family_name, '') as family_name,
        COALESCE(ar.present, 0) as present,
        'Regular Member' as attendee_type
      FROM attendance_sessions as_table
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
      LEFT JOIN individuals i ON ar.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      WHERE as_table.session_date >= ? AND as_table.session_date <= ?
      ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
      ORDER BY as_table.session_date DESC, f.family_name, i.last_name, i.first_name
    `, gatheringTypeId ? [startDate, endDate, gatheringTypeId] : [startDate, endDate]);

    console.log(`Export query returned ${exportData.length} rows`);

    // Helper function to format date as DD-MM-YYYY
    const formatDate = (dateString) => {
      if (!dateString) return '';
      try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '';
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}-${month}-${year}`;
      } catch (error) {
        console.error('Date formatting error:', error);
        return '';
      }
    };

    // Convert to CSV format with better error handling
    const csvHeaders = ['Date', 'Gathering', 'First Name', 'Last Name', 'Family', 'Present', 'Attendee Type'];
    const csvRows = exportData.map(row => {
      try {
        return [
          formatDate(row.session_date),
          row.gathering_name || '',
          row.first_name || '',
          row.last_name || '',
          row.family_name || '',
          row.present ? 'Yes' : 'No',
          row.attendee_type || 'Regular Member'
        ];
      } catch (error) {
        console.error('Error processing row:', error, row);
        return ['', '', '', '', '', 'No', 'Error'];
      }
    });

    const csvContent = [csvHeaders, ...csvRows]
      .map(row => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    console.log(`Generated CSV with ${csvRows.length} data rows`);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.csv"');
    res.send(csvContent);
    
    console.log('Export completed successfully');
    
  } catch (error) {
    console.error('Export data error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to export data.' });
  }
});

module.exports = router; 