const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { processApiResponse } = require('../utils/caseConverter');

const router = express.Router();

// Public endpoint for IMPORTRANGE - no authentication required for spreadsheet access
// This allows Google Sheets and Excel to access the data directly

// Get attendance data for IMPORTRANGE
router.get('/attendance', async (req, res) => {
  try {
    const { 
      gatheringTypeId, 
      startDate, 
      endDate, 
      format = 'csv',
      includeVisitors = 'true',
      includeAbsent = 'true'
    } = req.query;

    // Validate required parameters
    if (!gatheringTypeId) {
      return res.status(400).json({ 
        error: 'Missing required parameter: gatheringTypeId',
        usage: 'Use: /api/importrange/attendance?gatheringTypeId=1&startDate=2024-01-01&endDate=2024-12-31'
      });
    }

    // Build the query based on parameters
    let query = `
      SELECT 
        as_table.session_date as 'Date',
        gt.name as 'Gathering Type',
        i.first_name as 'First Name',
        i.last_name as 'Last Name',
        f.family_name as 'Family',
        CASE WHEN ar.present = 1 THEN 'Present' ELSE 'Absent' END as 'Status',
        as_table.created_at as 'Recorded At'
      FROM attendance_sessions as_table
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      JOIN gathering_lists gl ON gt.id = gl.gathering_type_id
      JOIN individuals i ON gl.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN attendance_records ar ON ar.session_id = as_table.id AND ar.individual_id = i.id
      WHERE as_table.gathering_type_id = ?
        AND i.is_active = true
        AND (i.is_visitor = false OR i.is_visitor IS NULL)
    `;

    let params = [gatheringTypeId];

    // Add date filters if provided
    if (startDate) {
      query += ' AND as_table.session_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND as_table.session_date <= ?';
      params.push(endDate);
    }

    // Add status filter
    if (includeAbsent === 'false') {
      query += ' AND ar.present = 1';
    }

    query += ' ORDER BY as_table.session_date DESC, i.last_name, i.first_name';

    const attendanceData = await Database.query(query, params);

    // Add visitors if requested
    let visitorData = [];
    if (includeVisitors === 'true') {
      let visitorQuery = `
        SELECT 
          as_table.session_date as 'Date',
          gt.name as 'Gathering Type',
          v.name as 'Visitor Name',
          v.visitor_type as 'Visitor Type',
          v.visitor_family_group as 'Family Group',
          'Visitor' as 'Status',
          as_table.created_at as 'Recorded At'
        FROM attendance_sessions as_table
        JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
        JOIN visitors v ON v.session_id = as_table.id
        WHERE as_table.gathering_type_id = ?
      `;

      let visitorParams = [gatheringTypeId];

      if (startDate) {
        visitorQuery += ' AND as_table.session_date >= ?';
        visitorParams.push(startDate);
      }
      if (endDate) {
        visitorQuery += ' AND as_table.session_date <= ?';
        visitorParams.push(endDate);
      }

      visitorQuery += ' ORDER BY as_table.session_date DESC, v.name';
      visitorData = await Database.query(visitorQuery, visitorParams);
    }

    // Combine regular attendance and visitor data
    const allData = [...attendanceData, ...visitorData];

    // Return data in requested format
    if (format.toLowerCase() === 'json') {
      res.json({ 
        data: allData,
        totalRecords: allData.length,
        generatedAt: new Date().toISOString()
      });
    } else {
      // Default to CSV format
      if (allData.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="attendance_data.csv"');
        return res.send('Date,Gathering Type,First Name,Last Name,Family,Status,Recorded At\n');
      }

      // Convert to CSV
      const headers = Object.keys(allData[0]);
      const csvContent = [
        headers.join(','),
        ...allData.map(row => 
          headers.map(header => {
            const value = row[header];
            // Escape commas and quotes in CSV
            if (value === null || value === undefined) return '';
            const stringValue = String(value);
            if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
              return `"${stringValue.replace(/"/g, '""')}"`;
            }
            return stringValue;
          }).join(',')
        )
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="attendance_data.csv"');
      res.send(csvContent);
    }

  } catch (error) {
    console.error('IMPORTRANGE attendance error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve attendance data for IMPORTRANGE.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get individuals data for IMPORTRANGE
router.get('/individuals', async (req, res) => {
  try {
    const { 
      gatheringTypeId, 
      format = 'csv',
      includeInactive = 'false'
    } = req.query;

    let query = `
      SELECT 
        i.first_name as 'First Name',
        i.last_name as 'Last Name',
        f.family_name as 'Family',
        gt.name as 'Gathering Type',
        i.is_active as 'Active',
        i.created_at as 'Created At',
        i.updated_at as 'Updated At'
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      LEFT JOIN gathering_types gt ON gl.gathering_type_id = gt.id
      WHERE 1=1
    `;

    let params = [];

    if (gatheringTypeId) {
      query += ' AND gl.gathering_type_id = ?';
      params.push(gatheringTypeId);
    }

    if (includeInactive === 'false') {
      query += ' AND i.is_active = true';
    }

    query += ' ORDER BY i.last_name, i.first_name';

    const individualsData = await Database.query(query, params);

    // Return data in requested format
    if (format.toLowerCase() === 'json') {
      res.json({ 
        data: individualsData,
        totalRecords: individualsData.length,
        generatedAt: new Date().toISOString()
      });
    } else {
      // Default to CSV format
      if (individualsData.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="individuals_data.csv"');
        return res.send('First Name,Last Name,Family,Gathering Type,Active,Created At,Updated At\n');
      }

      // Convert to CSV
      const headers = Object.keys(individualsData[0]);
      const csvContent = [
        headers.join(','),
        ...individualsData.map(row => 
          headers.map(header => {
            const value = row[header];
            // Escape commas and quotes in CSV
            if (value === null || value === undefined) return '';
            const stringValue = String(value);
            if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
              return `"${stringValue.replace(/"/g, '""')}"`;
            }
            return stringValue;
          }).join(',')
        )
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="individuals_data.csv"');
      res.send(csvContent);
    }

  } catch (error) {
    console.error('IMPORTRANGE individuals error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve individuals data for IMPORTRANGE.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get families data for IMPORTRANGE
router.get('/families', async (req, res) => {
  try {
    const { 
      gatheringTypeId, 
      format = 'csv'
    } = req.query;

    let query = `
      SELECT 
        f.family_name as 'Family Name',
        gt.name as 'Gathering Type',
        COUNT(i.id) as 'Member Count',
        f.created_at as 'Created At',
        f.updated_at as 'Updated At'
      FROM families f
      LEFT JOIN gathering_types gt ON f.gathering_type_id = gt.id
      LEFT JOIN individuals i ON f.id = i.family_id AND i.is_active = true
      WHERE 1=1
    `;

    let params = [];

    if (gatheringTypeId) {
      query += ' AND f.gathering_type_id = ?';
      params.push(gatheringTypeId);
    }

    query += ' GROUP BY f.id, f.family_name, gt.name, f.created_at, f.updated_at';
    query += ' ORDER BY f.family_name';

    const familiesData = await Database.query(query, params);

    // Return data in requested format
    if (format.toLowerCase() === 'json') {
      res.json({ 
        data: familiesData,
        totalRecords: familiesData.length,
        generatedAt: new Date().toISOString()
      });
    } else {
      // Default to CSV format
      if (familiesData.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="families_data.csv"');
        return res.send('Family Name,Gathering Type,Member Count,Created At,Updated At\n');
      }

      // Convert to CSV
      const headers = Object.keys(familiesData[0]);
      const csvContent = [
        headers.join(','),
        ...familiesData.map(row => 
          headers.map(header => {
            const value = row[header];
            // Escape commas and quotes in CSV
            if (value === null || value === undefined) return '';
            const stringValue = String(value);
            if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
              return `"${stringValue.replace(/"/g, '""')}"`;
            }
            return stringValue;
          }).join(',')
        )
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="families_data.csv"');
      res.send(csvContent);
    }

  } catch (error) {
    console.error('IMPORTRANGE families error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve families data for IMPORTRANGE.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get summary statistics for IMPORTRANGE
router.get('/summary', async (req, res) => {
  try {
    const { 
      gatheringTypeId, 
      startDate, 
      endDate,
      format = 'csv'
    } = req.query;

    let query = `
      SELECT 
        as_table.session_date as 'Date',
        gt.name as 'Gathering Type',
        COUNT(DISTINCT CASE WHEN ar.present = 1 THEN ar.individual_id END) as 'Present Count',
        COUNT(DISTINCT CASE WHEN ar.present = 0 THEN ar.individual_id END) as 'Absent Count',
        COUNT(DISTINCT v.id) as 'Visitor Count',
        COUNT(DISTINCT ar.individual_id) + COUNT(DISTINCT v.id) as 'Total Attendance'
      FROM attendance_sessions as_table
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      LEFT JOIN attendance_records ar ON ar.session_id = as_table.id
      LEFT JOIN visitors v ON v.session_id = as_table.id
      WHERE 1=1
    `;

    let params = [];

    if (gatheringTypeId) {
      query += ' AND as_table.gathering_type_id = ?';
      params.push(gatheringTypeId);
    }

    if (startDate) {
      query += ' AND as_table.session_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND as_table.session_date <= ?';
      params.push(endDate);
    }

    query += ' GROUP BY as_table.session_date, gt.name';
    query += ' ORDER BY as_table.session_date DESC';

    const summaryData = await Database.query(query, params);

    // Return data in requested format
    if (format.toLowerCase() === 'json') {
      res.json({ 
        data: summaryData,
        totalRecords: summaryData.length,
        generatedAt: new Date().toISOString()
      });
    } else {
      // Default to CSV format
      if (summaryData.length === 0) {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="summary_data.csv"');
        return res.send('Date,Gathering Type,Present Count,Absent Count,Visitor Count,Total Attendance\n');
      }

      // Convert to CSV
      const headers = Object.keys(summaryData[0]);
      const csvContent = [
        headers.join(','),
        ...summaryData.map(row => 
          headers.map(header => {
            const value = row[header];
            // Escape commas and quotes in CSV
            if (value === null || value === undefined) return '';
            const stringValue = String(value);
            if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
              return `"${stringValue.replace(/"/g, '""')}"`;
            }
            return stringValue;
          }).join(',')
        )
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="summary_data.csv"');
      res.send(csvContent);
    }

  } catch (error) {
    console.error('IMPORTRANGE summary error:', error);
    res.status(500).json({ 
      error: 'Failed to retrieve summary data for IMPORTRANGE.',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Help endpoint to show available options
router.get('/help', (req, res) => {
  res.json({
    endpoints: {
      '/api/importrange/attendance': {
        description: 'Get attendance data for Google Sheets IMPORTRANGE',
        parameters: {
          gatheringTypeId: 'Required: ID of the gathering type',
          startDate: 'Optional: Start date (YYYY-MM-DD)',
          endDate: 'Optional: End date (YYYY-MM-DD)',
          format: 'Optional: csv or json (default: csv)',
          includeVisitors: 'Optional: true or false (default: true)',
          includeAbsent: 'Optional: true or false (default: true)'
        },
        example: '/api/importrange/attendance?gatheringTypeId=1&startDate=2024-01-01&endDate=2024-12-31'
      },
      '/api/importrange/individuals': {
        description: 'Get individuals data for Google Sheets IMPORTRANGE',
        parameters: {
          gatheringTypeId: 'Optional: ID of the gathering type',
          format: 'Optional: csv or json (default: csv)',
          includeInactive: 'Optional: true or false (default: false)'
        },
        example: '/api/importrange/individuals?gatheringTypeId=1'
      },
      '/api/importrange/families': {
        description: 'Get families data for Google Sheets IMPORTRANGE',
        parameters: {
          gatheringTypeId: 'Optional: ID of the gathering type',
          format: 'Optional: csv or json (default: csv)'
        },
        example: '/api/importrange/families?gatheringTypeId=1'
      },
      '/api/importrange/summary': {
        description: 'Get summary statistics for Google Sheets IMPORTRANGE',
        parameters: {
          gatheringTypeId: 'Optional: ID of the gathering type',
          startDate: 'Optional: Start date (YYYY-MM-DD)',
          endDate: 'Optional: End date (YYYY-MM-DD)',
          format: 'Optional: csv or json (default: csv)'
        },
        example: '/api/importrange/summary?gatheringTypeId=1&startDate=2024-01-01&endDate=2024-12-31'
      }
    },
    usage: {
      googleSheets: 'Use =IMPORTRANGE("your-api-url", "attendance") in Google Sheets',
      excel: 'Use Data > From Web to import the CSV URL',
      note: 'These endpoints are public and do not require authentication for spreadsheet integration'
    }
  });
});

module.exports = router; 