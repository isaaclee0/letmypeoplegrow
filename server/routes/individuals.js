const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { requireIsVisitorColumn } = require('../utils/databaseSchema');
const { processApiResponse } = require('../utils/caseConverter');

const router = express.Router();
router.use(verifyToken);

// Get potential duplicates based on name matching
router.get('/duplicates', requireRole(['admin']), async (req, res) => {
  try {
    const individuals = await Database.query(`
      SELECT 
        i.id,
        i.first_name,
        i.last_name,
        i.family_id,
        f.family_name,
        i.is_active,
        i.created_at,
        GROUP_CONCAT(DISTINCT gt.id) as gathering_ids,
        GROUP_CONCAT(DISTINCT gt.name) as gathering_names,
        COUNT(*) OVER (PARTITION BY LOWER(i.first_name), LOWER(i.last_name)) as name_count
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      LEFT JOIN gathering_types gt ON gl.gathering_type_id = gt.id
      WHERE i.is_active = true
      GROUP BY i.id, i.first_name, i.last_name
      HAVING name_count > 1
      ORDER BY LOWER(i.last_name), LOWER(i.first_name), i.created_at
    `);
    
    // Convert BigInt values to regular numbers and process gathering assignments
    const processedIndividuals = individuals.map(individual => ({
      id: Number(individual.id),
      firstName: individual.first_name,
      lastName: individual.last_name,
      familyId: individual.family_id ? Number(individual.family_id) : null,
      familyName: individual.family_name,
      isActive: Boolean(individual.is_active),
      createdAt: individual.created_at,
      gatheringAssignments: individual.gathering_ids ? 
        individual.gathering_ids.split(',').map((id, index) => ({
          id: Number(id),
          name: individual.gathering_names.split(',')[index]
        })) : [],
      nameCount: Number(individual.name_count)
    }));
    
    // Group by name for easier review
    const duplicateGroups = [];
    const nameMap = new Map();
    processedIndividuals.forEach(person => {
      const key = `${person.firstName.toLowerCase()} ${person.lastName.toLowerCase()}`;
      if (!nameMap.has(key)) {
        nameMap.set(key, []);
      }
      nameMap.get(key).push(person);
    });
    
    for (const [name, group] of nameMap.entries()) {
      if (group.length > 1) {
        duplicateGroups.push({
          name: name,
          count: group.length,
          entries: group
        });
      }
    }
    
    res.json({ duplicateGroups });
  } catch (error) {
    console.error('Get duplicates error:', error);
    res.status(500).json({ error: 'Failed to retrieve duplicates.' });
  }
});

// Deduplicate individuals (Admin only)
router.post('/deduplicate', requireRole(['admin']), async (req, res) => {
  try {
    const { keepId, deleteIds, mergeAssignments } = req.body;
    
    if (!keepId || !deleteIds || !Array.isArray(deleteIds)) {
      return res.status(400).json({ error: 'Invalid request. Must provide keepId and deleteIds array.' });
    }
    
    // Start a transaction
    await Database.transaction(async (conn) => {
      // If merging assignments, move assignments from deleted IDs to kept ID
      if (mergeAssignments) {
        for (const deleteId of deleteIds) {
          // Get assignments from the duplicate to be deleted
          const assignments = await conn.query(`
            SELECT gathering_type_id
            FROM gathering_lists
            WHERE individual_id = ?
          `, [deleteId]);
          
          // Add assignments to the kept individual (if not already assigned)
          for (const assignment of assignments) {
            await conn.query(`
              INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
              VALUES (?, ?, ?)
              ON DUPLICATE KEY UPDATE added_by = VALUES(added_by)
            `, [assignment.gathering_type_id, keepId, req.user.id]);
          }
        }
      }
      
      // Soft delete the duplicate individuals
      await conn.query(`
        UPDATE individuals
        SET is_active = false, updated_at = NOW()
        WHERE id IN (?)
      `, [deleteIds]);
    });
    
    res.json({ message: 'Deduplication successful', keptId: keepId, deletedIds: deleteIds });
  } catch (error) {
    console.error('Deduplicate individuals error:', error);
    res.status(500).json({ error: 'Failed to deduplicate individuals.' });
  }
});

// Get all individuals with their family and gathering assignments
router.get('/', async (req, res) => {
  try {
    // Check if is_visitor column exists
    await requireIsVisitorColumn();
    
    const individuals = await Database.query(`
      SELECT 
        i.id,
        i.first_name,
        i.last_name,
        i.family_id,
        f.family_name,
        f.family_identifier,
        i.is_active,
        i.is_visitor,
        i.created_at,
        GROUP_CONCAT(DISTINCT gt.id) as gathering_ids,
        GROUP_CONCAT(DISTINCT gt.name) as gathering_names
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      LEFT JOIN gathering_types gt ON gl.gathering_type_id = gt.id
      WHERE i.is_active = true
      GROUP BY i.id
      ORDER BY i.last_name, i.first_name
    `);
    
    // Process gathering assignments and use systematic conversion utility
    const processedIndividuals = individuals.map(individual => ({
      ...individual,
      isActive: Boolean(individual.is_active),
      isVisitor: Boolean(individual.is_visitor),
      gatheringAssignments: individual.gathering_ids ? 
        individual.gathering_ids.split(',').map((id, index) => ({
          id: Number(id),
          name: individual.gathering_names.split(',')[index]
        })) : []
    }));
    
    const responseData = processApiResponse({ people: processedIndividuals });
    res.json(responseData);
  } catch (error) {
    console.error('Get individuals error:', error);
    res.status(500).json({ error: 'Failed to retrieve individuals.' });
  }
});

// Create individual (Admin/Coordinator)
router.post('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { firstName, lastName, familyId } = req.body;
    
    const result = await Database.query(`
      INSERT INTO individuals (first_name, last_name, family_id, created_by)
      VALUES (?, ?, ?, ?)
    `, [firstName, lastName, familyId || null, req.user.id]);

    res.status(201).json({ 
      message: 'Individual created successfully',
      id: Number(result.insertId)
    });
  } catch (error) {
    console.error('Create individual error:', error);
    res.status(500).json({ error: 'Failed to create individual.' });
  }
});

// Update individual (Admin/Coordinator)
router.put('/:id', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, familyId } = req.body;
    
    const result = await Database.query(`
      UPDATE individuals 
      SET first_name = ?, last_name = ?, family_id = ?, updated_at = NOW()
      WHERE id = ?
    `, [firstName, lastName, familyId || null, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Individual not found' });
    }

    res.json({ 
      message: 'Individual updated successfully',
      id: Number(id)
    });
  } catch (error) {
    console.error('Update individual error:', error);
    res.status(500).json({ error: 'Failed to update individual.' });
  }
});

// Delete individual (Admin/Coordinator) - Soft delete by setting is_active = false
router.delete('/:id', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await Database.query(`
      UPDATE individuals 
      SET is_active = false, updated_at = NOW()
      WHERE id = ?
    `, [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Individual not found' });
    }

    res.json({ 
      message: 'Individual deleted successfully',
      id: Number(id)
    });
  } catch (error) {
    console.error('Delete individual error:', error);
    res.status(500).json({ error: 'Failed to delete individual.' });
  }
});

// Assign individual to gathering (Admin/Coordinator)
router.post('/:id/gatherings/:gatheringId', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id, gatheringId } = req.params;
    
    // Check if assignment already exists
    const existingAssignment = await Database.query(
      'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
      [gatheringId, id]
    );
    
    if (existingAssignment.length > 0) {
      // Update the existing assignment
      await Database.query(`
        UPDATE gathering_lists 
        SET added_by = ?, added_at = NOW()
        WHERE gathering_type_id = ? AND individual_id = ?
      `, [req.user.id, gatheringId, id]);
      
      res.json({ 
        message: 'Individual assignment updated successfully'
      });
    } else {
      // Create new assignment
      await Database.query(`
        INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
        VALUES (?, ?, ?)
      `, [gatheringId, id, req.user.id]);
      
      res.json({ 
        message: 'Individual assigned to gathering successfully'
      });
    }
  } catch (error) {
    console.error('Assign individual to gathering error:', error);
    res.status(500).json({ error: 'Failed to assign individual to gathering.' });
  }
});

// Unassign individual from gathering (Admin/Coordinator)
router.delete('/:id/gatherings/:gatheringId', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id, gatheringId } = req.params;
    
    // Check if assignment exists
    const existingAssignment = await Database.query(
      'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
      [gatheringId, id]
    );
    
    if (existingAssignment.length === 0) {
      // Assignment doesn't exist, but that's okay - consider it already unassigned
      res.json({ 
        message: 'Individual was not assigned to this gathering'
      });
    } else {
      // Delete the assignment
      await Database.query(`
        DELETE FROM gathering_lists 
        WHERE gathering_type_id = ? AND individual_id = ?
      `, [gatheringId, id]);

      res.json({ 
        message: 'Individual unassigned from gathering successfully'
      });
    }
  } catch (error) {
    console.error('Unassign individual from gathering error:', error);
    res.status(500).json({ error: 'Failed to unassign individual from gathering.' });
  }
});

module.exports = router; 