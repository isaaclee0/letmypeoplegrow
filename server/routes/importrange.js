const express = require('express');
const Database = require('../config/database');

const router = express.Router();

// Add CORS headers for Google Sheets IMPORTRANGE
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Middleware to validate church data access
const validateDataAccess = async (req, res, next) => {
  try {
    // For now, we'll use a simple approach - you can enhance this later
    // Get the church ID from the request (you might want to add this as a parameter)
    const churchId = req.query.church_id || req.headers['x-church-id'];
    
    if (!churchId) {
      return res.status(400).json({ error: 'Church ID required' });
    }

    // Check if data access is enabled for this church
    const churchData = await Database.query(`
      SELECT 
        cs.church_id,
        cs.church_name,
        cs.data_access_enabled
      FROM church_settings cs
      WHERE cs.church_id = ?
    `, [churchId]);

    if (churchData.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }

    const church = churchData[0];
    
    // Check if data access is enabled for this church
    if (!church.data_access_enabled) {
      return res.status(403).json({ 
        error: 'External data access is disabled for this church',
        message: 'An administrator must enable external data access in the settings to use this API'
      });
    }

    // Store church info in request for later use
    req.church = {
      id: church.church_id,
      name: church.church_name
    };

    next();
  } catch (error) {
    console.error('Data access validation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Test endpoint for Google Sheets debugging (before validation)
router.get('/test', async (req, res) => {
  try {
    console.log('🧪 Test endpoint called by:', req.get('User-Agent'));
    
    const testData = [
      ['Date', 'Name', 'Status'],
      ['2025-01-01', 'John Doe', 'Present'],
      ['2025-01-01', 'Jane Smith', 'Present'],
      ['2025-01-08', 'John Doe', 'Absent']
    ];
    
    const csvContent = testData
      .map(row => row.map(field => `"${field}"`).join(','))
      .join('\n');
    
    // Clear all headers and set only what Google Sheets needs
    res.removeHeader('Cache-Control');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('X-Content-Type-Options');
    res.removeHeader('X-XSS-Protection');
    res.removeHeader('Strict-Transport-Security');
    res.removeHeader('X-Download-Options');
    res.removeHeader('X-Permitted-Cross-Domain-Policies');
    res.removeHeader('Referrer-Policy');
    res.removeHeader('X-DNS-Prefetch-Control');
    res.removeHeader('Origin-Agent-Cluster');
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('Cross-Origin-Resource-Policy');
    
    // Set only essential headers
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    res.send(csvContent);
    
    console.log('🧪 Test CSV sent successfully');
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ error: 'Test failed' });
  }
});

// Public attendance endpoint for Google Sheets testing (no authentication required)
router.get('/public-attendance', async (req, res) => {
  try {
    console.log('🌐 Public attendance endpoint called by:', req.get('User-Agent'));
    
    // Use hardcoded values for testing
    const churchId = '015e573a-6dd4-11f0-b18f-f6625cd7ff69';
    const gatheringTypeId = 1;
    const startDate = '2025-01-01';
    const endDate = '2025-12-31';
    
    // Get attendance data directly (bypass validation)
    const data = await Database.query(`
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
      WHERE as_table.church_id = ? 
        AND as_table.session_date >= ? 
        AND as_table.session_date <= ?
        AND as_table.gathering_type_id = ?
      ORDER BY as_table.session_date DESC, f.family_name, i.last_name, i.first_name
    `, [churchId, startDate, endDate, gatheringTypeId]);

    // Helper function to format date as DD-MM-YYYY
    const formatDate = (dateString) => {
      if (!dateString) return '';
      const date = new Date(dateString);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = date.getFullYear();
      return `${day}-${month}-${year}`;
    };

    const csvHeaders = ['Date', 'Gathering', 'First Name', 'Last Name', 'Family', 'Present', 'Attendee Type', 'Visitor Name', 'Visitor Type', 'Notes'];
    const csvRows = data.map(row => [
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
      .map(row => row.map(field => {
        const cleanField = String(field || '').replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/"/g, '""');
        return `"${cleanField}"`;
      }).join(','))
      .join('\n');

    // Minimal headers for Google Sheets IMPORTDATA
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    res.send(csvContent);
    
    console.log('🌐 Public attendance CSV sent successfully');
  } catch (error) {
    console.error('Public attendance endpoint error:', error);
    res.status(500).json({ error: 'Failed to retrieve attendance data.' });
  }
});

// Apply data access validation to all routes
router.use(validateDataAccess);

// Get attendance data for IMPORTRANGE
router.get('/attendance', async (req, res) => {
  try {
    const { startDate, endDate, gatheringTypeId, format = 'csv' } = req.query;
    const churchId = req.church.id;
    
    // Debug logging for Google Sheets troubleshooting
    console.log('🔍 IMPORTRANGE request:', {
      userAgent: req.get('User-Agent'),
      referer: req.get('Referer'),
      origin: req.get('Origin'),
      params: { startDate, endDate, gatheringTypeId, format, churchId }
    });
    
    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    // Build the query with church isolation - match the export format exactly
    let query = `
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
      WHERE as_table.church_id = ? 
        AND as_table.session_date >= ? 
        AND as_table.session_date <= ?
    `;

    const params = [churchId, startDate, endDate];

    if (gatheringTypeId) {
      query += ' AND as_table.gathering_type_id = ?';
      params.push(gatheringTypeId);
    }

    query += ' ORDER BY as_table.session_date DESC, f.family_name, i.last_name, i.first_name';

    const data = await Database.query(query, params);

    if (format === 'json') {
      res.json({ 
        church: req.church.name,
        data: data,
        totalRecords: data.length
      });
    } else {
      // CSV format for Google Sheets IMPORTRANGE - match export format exactly
      
      // Helper function to format date as DD-MM-YYYY (same as export)
      const formatDate = (dateString) => {
        if (!dateString) return '';
        const date = new Date(dateString);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const year = date.getFullYear();
        return `${day}-${month}-${year}`;
      };

      const csvHeaders = ['Date', 'Gathering', 'First Name', 'Last Name', 'Family', 'Present', 'Attendee Type', 'Visitor Name', 'Visitor Type', 'Notes'];
      const csvRows = data.map(row => [
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
        .map(row => row.map(field => {
          // Clean the field - remove any line breaks and escape quotes
          const cleanField = String(field || '').replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/"/g, '""');
          return `"${cleanField}"`;
        }).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      console.log('📤 Sending CSV response:', {
        rowCount: csvRows.length,
        contentLength: csvContent.length,
        firstFewLines: csvContent.split('\n').slice(0, 3).join(' | ')
      });
      
      res.send(csvContent);
    }
  } catch (error) {
    console.error('IMPORTRANGE attendance error:', error);
    res.status(500).json({ error: 'Failed to retrieve attendance data.' });
  }
});

// Get summary metrics for IMPORTRANGE
router.get('/metrics', async (req, res) => {
  try {
    const { startDate, endDate, gatheringTypeId } = req.query;
    const churchId = req.church.id;
    
    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    // Get attendance summary
    const attendanceData = await Database.query(`
      SELECT 
        DATE_FORMAT(as_table.session_date, '%d-%m-%Y') as date,
        gt.name as gathering_name,
        COUNT(DISTINCT ar.individual_id) as regular_members,
        COUNT(DISTINCT CASE WHEN ar.visitor_name IS NOT NULL AND ar.visitor_name != '' THEN ar.id END) as visitors,
        COUNT(DISTINCT CASE WHEN ar.present = 1 THEN ar.individual_id END) as present_members,
        COUNT(DISTINCT CASE WHEN ar.present = 0 THEN ar.individual_id END) as absent_members
      FROM attendance_sessions as_table
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
      WHERE as_table.church_id = ? 
        AND as_table.session_date >= ? 
        AND as_table.session_date <= ?
      ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
      GROUP BY as_table.session_date, as_table.gathering_type_id, gt.name
      ORDER BY as_table.session_date DESC
    `, gatheringTypeId ? [churchId, startDate, endDate, gatheringTypeId] : [churchId, startDate, endDate]);

    // Get overall metrics
    const overallMetrics = await Database.query(`
      SELECT 
        COUNT(DISTINCT as_table.id) as total_sessions,
        COUNT(DISTINCT ar.individual_id) as total_regular_members,
        COUNT(DISTINCT CASE WHEN ar.visitor_name IS NOT NULL AND ar.visitor_name != '' THEN ar.id END) as total_visitors,
        AVG(CASE WHEN ar.present = 1 THEN 1 ELSE 0 END) * 100 as average_attendance_rate
      FROM attendance_sessions as_table
      LEFT JOIN attendance_records ar ON as_table.id = ar.session_id
      WHERE as_table.church_id = ? 
        AND as_table.session_date >= ? 
        AND as_table.session_date <= ?
      ${gatheringTypeId ? 'AND as_table.gathering_type_id = ?' : ''}
    `, gatheringTypeId ? [churchId, startDate, endDate, gatheringTypeId] : [churchId, startDate, endDate]);

    res.json({
      church: req.church.name,
      period: { startDate, endDate },
      summary: overallMetrics[0],
      dailyData: attendanceData
    });
  } catch (error) {
    console.error('IMPORTRANGE metrics error:', error);
    res.status(500).json({ error: 'Failed to retrieve metrics data.' });
  }
});

// Health check endpoint for IMPORTRANGE
router.get('/health', (req, res) => {
  res.json({ 
    status: 'OK',
    church: req.church.name,
    timestamp: new Date().toISOString(),
    message: 'IMPORTRANGE API is working correctly'
  });
});

module.exports = router; 