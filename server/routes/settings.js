const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Get church settings
router.get('/', requireRole(['admin']), async (req, res) => {
  try {
    const churchId = req.user.church_id;
    
    const settings = await Database.query(`
      SELECT 
        cs.id,
        cs.church_name,
        cs.country_code,
        cs.timezone,
        cs.email_from_name,
        cs.email_from_address,
        cs.onboarding_completed,
        cs.data_access_enabled,
        cs.created_at,
        cs.updated_at
      FROM church_settings cs
      WHERE cs.church_id = ?
    `, [churchId]);

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
router.put('/data-access', requireRole(['admin']), async (req, res) => {
  try {
    const { enabled } = req.body;
    const churchId = req.user.church_id;
    
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean value' });
    }

    const result = await Database.query(`
      UPDATE church_settings 
      SET data_access_enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE church_id = ?
    `, [enabled, churchId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    res.json({ 
      message: `Data access ${enabled ? 'enabled' : 'disabled'} successfully`,
      dataAccessEnabled: enabled
    });
  } catch (error) {
    console.error('Update data access setting error:', error);
    res.status(500).json({ error: 'Failed to update data access setting.' });
  }
});

// Get data access setting only
router.get('/data-access', requireRole(['admin']), async (req, res) => {
  try {
    const churchId = req.user.church_id;
    
    const result = await Database.query(`
      SELECT data_access_enabled
      FROM church_settings
      WHERE church_id = ?
    `, [churchId]);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Church settings not found' });
    }

    res.json({ dataAccessEnabled: result[0].data_access_enabled });
  } catch (error) {
    console.error('Get data access setting error:', error);
    res.status(500).json({ error: 'Failed to retrieve data access setting.' });
  }
});

module.exports = router; 