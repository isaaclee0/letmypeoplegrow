const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');
const { ensureChurchIsolation } = require('../middleware/churchIsolation');

const router = express.Router();
router.use(verifyToken);
router.use(ensureChurchIsolation);

// Get families
router.get('/', async (req, res) => {
  try {
    const families = await Database.query(`
      SELECT 
        f.id,
        f.family_name AS familyName,
        f.family_notes AS familyNotes,
        f.family_type AS familyType,
        f.last_attended AS lastAttended,
        COUNT(i.id) AS memberCount
      FROM families f
      JOIN individuals i ON f.id = i.family_id AND i.is_active = 1
      WHERE f.church_id = ?
      GROUP BY f.id
      ORDER BY f.family_name
    `, [req.user.church_id]);

    // Convert BigInt values to regular numbers to avoid JSON serialization issues
    const processedFamilies = families.map((family) => ({
      ...family,
      id: Number(family.id),
      memberCount: Number(family.memberCount)
    }));

    res.json({ families: processedFamilies });
  } catch (error) {
    console.error('Get families error:', error);
    res.status(500).json({ error: 'Failed to retrieve families.' });
  }
});

// Get all families (including those with inactive members) - Admin only
router.get('/all', requireRole(['admin']), async (req, res) => {
  try {
    const families = await Database.query(`
      SELECT 
        f.id,
        f.family_name AS familyName,
        f.family_notes AS familyNotes,
        f.family_type AS familyType,
        f.last_attended AS lastAttended,
        COUNT(CASE WHEN i.is_active = 1 THEN i.id END) AS activeMemberCount,
        COUNT(i.id) AS totalMemberCount
      FROM families f
      LEFT JOIN individuals i ON f.id = i.family_id
      WHERE f.church_id = ?
      GROUP BY f.id
      ORDER BY f.family_name
    `, [req.user.church_id]);

    // Convert BigInt values to regular numbers to avoid JSON serialization issues
    const processedFamilies = families.map((family) => ({
      ...family,
      id: Number(family.id),
      activeMemberCount: Number(family.activeMemberCount),
      totalMemberCount: Number(family.totalMemberCount)
    }));

    res.json({ families: processedFamilies });
  } catch (error) {
    console.error('Get all families error:', error);
    res.status(500).json({ error: 'Failed to retrieve all families.' });
  }
});

// Create family (Admin/Coordinator)
router.post('/', requireRole(['admin', 'coordinator']), auditLog('CREATE_FAMILY'), async (req, res) => {
  try {
    const { familyName } = req.body;
    const result = await Database.query(`
      INSERT INTO families (family_name, created_by, church_id)
      VALUES (?, ?, ?)
    `, [familyName, req.user.id, req.user.church_id]);

    res.status(201).json({ message: 'Family created', id: Number(result.insertId) });
  } catch (error) {
    console.error('Create family error:', error);
    res.status(500).json({ error: 'Failed to create family.' });
  }
});

// Update family (Admin/Coordinator)
router.put('/:id', requireRole(['admin', 'coordinator']), auditLog('UPDATE_FAMILY'), async (req, res) => {
  try {
    const { id } = req.params;
    const { familyName, familyType, familyNotes } = req.body;

    if (!familyName && !familyType && familyNotes === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const fields = [];
    const values = [];

    if (familyName) {
      fields.push('family_name = ?');
      values.push(familyName);
    }

    if (familyType && ['regular', 'local_visitor', 'traveller_visitor'].includes(familyType)) {
      fields.push('family_type = ?');
      values.push(familyType);
    }

    if (familyNotes !== undefined) {
      fields.push('family_notes = ?');
      values.push(familyNotes);
    }

    values.push(id, req.user.church_id);

    const result = await Database.query(
      `UPDATE families SET ${fields.join(', ')}, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Family not found' });
    }

    // If family_type was changed, sync all active members' people_type to match
    if (familyType && ['regular', 'local_visitor', 'traveller_visitor'].includes(familyType)) {
      try {
        await Database.query(
          `UPDATE individuals SET people_type = ?, updated_at = datetime('now') WHERE family_id = ? AND is_active = 1 AND church_id = ?`,
          [familyType, id, req.user.church_id]
        );
      } catch (error) {
        console.error('Error syncing individual people_type with family_type:', error);
        // Don't fail the request - log error but continue
      }
    }

    res.json({ message: 'Family updated successfully', id: Number(id) });
  } catch (error) {
    console.error('Update family error:', error);
    res.status(500).json({ error: 'Failed to update family.' });
  }
});

// Delete family if empty (Admin only)
router.delete('/:id', requireRole(['admin']), auditLog('DELETE_FAMILY_IF_EMPTY'), async (req, res) => {
  try {
    const { id } = req.params;

    // Check active member count
    const members = await Database.query(
      'SELECT COUNT(1) as cnt FROM individuals WHERE family_id = ? AND is_active = 1 AND church_id = ?',
      [id, req.user.church_id]
    );

    if (Number(members[0].cnt) > 0) {
      return res.status(400).json({ error: 'Family is not empty' });
    }

    const result = await Database.query(
      `UPDATE families SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      [id, req.user.church_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Family not found' });
    }

    res.json({ message: 'Family deleted successfully', id: Number(id) });
  } catch (error) {
    console.error('Delete family error:', error);
    res.status(500).json({ error: 'Failed to delete family.' });
  }
});

// Create visitor family (Admin/Coordinator/Attendance Taker)
router.post('/visitor', requireRole(['admin', 'coordinator', 'attendance_taker']), auditLog('CREATE_VISITOR_FAMILY'), async (req, res) => {
  try {
    const { familyName, peopleType, notes, people } = req.body;

    if (!familyName || !peopleType || !people || people.length === 0) {
      return res.status(400).json({ error: 'Family name, people type, and people are required' });
    }

    const payload = await Database.transaction(async (conn) => {
      // Create family with specific visitor type - now family_type matches people_type
      const familyResult = await conn.query(`
        INSERT INTO families (family_name, family_notes, family_type, created_by, church_id)
        VALUES (?, ?, ?, ?, ?)
      `, [familyName, notes || null, peopleType, req.user.id, req.user.church_id]);

      const familyId = Number(familyResult.insertId);

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

        // Create individual with the new peopleType
        const individualResult = await conn.query(`
          INSERT INTO individuals (first_name, last_name, family_id, is_child, people_type, created_by, church_id)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [firstName, lastName, familyId, isChild ? true : false, peopleType, req.user.id, req.user.church_id]);

        createdIndividuals.push({
          id: Number(individualResult.insertId),
          firstName,
          lastName
        });
      }

      return { familyId, createdIndividuals };
    });

    // Send response after transaction has committed so addVisitorFamilyToService sees the new rows
    res.status(201).json({
      message: 'Family created successfully',
      familyId: payload.familyId,
      individuals: payload.createdIndividuals
    });
  } catch (error) {
    console.error('Create family error:', error);
    res.status(500).json({ error: 'Failed to create family.' });
  }
});

// Merge families (Admin only)
router.post('/merge', requireRole(['admin']), auditLog('MERGE_FAMILIES'), async (req, res) => {
  try {
    const { keepFamilyId, mergeFamilyIds, newFamilyName, newFamilyType } = req.body;
    
    if (!keepFamilyId || !mergeFamilyIds || !Array.isArray(mergeFamilyIds)) {
      return res.status(400).json({ error: 'Invalid request. Must provide keepFamilyId and mergeFamilyIds array.' });
    }
    
    // Start a transaction
    await Database.transaction(async (conn) => {
      // Update the family name and type if provided
      if (newFamilyName || newFamilyType) {
        const updateFields = [];
        const updateValues = [];
        
        if (newFamilyName) {
          updateFields.push('family_name = ?');
          updateValues.push(newFamilyName);
        }
        
        if (newFamilyType) {
          updateFields.push('family_type = ?');
          updateValues.push(newFamilyType);
        }
        
        updateValues.push(keepFamilyId);
        
        await conn.query(`
          UPDATE families 
          SET ${updateFields.join(', ')}, updated_at = datetime('now')
          WHERE id = ? AND church_id = ?
        `, [...updateValues, req.user.church_id]);
      }
      
      // Move all individuals from merged families to the kept family
      await conn.query(`
        UPDATE individuals 
        SET family_id = ?, updated_at = datetime('now')
        WHERE family_id IN (?) AND church_id = ?
      `, [keepFamilyId, mergeFamilyIds, req.user.church_id]);
      
      // Soft delete the merged families
      await conn.query(`
        UPDATE families
        SET is_active = 0, updated_at = datetime('now')
        WHERE id IN (?) AND church_id = ?
      `, [mergeFamilyIds, req.user.church_id]);
    });
    
    res.json({ 
      message: 'Families merged successfully', 
      keptFamilyId: keepFamilyId, 
      mergedFamilyIds: mergeFamilyIds 
    });
  } catch (error) {
    console.error('Merge families error:', error);
    res.status(500).json({ error: 'Failed to merge families.' });
  }
});

// Merge individuals into family (Admin only)
router.post('/merge-individuals', requireRole(['admin']), auditLog('MERGE_INDIVIDUALS_INTO_FAMILY'), async (req, res) => {
  try {
    const { individualIds, familyName, familyType, mergeAssignments } = req.body;
    
    if (!individualIds || !Array.isArray(individualIds) || individualIds.length === 0) {
      return res.status(400).json({ error: 'Invalid request. Must provide individualIds array.' });
    }
    
    if (!familyName) {
      return res.status(400).json({ error: 'Family name is required.' });
    }
    
    // Start a transaction
    await Database.transaction(async (conn) => {
      // Create new family
      const familyResult = await conn.query(`
        INSERT INTO families (family_name, family_type, created_by, church_id)
        VALUES (?, ?, ?, ?)
      `, [familyName, familyType || 'regular', req.user.id, req.user.church_id]);
      
      const newFamilyId = Number(familyResult.insertId);
      
      // Move individuals to the new family
      await conn.query(`
        UPDATE individuals 
        SET family_id = ?, updated_at = datetime('now')
        WHERE id IN (?) AND church_id = ?
      `, [newFamilyId, individualIds, req.user.church_id]);
      
      // If merging assignments, consolidate all gathering assignments
      if (mergeAssignments) {
        // Get all unique gathering assignments from the individuals
        const assignments = await conn.query(`
          SELECT DISTINCT gathering_type_id
          FROM gathering_lists
          WHERE individual_id IN (?) AND church_id = ?
        `, [individualIds, req.user.church_id]);
        
        // Add assignments to all individuals in the new family
        for (const assignment of assignments) {
          await conn.query(`
            INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(gathering_type_id, individual_id) DO UPDATE SET added_by = excluded.added_by
          `, [assignment.gathering_type_id, newFamilyId, req.user.id, req.user.church_id]);
        }
      }
    });
    
    res.json({ 
      message: 'Individuals merged into family successfully', 
      individualIds: individualIds,
      familyName: familyName
    });
  } catch (error) {
    console.error('Merge individuals into family error:', error);
    res.status(500).json({ error: 'Failed to merge individuals into family.' });
  }
});

// Get caregivers for a family (Admin/Coordinator)
router.get('/:id/caregivers', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const caregivers = await Database.query(
      `SELECT
         fc.id,
         fc.caregiver_type,
         fc.user_id,
         fc.contact_id,
         CASE fc.caregiver_type WHEN 'user' THEN u.first_name ELSE c.first_name END as first_name,
         CASE fc.caregiver_type WHEN 'user' THEN u.last_name ELSE c.last_name END as last_name,
         CASE fc.caregiver_type WHEN 'user' THEN u.email ELSE c.email END as email,
         CASE fc.caregiver_type WHEN 'user' THEN u.mobile_number ELSE c.mobile_number END as mobile_number
       FROM family_caregivers fc
       LEFT JOIN users u ON fc.user_id = u.id
       LEFT JOIN contacts c ON fc.contact_id = c.id AND c.is_active = 1
       WHERE fc.family_id = ? AND fc.church_id = ?
       ORDER BY last_name, first_name`,
      [id, req.user.church_id]
    );
    res.json({ caregivers });
  } catch (error) {
    console.error('Failed to fetch caregivers:', error);
    res.status(500).json({ error: 'Failed to fetch caregivers' });
  }
});

// Assign a caregiver to a family (Admin/Coordinator)
router.post('/:id/caregivers', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { caregiver_type, user_id, contact_id } = req.body;

    if (!['user', 'contact'].includes(caregiver_type)) {
      return res.status(400).json({ error: 'caregiver_type must be "user" or "contact"' });
    }
    if (caregiver_type === 'user' && !user_id) {
      return res.status(400).json({ error: 'user_id is required when caregiver_type is "user"' });
    }
    if (caregiver_type === 'contact' && !contact_id) {
      return res.status(400).json({ error: 'contact_id is required when caregiver_type is "contact"' });
    }

    const [family] = await Database.query(
      `SELECT id FROM families WHERE id = ? AND church_id = ?`,
      [id, req.user.church_id]
    );
    if (!family) return res.status(404).json({ error: 'Family not found' });

    try {
      await Database.query(
        `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, user_id, contact_id)
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.church_id, id, caregiver_type, user_id || null, contact_id || null]
      );
    } catch (uniqueErr) {
      if (!uniqueErr.message?.includes('UNIQUE constraint failed')) throw uniqueErr;
      // Already assigned — idempotent
    }

    res.json({ message: 'Caregiver assigned' });
  } catch (error) {
    console.error('Failed to assign caregiver:', error);
    res.status(500).json({ error: 'Failed to assign caregiver' });
  }
});

// Remove a caregiver from a family (Admin/Coordinator)
router.delete('/:id/caregivers/:caregiverId', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id, caregiverId } = req.params;
    await Database.query(
      `DELETE FROM family_caregivers WHERE id = ? AND family_id = ? AND church_id = ?`,
      [caregiverId, id, req.user.church_id]
    );
    res.json({ message: 'Caregiver removed' });
  } catch (error) {
    console.error('Failed to remove caregiver:', error);
    res.status(500).json({ error: 'Failed to remove caregiver' });
  }
});

module.exports = router;