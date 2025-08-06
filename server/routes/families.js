const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');

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
router.post('/', requireRole(['admin', 'coordinator']), auditLog('CREATE_FAMILY'), async (req, res) => {
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

// Create visitor family (Admin/Coordinator/Attendance Taker)
router.post('/visitor', requireRole(['admin', 'coordinator', 'attendance_taker']), auditLog('CREATE_VISITOR_FAMILY'), async (req, res) => {
  try {
    const { familyName, visitorType, notes, people } = req.body;

    if (!familyName || !visitorType || !people || people.length === 0) {
      return res.status(400).json({ error: 'Family name, visitor type, and people are required' });
    }

    await Database.transaction(async (conn) => {
      // Create visitor family
      const familyResult = await conn.query(`
        INSERT INTO families (family_name, familyType, lastAttended, created_by)
        VALUES (?, 'visitor', CURDATE(), ?)
      `, [familyName, req.user.id]);

      const familyId = Number(familyResult.insertId);

      // Add notes to family if provided
      if (notes) {
        await conn.query(`
          UPDATE families 
          SET family_identifier = ? 
          WHERE id = ?
        `, [`Visitor Type: ${visitorType}. Notes: ${notes}`, familyId]);
      } else {
        await conn.query(`
          UPDATE families 
          SET family_identifier = ? 
          WHERE id = ?
        `, [`Visitor Type: ${visitorType}`, familyId]);
      }

      // Create individuals for each person
      const createdIndividuals = [];
      let childCount = 0;

      for (let i = 0; i < people.length; i++) {
        let { firstName, lastName, firstUnknown = false, lastUnknown = false, isChild = false } = people[i];

        // Handle unknown first name
        if (firstUnknown || !firstName.trim()) {
          if (isChild) {
            childCount++;
            firstName = `Child ${childCount}`;
          } else {
            firstName = 'Unknown';
          }
        } else {
          firstName = firstName.trim() || 'Unknown';
        }

        // Handle unknown last name
        if (lastUnknown || !lastName || !lastName.trim()) {
          lastName = 'Unknown';
        } else {
          lastName = lastName.trim() || 'Unknown';
        }

        // Create individual
        const individualResult = await conn.query(`
          INSERT INTO individuals (first_name, last_name, family_id, is_visitor, created_by)
          VALUES (?, ?, ?, true, ?)
        `, [firstName, lastName, familyId, req.user.id]);

        createdIndividuals.push({
          id: Number(individualResult.insertId),
          firstName,
          lastName
        });
      }

      res.status(201).json({ 
        message: 'Visitor family created successfully',
        familyId: familyId,
        individuals: createdIndividuals
      });
    });
  } catch (error) {
    console.error('Create visitor family error:', error);
    res.status(500).json({ error: 'Failed to create visitor family.' });
  }
});

module.exports = router; 