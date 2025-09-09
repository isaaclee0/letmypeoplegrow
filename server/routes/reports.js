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
    const { gatheringTypeId, gatheringTypeIds, startDate, endDate } = req.query;
    
    // Handle both single gatheringTypeId and multiple gatheringTypeIds
    const gatheringIds = gatheringTypeIds ? 
      (Array.isArray(gatheringTypeIds) ? gatheringTypeIds : [gatheringTypeIds]) :
      (gatheringTypeId ? [gatheringTypeId] : []);
    
    console.log('Getting dashboard metrics:', { gatheringTypeId, gatheringTypeIds, gatheringIds, startDate, endDate });
    
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
    
    // Check gathering types for all selected gatherings
    let gatheringTypes = [];
    let isHeadcountGathering = false;
    let hasMixedGatheringTypes = false;
    
    if (gatheringIds.length > 0) {
      try {
        const placeholders = gatheringIds.map(() => '?').join(',');
        const gatheringTypeResults = await Database.query(`
          SELECT id, attendance_type FROM gathering_types 
          WHERE id IN (${placeholders}) AND church_id = ?
        `, [...gatheringIds, req.user.church_id]);
        
        gatheringTypes = gatheringTypeResults;
        const headcountGatherings = gatheringTypes.filter(g => g.attendance_type === 'headcount');
        const standardGatherings = gatheringTypes.filter(g => g.attendance_type === 'standard');
        
        isHeadcountGathering = headcountGatherings.length > 0 && standardGatherings.length === 0;
        hasMixedGatheringTypes = headcountGatherings.length > 0 && standardGatherings.length > 0;
      } catch (err) {
        console.error('Error checking gathering types:', err);
      }
    }

    // Get attendance sessions and records for the specified period
    let attendanceData = [];
    try {
      if (isHeadcountGathering && !hasMixedGatheringTypes) {
        // For headcount-only gatherings, get data from headcount_records table
        // Respect the headcount_mode (separate, combined, averaged) for each session
        const placeholders = gatheringIds.map(() => '?').join(',');
        attendanceData = await Database.query(`
          SELECT 
            as_table.session_date,
            as_table.gathering_type_id,
            CASE 
              WHEN as_table.headcount_mode = 'combined' THEN COALESCE(SUM(h.headcount), 0)
              WHEN as_table.headcount_mode = 'averaged' THEN COALESCE(ROUND(AVG(h.headcount)), 0)
              ELSE COALESCE(MAX(h.headcount), 0) -- 'separate' mode or default: use the latest/max headcount
            END as present_individuals,
            0 as absent_individuals,
            CASE 
              WHEN as_table.headcount_mode = 'combined' THEN COALESCE(SUM(h.headcount), 0)
              WHEN as_table.headcount_mode = 'averaged' THEN COALESCE(ROUND(AVG(h.headcount)), 0)
              ELSE COALESCE(MAX(h.headcount), 0) -- 'separate' mode or default: use the latest/max headcount
            END as total_individuals
          FROM attendance_sessions as_table
          LEFT JOIN headcount_records h ON as_table.id = h.session_id
          WHERE as_table.session_date >= ? AND as_table.session_date <= ?
            AND as_table.gathering_type_id IN (${placeholders})
            AND as_table.church_id = ?
          GROUP BY as_table.session_date, as_table.gathering_type_id, as_table.headcount_mode
          ORDER BY as_table.session_date DESC
        `, [startDate, endDate, ...gatheringIds, req.user.church_id]);
      } else {
        // For standard gatherings or mixed gathering types, use the existing query
        const placeholders = gatheringIds.map(() => '?').join(',');
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
          AND as_table.gathering_type_id IN (${placeholders})
          GROUP BY as_table.session_date, as_table.gathering_type_id
          ORDER BY as_table.session_date DESC
        `, [startDate, endDate, req.user.church_id, ...gatheringIds]);
      }
      
      // If we have mixed gathering types, also get headcount data and combine it
      if (hasMixedGatheringTypes) {
        const headcountGatheringIds = gatheringTypes.filter(g => g.attendance_type === 'headcount').map(g => g.id);
        if (headcountGatheringIds.length > 0) {
          const placeholders = headcountGatheringIds.map(() => '?').join(',');
          const headcountData = await Database.query(`
            SELECT 
              as_table.session_date,
              as_table.gathering_type_id,
              CASE 
                WHEN as_table.headcount_mode = 'combined' THEN COALESCE(SUM(h.headcount), 0)
                WHEN as_table.headcount_mode = 'averaged' THEN COALESCE(ROUND(AVG(h.headcount)), 0)
                ELSE COALESCE(MAX(h.headcount), 0)
              END as present_individuals,
              0 as absent_individuals,
              CASE 
                WHEN as_table.headcount_mode = 'combined' THEN COALESCE(SUM(h.headcount), 0)
                WHEN as_table.headcount_mode = 'averaged' THEN COALESCE(ROUND(AVG(h.headcount)), 0)
                ELSE COALESCE(MAX(h.headcount), 0)
              END as total_individuals
            FROM attendance_sessions as_table
            LEFT JOIN headcount_records h ON as_table.id = h.session_id
            WHERE as_table.session_date >= ? AND as_table.session_date <= ?
              AND as_table.gathering_type_id IN (${placeholders})
              AND as_table.church_id = ?
            GROUP BY as_table.session_date, as_table.gathering_type_id, as_table.headcount_mode
            ORDER BY as_table.session_date DESC
          `, [startDate, endDate, ...headcountGatheringIds, req.user.church_id]);
          
          // Combine the data
          attendanceData = [...attendanceData, ...headcountData];
        }
      }
    } catch (err) {
      console.error('Error querying attendance data:', err);
      throw new Error(`Failed to query attendance data: ${err.message}`);
    }

    console.log('Attendance data query completed. Found', attendanceData.length, 'sessions');
    if (isHeadcountGathering && attendanceData.length > 0) {
      console.log('Headcount data sample:', attendanceData.slice(0, 3).map(s => ({
        date: s.session_date,
        present: s.present_individuals,
        total: s.total_individuals
      })));
    }

    // Prepare visitor breakdown per session first (used to decide which sessions to include in charts)
    // Skip visitor data for headcount-only gatherings since they don't track individual visitors
    console.log('Querying visitor breakdown per session...');
    let visitorsBySession = [];
    if (!isHeadcountGathering || hasMixedGatheringTypes) {
      try {
        const placeholders = gatheringIds.map(() => '?').join(',');
        visitorsBySession = await Database.query(`
          SELECT 
            as_table.session_date,
            SUM(CASE WHEN i.people_type = 'local_visitor' AND ar.present = true THEN 1 ELSE 0 END) as local_visitors_present,
            SUM(CASE WHEN i.people_type = 'traveller_visitor' AND ar.present = true THEN 1 ELSE 0 END) as traveller_visitors_present
          FROM attendance_sessions as_table
          LEFT JOIN attendance_records ar ON ar.session_id = as_table.id
          LEFT JOIN individuals i ON i.id = ar.individual_id
          WHERE as_table.session_date >= ? AND as_table.session_date <= ?
            AND as_table.gathering_type_id IN (${placeholders})
            AND as_table.church_id = ?
          GROUP BY as_table.session_date
          ORDER BY as_table.session_date DESC
        `, [startDate, endDate, ...gatheringIds, req.user.church_id]);
      } catch (err) {
        console.error('Error querying visitors by session (attendance_records):', err);
      }
    }

    // Legacy visitors table removed - visitors are now tracked via attendance_records with is_visitor flag

    const visitorCountsByDate = new Map();
    // Seed with attendance_records based counts
    visitorsBySession.forEach((row) => {
      const key = normalizeDateKey(row.session_date);
      visitorCountsByDate.set(key, {
        local: row.local_visitors_present || 0,
        traveller: row.traveller_visitors_present || 0,
      });
    });
    // Legacy visitors table logic removed - all visitor data comes from attendance_records now

    // For stats purposes ignore sessions with zero attendance (no one present)
    // BUT include sessions that have visitor counts > 0 so the visitor chart is populated
    // For headcount-only gatherings, only filter by headcount > 0
    const attendanceDataFiltered = attendanceData.filter((s) => {
      const present = parseInt(s.present_individuals || 0, 10) > 0;
      if (isHeadcountGathering && !hasMixedGatheringTypes) {
        return present; // For headcount-only gatherings, only check if headcount > 0
      } else {
        const vc = visitorCountsByDate.get(normalizeDateKey(s.session_date)) || { local: 0, traveller: 0 };
        const visitorsPresent = (vc.local + vc.traveller) > 0;
        return present || visitorsPresent;
      }
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
    const totalPresent = attendanceDataFiltered.reduce((sum, session) => sum + parseInt(session.present_individuals || 0, 10), 0);
    const totalAbsent = attendanceDataFiltered.reduce((sum, session) => sum + parseInt(session.absent_individuals || 0, 10), 0);
    const averageAttendance = totalSessions > 0 ? Math.round(totalPresent / totalSessions) : 0;
    
    console.log('Calculated basic metrics:', { totalSessions, totalPresent, totalAbsent, averageAttendance });
    if (isHeadcountGathering) {
      console.log('Headcount metrics debug:', {
        filteredSessions: attendanceDataFiltered.length,
        totalSessions: attendanceData.length,
        sampleData: attendanceDataFiltered.slice(0, 3).map(s => ({
          date: s.session_date,
          present: s.present_individuals
        }))
      });
    }
    
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
      weeklyData[weekKey].totalPresent += parseInt(session.present_individuals || 0, 10);
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

    // Get total regular individuals for context (skip for headcount-only gatherings)
    console.log('Querying total regular individuals...');
    let totalRegularIndividuals = [{ total: 0 }];
    if (!isHeadcountGathering || hasMixedGatheringTypes) {
      try {
        const placeholders = gatheringIds.map(() => '?').join(',');
        totalRegularIndividuals = await Database.query(`
          SELECT COUNT(DISTINCT i.id) as total
          FROM individuals i
          JOIN gathering_lists gl ON i.id = gl.individual_id
          WHERE i.is_active = true
            AND i.people_type = 'regular'
            AND i.church_id = ?
            AND gl.gathering_type_id IN (${placeholders})
        `, [req.user.church_id, ...gatheringIds]);
      } catch (err) {
        console.error('Error querying total regular individuals:', err);
        // Don't throw error, just use default value
      }
    }

    console.log('Total regular individuals:', totalRegularIndividuals[0]?.total || 0);

    // Count regular individuals added in the selected period (skip for headcount-only gatherings)
    console.log('Querying regular individuals added in period...');
    let addedRegularsInPeriod = [{ total: 0 }];
    if (!isHeadcountGathering || hasMixedGatheringTypes) {
      try {
        const placeholders = gatheringIds.map(() => '?').join(',');
        addedRegularsInPeriod = await Database.query(`
          SELECT COUNT(DISTINCT gl.individual_id) as total
          FROM gathering_lists gl
          JOIN individuals i ON i.id = gl.individual_id
          WHERE gl.added_at >= ? AND gl.added_at <= ?
            AND gl.gathering_type_id IN (${placeholders})
            AND i.people_type = 'regular'
            AND i.is_active = true
            AND i.church_id = ?
        `, [startDate, endDate, ...gatheringIds, req.user.church_id]);
      } catch (err) {
        console.error('Error querying added regulars in period:', err);
      }
    }

    // Get total visitors for the period from both systems (skip for headcount-only gatherings)
    console.log('Querying total visitors...');
    let totalVisitors = [{ total: 0 }];
    if (!isHeadcountGathering || hasMixedGatheringTypes) {
      try {
        const placeholders = gatheringIds.map(() => '?').join(',');
        totalVisitors = await Database.query(`
          SELECT COUNT(DISTINCT ar.individual_id) as total
          FROM attendance_records ar
          JOIN attendance_sessions as_table ON ar.session_id = as_table.id
          JOIN individuals i ON ar.individual_id = i.id
          WHERE as_table.session_date >= ? AND as_table.session_date <= ?
           AND i.people_type IN ('local_visitor', 'traveller_visitor')
          AND ar.present = true
          AND as_table.gathering_type_id IN (${placeholders})
          AND as_table.church_id = ?
        `, [startDate, endDate, ...gatheringIds, req.user.church_id]);
        
        console.log(`Total visitors (attendance_records) found: ${totalVisitors[0]?.total || 0}`);
      } catch (err) {
        console.error('Error querying total visitors (attendance_records):', err);
        // Don't throw error, just use default value
      }
    }

    // Legacy visitors table removed - all visitor counts come from attendance_records now
    const totalVisitorsCombined = (totalVisitors[0]?.total || 0);
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
          gatheringId: session.gathering_type_id,
          present: session.present_individuals || 0,
          absent: session.absent_individuals || 0,
          total: (session.present_individuals || 0) + (session.absent_individuals || 0),
          visitorsLocal: vc.local,
          visitorsTraveller: vc.traveller,
        };
      })
    };

    // Get gathering names for the response
    let gatheringNames = {};
    if (gatheringIds.length > 0) {
      try {
        const placeholders = gatheringIds.map(() => '?').join(',');
        const gatheringInfo = await Database.query(`
          SELECT id, name FROM gathering_types 
          WHERE id IN (${placeholders}) AND church_id = ?
        `, [...gatheringIds, req.user.church_id]);
        
        gatheringInfo.forEach(g => {
          gatheringNames[g.id] = g.name;
        });
      } catch (err) {
        console.error('Error getting gathering names:', err);
      }
    }

    console.log('Final metrics calculated successfully');
    res.json({ metrics, gatheringNames });
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
    const { gatheringTypeId, gatheringTypeIds, startDate, endDate } = req.query;
    
    // Handle both single gatheringTypeId and multiple gatheringTypeIds
    const gatheringIds = gatheringTypeIds ? 
      (Array.isArray(gatheringTypeIds) ? gatheringTypeIds : [gatheringTypeIds]) :
      (gatheringTypeId ? [gatheringTypeId] : []);
    
    console.log('Exporting data:', { gatheringTypeId, gatheringTypeIds, gatheringIds, startDate, endDate });
    
    // Validate date parameters
    if (!startDate || !endDate) {
      console.log('Missing date parameters');
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }
    
    console.log('Executing database query for export...');
    
    // Get all sessions in the date range to determine column headers
    const placeholders = gatheringIds.map(() => '?').join(',');
    const sessionsQuery = `
      SELECT DISTINCT as_table.session_date, gt.name as gathering_name
      FROM attendance_sessions as_table
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      WHERE as_table.session_date >= ? AND as_table.session_date <= ?
      AND as_table.gathering_type_id IN (${placeholders})
      AND as_table.church_id = ?
      ORDER BY as_table.session_date ASC
    `;
    
    const sessions = await Database.query(
      sessionsQuery, 
      [startDate, endDate, ...gatheringIds, req.user.church_id]
    );
    
    console.log(`Found ${sessions.length} sessions in date range`);
    
    // Get all people who attended during the selected period, classified by their people_type
    const allPeopleQuery = `
      SELECT DISTINCT 
        i.id,
        COALESCE(i.first_name, '') as first_name,
        COALESCE(i.last_name, '') as last_name,
        COALESCE(f.family_name, '') as family_name,
        CASE 
          WHEN i.people_type = 'local_visitor' THEN 'Local Visitor'
          WHEN i.people_type = 'traveller_visitor' THEN 'Traveller Visitor'
          ELSE 'Regular Attender'
        END as people_type,
        i.people_type as raw_people_type
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      WHERE i.is_active = true 
        AND i.church_id = ?
        AND EXISTS (
          SELECT 1 FROM attendance_records ar
          JOIN attendance_sessions as_table ON ar.session_id = as_table.id
          WHERE ar.individual_id = i.id 
            AND as_table.session_date >= ? 
            AND as_table.session_date <= ?
            AND as_table.gathering_type_id IN (${placeholders})
        )
      ORDER BY 
        CASE 
          WHEN i.people_type NOT IN ('local_visitor', 'traveller_visitor') THEN 1
          WHEN i.people_type = 'local_visitor' THEN 2
          WHEN i.people_type = 'traveller_visitor' THEN 3
          ELSE 4
        END,
        f.family_name, i.last_name, i.first_name
    `;
    
    const allPeople = await Database.query(
      allPeopleQuery,
      [req.user.church_id, startDate, endDate, ...gatheringIds]
    );
    
    console.log(`Found ${allPeople.length} people total`);
    
    // Get attendance data for all people and sessions
    const attendanceQuery = `
      SELECT 
        ar.individual_id,
        as_table.session_date,
        ar.present
      FROM attendance_records ar
      JOIN attendance_sessions as_table ON ar.session_id = as_table.id
      WHERE as_table.session_date >= ? AND as_table.session_date <= ?
      AND as_table.gathering_type_id IN (${placeholders})
      AND as_table.church_id = ?
    `;
    
    const attendanceData = await Database.query(
      attendanceQuery,
      [startDate, endDate, ...gatheringIds, req.user.church_id]
    );
    
    // Create a map for quick attendance lookup
    const attendanceMap = new Map();
    attendanceData.forEach(record => {
      const key = `${record.individual_id}_${record.session_date}`;
      attendanceMap.set(key, record.present === 1 || record.present === true);
    });
    
    // Helper function to format date as YYYY-MM-DD for column headers
    const formatDateHeader = (dateString) => {
      if (!dateString) return '';
      try {
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return '';
        return date.toISOString().split('T')[0];
      } catch (error) {
        console.error('Date formatting error:', error);
        return '';
      }
    };
    
    // Create TSV headers
    const tsvHeaders = ['First Name', 'Last Name', 'Family Name', 'People Type', ...sessions.map(s => formatDateHeader(s.session_date))];
    
    // Create TSV rows
    const tsvRows = allPeople.map(person => {
      const row = [
        person.first_name || '',
        person.last_name || '',
        person.family_name || '',
        person.people_type || ''
      ];
      
      // Add attendance data for each session
      sessions.forEach(session => {
        const key = `${person.id}_${session.session_date}`;
        const attended = attendanceMap.get(key) || false;
        row.push(attended ? 'TRUE' : 'FALSE');
      });
      
      return row;
    });
    
    // Convert to TSV format
    const tsvContent = [tsvHeaders, ...tsvRows]
      .map(row => row.join('\t'))
      .join('\n');

    console.log(`Generated TSV with ${tsvRows.length} data rows and ${sessions.length} date columns`);

    res.setHeader('Content-Type', 'text/tab-separated-values');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.tsv"');
    res.send(tsvContent);
    
    console.log('Export completed successfully');
    
  } catch (error) {
    console.error('Export data error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to export data.' });
  }
});

module.exports = router; 