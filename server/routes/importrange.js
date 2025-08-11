// DISABLED: External data access functionality (IMPORTRANGE)
// This feature has been temporarily disabled

/*
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    res.send(csvContent);
  } catch (error) {
    console.error('Test endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Attendance data endpoint for Google Sheets IMPORTRANGE
router.get('/attendance', validateDataAccess, async (req, res) => {
  try {
    const { gatheringTypeId, startDate, endDate, format = 'csv', includeVisitors = 'true', includeAbsent = 'true' } = req.query;
    
    if (!gatheringTypeId) {
      return res.status(400).json({ error: 'gatheringTypeId parameter is required' });
    }

    // Build the query based on parameters
    let query = `
      SELECT 
        ar.date,
        gt.name as gathering_type,
        CONCAT(i.first_name, ' ', i.last_name) as name,
        COALESCE(f.family_name, 'No Family') as family,
        CASE 
          WHEN ar.status = 'present' THEN 'Present'
          WHEN ar.status = 'absent' THEN 'Absent'
          WHEN ar.status = 'visitor' THEN 'Visitor'
          ELSE ar.status
        END as status,
        ar.created_at as recorded_at
      FROM attendance_records ar
      JOIN individuals i ON ar.individual_id = i.id
      JOIN gathering_types gt ON ar.gathering_type_id = gt.id
      LEFT JOIN families f ON i.family_id = f.id
      WHERE ar.gathering_type_id = ? AND ar.church_id = ?
    `;
    
    const params = [gatheringTypeId, req.church.id];
    
    // Add date filters if provided
    if (startDate) {
      query += ' AND ar.date >= ?';
      params.push(startDate);
    }
    
    if (endDate) {
      query += ' AND ar.date <= ?';
      params.push(endDate);
    }
    
    // Filter by visitor status
    if (includeVisitors === 'false') {
      query += ' AND ar.status != "visitor"';
    }
    
    // Filter by absent status
    if (includeAbsent === 'false') {
      query += ' AND ar.status != "absent"';
    }
    
    query += ' ORDER BY ar.date DESC, i.last_name, i.first_name';
    
    const results = await Database.query(query, params);
    
    if (format === 'json') {
      res.json({
        data: results,
        meta: {
          gatheringTypeId,
          startDate,
          endDate,
          recordCount: results.length,
          church: req.church.name
        }
      });
    } else {
      // CSV format (default)
      const formatDate = (dateString) => {
        const date = new Date(dateString);
        return date.toISOString().split('T')[0];
      };
      
      const csvContent = [
        ['Date', 'Gathering Type', 'Name', 'Family', 'Status', 'Recorded At'],
        ...results.map(row => [
          formatDate(row.date),
          row.gathering_type,
          row.name,
          row.family,
          row.status,
          formatDate(row.recorded_at)
        ])
      ].map(row => row.map(field => `"${field}"`).join(',')).join('\n');
      
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      
      res.send(csvContent);
    }
  } catch (error) {
    console.error('Attendance data endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Individuals data endpoint for Google Sheets IMPORTRANGE
router.get('/individuals', validateDataAccess, async (req, res) => {
  try {
    const { gatheringTypeId, format = 'csv', includeInactive = 'false' } = req.query;
    
    let query = `
      SELECT 
        i.first_name,
        i.last_name,
        COALESCE(f.family_name, 'No Family') as family,
        COALESCE(gt.name, 'No Gathering') as gathering_type,
        CASE WHEN i.is_active = 1 THEN 'Active' ELSE 'Inactive' END as active,
        i.created_at,
        i.updated_at
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      LEFT JOIN gathering_types gt ON gl.gathering_type_id = gt.id
      WHERE i.church_id = ?
    `;
    
    const params = [req.church.id];
    
    // Filter by gathering type if provided
    if (gatheringTypeId) {
      query += ' AND gl.gathering_type_id = ?';
      params.push(gatheringTypeId);
    }
    
    // Filter by active status
    if (includeInactive === 'false') {
      query += ' AND i.is_active = 1';
    }
    
    query += ' ORDER BY i.last_name, i.first_name';
    
    const results = await Database.query(query, params);
    
    if (format === 'json') {
      res.json({
        data: results,
        meta: {
          gatheringTypeId,
          recordCount: results.length,
          church: req.church.name
        }
      });
    } else {
      // CSV format (default)
      const formatDate = (dateString) => {
        const date = new Date(dateString);
        return date.toISOString().split('T')[0];
      };
      
      const csvContent = [
        ['First Name', 'Last Name', 'Family', 'Gathering Type', 'Active', 'Created At', 'Updated At'],
        ...results.map(row => [
          row.first_name,
          row.last_name,
          row.family,
          row.gathering_type,
          row.active,
          formatDate(row.created_at),
          formatDate(row.updated_at)
        ])
      ].map(row => row.map(field => `"${field}"`).join(',')).join('\n');
      
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      
      res.send(csvContent);
    }
  } catch (error) {
    console.error('Individuals data endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Families data endpoint for Google Sheets IMPORTRANGE
router.get('/families', validateDataAccess, async (req, res) => {
  try {
    const { format = 'csv' } = req.query;
    
    const query = `
      SELECT 
        f.family_name,
        COUNT(i.id) as member_count,
        f.family_type,
        f.last_attended,
        f.created_at,
        f.updated_at
      FROM families f
      LEFT JOIN individuals i ON f.id = i.family_id AND i.is_active = 1
      WHERE f.church_id = ?
      GROUP BY f.id
      ORDER BY f.family_name
    `;
    
    const results = await Database.query(query, [req.church.id]);
    
    if (format === 'json') {
      res.json({
        data: results,
        meta: {
          recordCount: results.length,
          church: req.church.name
        }
      });
    } else {
      // CSV format (default)
      const formatDate = (dateString) => {
        if (!dateString) return '';
        const date = new Date(dateString);
        return date.toISOString().split('T')[0];
      };
      
      const csvContent = [
        ['Family Name', 'Member Count', 'Family Type', 'Last Attended', 'Created At', 'Updated At'],
        ...results.map(row => [
          row.family_name,
          row.member_count,
          row.family_type,
          formatDate(row.last_attended),
          formatDate(row.created_at),
          formatDate(row.updated_at)
        ])
      ].map(row => row.map(field => `"${field}"`).join(',')).join('\n');
      
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      
      res.send(csvContent);
    }
  } catch (error) {
    console.error('Families data endpoint error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
*/

// Export empty router since feature is disabled
const express = require('express');
const router = express.Router();

// Return 404 for all importrange routes
router.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'External data access feature is currently disabled',
    message: 'This feature has been temporarily disabled'
  });
});

module.exports = router; 