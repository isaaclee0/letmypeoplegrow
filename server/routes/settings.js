const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Get church settings
router.get('/', requireRole(['admin']), async (req, res) => {
  try {
    const settings = await Database.query(`
      SELECT 
        cs.id,
        cs.church_name,
        cs.country_code,
        cs.timezone,
        cs.email_from_name,
        cs.email_from_address,
        cs.onboarding_completed,
        cs.created_at,
        cs.updated_at
      FROM church_settings cs
      WHERE cs.church_id = ?
      LIMIT 1
    `, [req.user.church_id]);

    if (settings.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    res.json({ settings: settings[0] });
  } catch (error) {
    console.error('Get church settings error:', error);
    res.status(500).json({ error: 'Failed to retrieve church settings.' });
  }
});

// Update data access setting
// DISABLED: External data access feature is currently disabled
/*
router.put('/data-access', requireRole(['admin']), async (req, res) => {
  try {
    const { enabled } = req.body;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean value' });
    }

    // Since there's no data_access_enabled column, we'll return a success response
    // indicating that data access is always enabled for now
    res.json({ 
      message: `Data access is always enabled in this version`,
      dataAccessEnabled: true
    });
  } catch (error) {
    console.error('Update data access setting error:', error);
    res.status(500).json({ error: 'Failed to update data access setting.' });
  }
});

// Get data access setting only
router.get('/data-access', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    // Since there's no data_access_enabled column, we'll return true
    // indicating that data access is always enabled for now
    res.json({ dataAccessEnabled: true });
  } catch (error) {
    console.error('Get data access setting error:', error);
    res.status(500).json({ error: 'Failed to retrieve data access setting.' });
  }
});
*/

// Return 404 for data access endpoints since feature is disabled
router.put('/data-access', (req, res) => {
  res.status(404).json({ 
    error: 'External data access feature is currently disabled',
    message: 'This feature has been temporarily disabled'
  });
});

router.get('/data-access', (req, res) => {
  res.status(404).json({ 
    error: 'External data access feature is currently disabled',
    message: 'This feature has been temporarily disabled'
  });
});

// Get Elvanto configuration (admin only)
router.get('/elvanto-config', requireRole(['admin']), async (req, res) => {
  try {
    const settings = await Database.query(`
      SELECT 
        elvanto_client_id,
        elvanto_redirect_uri,
        CASE 
          WHEN elvanto_client_secret IS NOT NULL AND elvanto_client_secret != '' THEN 1 
          ELSE 0 
        END as has_client_secret
      FROM church_settings
      WHERE church_id = ?
      LIMIT 1
    `, [req.user.church_id]);

    if (settings.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    res.json({ 
      clientId: settings[0].elvanto_client_id || null,
      redirectUri: settings[0].elvanto_redirect_uri || null,
      hasClientSecret: settings[0].has_client_secret === 1
    });
  } catch (error) {
    console.error('Get Elvanto config error:', error);
    res.status(500).json({ error: 'Failed to retrieve Elvanto configuration.' });
  }
});

// Update Elvanto configuration (admin only)
router.put('/elvanto-config', requireRole(['admin']), async (req, res) => {
  try {
    const { clientId, clientSecret, redirectUri } = req.body;

    // Validate required fields
    if (!clientId || typeof clientId !== 'string' || clientId.trim() === '') {
      return res.status(400).json({ error: 'Client ID is required' });
    }

    if (!redirectUri || typeof redirectUri !== 'string' || redirectUri.trim() === '') {
      return res.status(400).json({ error: 'Redirect URI is required' });
    }

    // Validate redirect URI format
    try {
      new URL(redirectUri);
    } catch (e) {
      return res.status(400).json({ error: 'Redirect URI must be a valid URL' });
    }

    // Check if settings exist
    const existingSettings = await Database.query(
      'SELECT id FROM church_settings WHERE church_id = ? LIMIT 1',
      [req.user.church_id]
    );

    if (existingSettings.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    // Update Elvanto configuration
    // Only update client_secret if provided (allows updating other fields without changing secret)
    if (clientSecret !== undefined && clientSecret !== null) {
      await Database.query(`
        UPDATE church_settings
        SET elvanto_client_id = ?,
            elvanto_client_secret = ?,
            elvanto_redirect_uri = ?,
            updated_at = NOW()
        WHERE church_id = ?
      `, [clientId.trim(), clientSecret.trim(), redirectUri.trim(), req.user.church_id]);
    } else {
      await Database.query(`
        UPDATE church_settings
        SET elvanto_client_id = ?,
            elvanto_redirect_uri = ?,
            updated_at = NOW()
        WHERE church_id = ?
      `, [clientId.trim(), redirectUri.trim(), req.user.church_id]);
    }

    res.json({ 
      message: 'Elvanto configuration updated successfully',
      clientId: clientId.trim(),
      redirectUri: redirectUri.trim(),
      hasClientSecret: clientSecret !== undefined && clientSecret !== null && clientSecret.trim() !== ''
    });
  } catch (error) {
    console.error('Update Elvanto config error:', error);
    res.status(500).json({ error: 'Failed to update Elvanto configuration.' });
  }
});

module.exports = router; 