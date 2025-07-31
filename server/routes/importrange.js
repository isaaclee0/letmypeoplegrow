const express = require('express');
const Database = require('../config/database');

const router = express.Router();

// Middleware to validate API key and get church context
const validateApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required' });
    }

    // Find the API key and validate it
    const keyData = await Database.query(`
      SELECT 
        ak.id,
        ak.church_id,
        ak.permissions,
        ak.is_active,
        ak.expires_at,
        cs.church_name
      FROM api_keys ak
      JOIN church_settings cs ON ak.church_id = cs.church_id
      WHERE ak.api_key = ?
    `, [apiKey]);

    if (keyData.length === 0) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const key = keyData[0];
    
    // Check if key is active
    if (!key.is_active) {
      return res.status(401).json({ error: 'API key is inactive' });
    }

    // Check if key has expired
    if (key.expires_at && new Date() > new Date(key.expires_at)) {
      return res.status(401).json({ error: 'API key has expired' });
    }

    // Store key info in request for later use
    req.apiKey = {
      id: key.id,
      churchId: key.church_id,
      permissions: JSON.parse(key.permissions || '[]'),
      churchName: key.church_name
    };

    // Log the API access
    const startTime = Date.now();
    res.on('finish', async () => {
      try {
        await Database.query(`
          INSERT INTO api_access_logs (api_key_id, church_id, endpoint, ip_address, user_agent, response_status, response_time_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          key.id,
          key.church_id,
          req.path,
          req.ip,
          req.get('User-Agent'),
          res.statusCode,
          Date.now() - startTime
        ]);
      } catch (logError) {
        console.error('Failed to log API access:', logError);
      }
    });

    next();
  } catch (error) {
    console.error('API key validation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// Check if API key has required permission
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.apiKey.permissions.includes(permission)) {
      return res.status(403).json({ error: `Permission '${permission}' required` });
    }
    next();
  };
};

// Apply API key validation to all routes
router.use(validateApiKey);

// Get attendance data for IMPORTRANGE
router.get('/attendance', requirePermission('read_attendance'), async (req, res) => {
  try {
    const { startDate, endDate, gatheringTypeId, format = 'csv' } = req.query;
    const churchId = req.apiKey.churchId;
    
    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate and endDate are required' });
    }

    // Build the query with church isolation
    let query = `
      SELECT 
        DATE_FORMAT(as_table.session_date, '%d-%m-%Y') as date,
        gt.name as gathering_name,
        COALESCE(i.first_name, '') as first_name,
        COALESCE(i.last_name, '') as last_name,
        COALESCE(f.family_name, '') as family_name,
        CASE WHEN ar.present = 1 THEN 'Yes' ELSE 'No' END as present,
        CASE 
          WHEN ar.individual_id IS NOT NULL THEN 'Regular Member'
          WHEN ar.visitor_name IS NOT NULL AND ar.visitor_name != '' THEN 'Visitor'
          ELSE 'Unknown'
        END as attendee_type,
        CASE 
          WHEN ar.individual_id IS NULL AND ar.visitor_name IS NOT NULL AND ar.visitor_name != '' 
          THEN ar.visitor_name 
          ELSE ''
        END as visitor_name,
        CASE 
          WHEN ar.individual_id IS NULL AND ar.visitor_name IS NOT NULL AND ar.visitor_name != '' 
          THEN ar.visitor_type 
          ELSE ''
        END as visitor_type,
        COALESCE(ar.notes, '') as notes
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
        church: req.apiKey.churchName,
        data: data,
        totalRecords: data.length
      });
    } else {
      // CSV format for Google Sheets IMPORTRANGE
      const headers = ['Date', 'Gathering', 'First Name', 'Last Name', 'Family', 'Present', 'Attendee Type', 'Visitor Name', 'Visitor Type', 'Notes'];
      const csvRows = [headers, ...data.map(row => [
        row.date,
        row.gathering_name,
        row.first_name,
        row.last_name,
        row.family_name,
        row.present,
        row.attendee_type,
        row.visitor_name,
        row.visitor_type,
        row.notes
      ])];

      const csvContent = csvRows
        .map(row => row.map(field => `"${field}"`).join(','))
        .join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="attendance-importrange.csv"');
      res.send(csvContent);
    }
  } catch (error) {
    console.error('IMPORTRANGE attendance error:', error);
    res.status(500).json({ error: 'Failed to retrieve attendance data.' });
  }
});

// Get summary metrics for IMPORTRANGE
router.get('/metrics', requirePermission('read_reports'), async (req, res) => {
  try {
    const { startDate, endDate, gatheringTypeId } = req.query;
    const churchId = req.apiKey.churchId;
    
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
      church: req.apiKey.churchName,
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
    church: req.apiKey.churchName,
    timestamp: new Date().toISOString(),
    message: 'IMPORTRANGE API is working correctly'
  });
});

module.exports = router; 