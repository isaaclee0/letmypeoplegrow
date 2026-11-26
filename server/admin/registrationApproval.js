const express = require('express');
const Database = require('../config/database');

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({ enabled: Database.getRegistrationAutoApproval() });
});

router.put('/', (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'The enabled setting must be a boolean.' });
  }
  Database.setRegistrationAutoApproval(enabled);
  res.json({ enabled });
});

module.exports = router;
