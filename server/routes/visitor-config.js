const express = require('express');
const router = express.Router();
const Database = require('../config/database');
const { verifyToken } = require('../middleware/auth');

// Get visitor configuration for current church
router.get('/', verifyToken, async (req, res) => {
  try {
    const config = await Database.query(
      'SELECT local_visitor_service_limit, traveller_visitor_service_limit FROM visitor_config WHERE church_id = ?',
      [req.user.church_id]
    );

    if (config.length === 0) {
      // Return defaults if no config exists
      res.json({
        localVisitorServiceLimit: 6,
        travellerVisitorServiceLimit: 2
      });
    } else {
      res.json({
        localVisitorServiceLimit: config[0].local_visitor_service_limit,
        travellerVisitorServiceLimit: config[0].traveller_visitor_service_limit
      });
    }
  } catch (error) {
    console.error('Get visitor config error:', error);
    res.status(500).json({ error: 'Failed to get visitor configuration' });
  }
});

// Update visitor configuration for current church
router.put('/', verifyToken, async (req, res) => {
  try {
    const { localVisitorServiceLimit, travellerVisitorServiceLimit } = req.body;

    // Validate input
    if (
      !Number.isInteger(localVisitorServiceLimit) || 
      !Number.isInteger(travellerVisitorServiceLimit) ||
      localVisitorServiceLimit < 1 || 
      travellerVisitorServiceLimit < 1 ||
      localVisitorServiceLimit > 52 || 
      travellerVisitorServiceLimit > 52
    ) {
      return res.status(400).json({ 
        error: 'Service limits must be integers between 1 and 52' 
      });
    }

    // Insert or update configuration
    await Database.query(`
      INSERT INTO visitor_config (church_id, local_visitor_service_limit, traveller_visitor_service_limit)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE 
        local_visitor_service_limit = VALUES(local_visitor_service_limit),
        traveller_visitor_service_limit = VALUES(traveller_visitor_service_limit),
        updated_at = NOW()
    `, [req.user.church_id, localVisitorServiceLimit, travellerVisitorServiceLimit]);

    res.json({
      localVisitorServiceLimit,
      travellerVisitorServiceLimit
    });
  } catch (error) {
    console.error('Update visitor config error:', error);
    res.status(500).json({ error: 'Failed to update visitor configuration' });
  }
});

module.exports = router;
