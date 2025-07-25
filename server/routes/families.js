const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

// Get families
router.get('/', async (req, res) => {
  try {
    const families = await Database.query(`
      SELECT f.*, COUNT(i.id) as member_count
      FROM families f
      LEFT JOIN individuals i ON f.id = i.family_id AND i.is_active = true
      GROUP BY f.id
      ORDER BY f.family_name
    `);
    
    // Convert BigInt values to regular numbers to avoid JSON serialization issues
    const processedFamilies = families.map(family => ({
      ...family,
      id: Number(family.id),
      member_count: Number(family.member_count)
    }));
    
    res.json({ families: processedFamilies });
  } catch (error) {
    console.error('Get families error:', error);
    res.status(500).json({ error: 'Failed to retrieve families.' });
  }
});

// Create family (Admin/Coordinator)
router.post('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { familyName, familyIdentifier } = req.body;
    const result = await Database.query(`
      INSERT INTO families (family_name, family_identifier, created_by)
      VALUES (?, ?, ?)
    `, [familyName, familyIdentifier, req.user.id]);

    res.status(201).json({ message: 'Family created', id: result.insertId });
  } catch (error) {
    console.error('Create family error:', error);
    res.status(500).json({ error: 'Failed to create family.' });
  }
});

module.exports = router; 