const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Get all notification rules for user
router.get('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const rules = await Database.query(
      `SELECT * FROM notification_rules WHERE created_by = ? OR is_default = true`,
      [req.user.id]
    );
    res.json({ rules });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch rules' });
  }
});

// Create new rule
router.post('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { rule_name, target_group, trigger_event, threshold_count, timeframe_periods, gathering_type_id } = req.body;
    const result = await Database.query(
      `INSERT INTO notification_rules (created_by, gathering_type_id, rule_name, target_group, trigger_event, threshold_count, timeframe_periods) VALUES (?, ?, ?, ?, ?, ?, ?)` ,
      [req.user.id, gathering_type_id, rule_name, target_group, trigger_event, threshold_count, timeframe_periods]
    );
    res.json({ id: result.insertId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

// Update rule
router.put('/:id', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { rule_name, target_group, trigger_event, threshold_count, timeframe_periods, gathering_type_id, is_active } = req.body;
    await Database.query(
      `UPDATE notification_rules SET rule_name = ?, target_group = ?, trigger_event = ?, threshold_count = ?, timeframe_periods = ?, gathering_type_id = ?, is_active = ? WHERE id = ? AND created_by = ?` ,
      [rule_name, target_group, trigger_event, threshold_count, timeframe_periods, gathering_type_id, is_active, id, req.user.id]
    );
    res.json({ message: 'Rule updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

// Delete rule
router.delete('/:id', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    await Database.query(`DELETE FROM notification_rules WHERE id = ? AND created_by = ?`, [id, req.user.id]);
    res.json({ message: 'Rule deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

module.exports = router; 