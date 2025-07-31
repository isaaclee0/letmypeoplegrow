const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();
router.use(verifyToken);

// Generate a secure API key
const generateApiKey = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Get all API keys for the church
router.get('/', requireRole(['admin']), async (req, res) => {
  try {
    const churchId = req.user.church_id;
    
    const apiKeys = await Database.query(`
      SELECT 
        ak.id,
        ak.key_name,
        ak.api_key,
        ak.permissions,
        ak.is_active,
        ak.expires_at,
        ak.last_used_at,
        ak.created_at,
        u.first_name,
        u.last_name
      FROM api_keys ak
      LEFT JOIN users u ON ak.created_by = u.id
      WHERE ak.church_id = ?
      ORDER BY ak.created_at DESC
    `, [churchId]);

    // Return full API keys for easy copy-paste
    const fullKeys = apiKeys.map(key => ({
      ...key,
      permissions: JSON.parse(key.permissions || '[]')
    }));

    res.json({ apiKeys: fullKeys });
  } catch (error) {
    console.error('Get API keys error:', error);
    res.status(500).json({ error: 'Failed to retrieve API keys.' });
  }
});

// Create a new API key
router.post('/', requireRole(['admin']), async (req, res) => {
  try {
    const { keyName, permissions = ['read_attendance', 'read_reports'], expiresAt } = req.body;
    const churchId = req.user.church_id;
    
    if (!keyName) {
      return res.status(400).json({ error: 'Key name is required' });
    }

    const apiKey = generateApiKey();
    
    const result = await Database.query(`
      INSERT INTO api_keys (church_id, key_name, api_key, permissions, expires_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [churchId, keyName, apiKey, JSON.stringify(permissions), expiresAt || null, req.user.id]);

    // Return the full API key only once for the user to copy
    res.json({ 
      message: 'API key created successfully',
      apiKey: {
        id: result.insertId,
        keyName,
        apiKey, // Full key for one-time display
        permissions,
        expiresAt
      }
    });
  } catch (error) {
    console.error('Create API key error:', error);
    res.status(500).json({ error: 'Failed to create API key.' });
  }
});

// Update an API key
router.put('/:id', requireRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { keyName, permissions, isActive, expiresAt } = req.body;
    const churchId = req.user.church_id;
    
    const result = await Database.query(`
      UPDATE api_keys 
      SET key_name = ?, permissions = ?, is_active = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND church_id = ?
    `, [keyName, JSON.stringify(permissions), isActive, expiresAt || null, id, churchId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key updated successfully' });
  } catch (error) {
    console.error('Update API key error:', error);
    res.status(500).json({ error: 'Failed to update API key.' });
  }
});

// Delete an API key
router.delete('/:id', requireRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.user.church_id;
    
    const result = await Database.query(`
      DELETE FROM api_keys 
      WHERE id = ? AND church_id = ?
    `, [id, churchId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ message: 'API key deleted successfully' });
  } catch (error) {
    console.error('Delete API key error:', error);
    res.status(500).json({ error: 'Failed to delete API key.' });
  }
});

// Get API key usage statistics
router.get('/:id/stats', requireRole(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.user.church_id;
    
    const stats = await Database.query(`
      SELECT 
        COUNT(*) as total_requests,
        COUNT(CASE WHEN response_status >= 200 AND response_status < 300 THEN 1 END) as successful_requests,
        COUNT(CASE WHEN response_status >= 400 THEN 1 END) as failed_requests,
        AVG(response_time_ms) as avg_response_time,
        MAX(created_at) as last_used
      FROM api_access_logs
      WHERE api_key_id = ? AND church_id = ?
    `, [id, churchId]);

    res.json({ stats: stats[0] });
  } catch (error) {
    console.error('Get API key stats error:', error);
    res.status(500).json({ error: 'Failed to retrieve API key statistics.' });
  }
});

// Activate API access with one-time token
router.post('/activate', requireRole(['admin']), async (req, res) => {
  try {
    const { token } = req.body;
    const churchId = req.user.church_id;
    
    if (!token) {
      return res.status(400).json({ error: 'Activation token is required' });
    }

    // Validate the activation token
    // This should be a secure token provided by system administrators
    // For now, we'll use a simple validation - in production, this should be more secure
    const validTokens = process.env.API_ACTIVATION_TOKENS ? 
      process.env.API_ACTIVATION_TOKENS.split(',') : 
      ['demo-activation-token-2024']; // Default for development
    
    if (!validTokens.includes(token)) {
      return res.status(401).json({ error: 'Invalid activation token' });
    }

    // Check if API access is already enabled for this church
    const existingKeys = await Database.query(`
      SELECT COUNT(*) as count FROM api_keys WHERE church_id = ?
    `, [churchId]);

    if (existingKeys[0].count > 0) {
      return res.status(400).json({ error: 'API access is already enabled for this church' });
    }

    // Create a default API key for the church
    const apiKey = generateApiKey();
    const result = await Database.query(`
      INSERT INTO api_keys (church_id, key_name, api_key, permissions, created_by)
      VALUES (?, ?, ?, ?, ?)
    `, [churchId, 'Default API Key', apiKey, JSON.stringify(['read_attendance', 'read_reports']), req.user.id]);

    res.json({ 
      message: 'API access activated successfully',
      apiKey: {
        id: result.insertId,
        keyName: 'Default API Key',
        apiKey: apiKey,
        permissions: ['read_attendance', 'read_reports']
      }
    });
  } catch (error) {
    console.error('Activate API access error:', error);
    res.status(500).json({ error: 'Failed to activate API access.' });
  }
});

module.exports = router; 