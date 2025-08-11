const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Get notifications for current user
router.get('/', async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    
    const notifications = await Database.query(`
      SELECT id, title, message, notification_type, is_read, 
             reference_type, reference_id, created_at
      FROM notifications
      WHERE user_id = ? AND church_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [req.user.id, req.user.church_id, parseInt(limit), parseInt(offset)]);

    res.json({ notifications });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to retrieve notifications.' });
  }
});

// Mark notification as read
router.put('/:id/read', async (req, res) => {
  try {
    await Database.query(`
      UPDATE notifications SET is_read = true 
      WHERE id = ? AND user_id = ? AND church_id = ?
    `, [req.params.id, req.user.id, req.user.church_id]);

    res.json({ message: 'Notification marked as read' });
  } catch (error) {
    console.error('Mark notification read error:', error);
    res.status(500).json({ error: 'Failed to update notification.' });
  }
});

module.exports = router; 