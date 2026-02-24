const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');
const { ensureChurchIsolation } = require('../middleware/churchIsolation');
const { requireIsVisitorColumn } = require('../utils/databaseSchema');
const { processApiResponse } = require('../utils/caseConverter');

const router = express.Router();
router.use(verifyToken);
router.use(ensureChurchIsolation);

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
      WHERE i.is_active = true AND i.church_id = ?
      GROUP BY i.id, i.first_name, i.last_name
      HAVING name_count > 1
      ORDER BY LOWER(i.last_name), LOWER(i.first_name), i.created_at
    `, [req.user.church_id]);
    
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
router.post('/deduplicate', requireRole(['admin']), auditLog('DEDUPLICATE_INDIVIDUALS'), async (req, res) => {
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
            WHERE individual_id = ? AND church_id = ?
          `, [deleteId, req.user.church_id]);
          
          // Add assignments to the kept individual (if not already assigned)
          for (const assignment of assignments) {
            await conn.query(`
              INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
              VALUES (?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE added_by = VALUES(added_by)
            `, [assignment.gathering_type_id, keepId, req.user.id, req.user.church_id]);
          }
        }
      }
      
      // Permanently delete duplicate individuals (data preserved via merge)
      // Remove gathering assignments first to satisfy FK constraints
      await conn.query(`
        DELETE FROM gathering_lists WHERE individual_id IN (?) AND church_id = ?
      `, [deleteIds, req.user.church_id]);

      // Delete attendance records for these individuals within the same church scope, if column exists
      const hasArChurchId = await (async () => {
        try {
          const col = await conn.query("SHOW COLUMNS FROM attendance_records LIKE 'church_id'");
          return col && col.length > 0;
        } catch {
          return false;
        }
      })();
      if (hasArChurchId) {
        await conn.query(`
          DELETE FROM attendance_records WHERE individual_id IN (?) AND church_id = ?
        `, [deleteIds, req.user.church_id]);
      } else {
        await conn.query(`
          DELETE FROM attendance_records WHERE individual_id IN (?)
        `, [deleteIds]);
      }

      // Finally delete individuals
      await conn.query(`
        DELETE FROM individuals WHERE id IN (?) AND church_id = ?
      `, [deleteIds, req.user.church_id]);
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
    const individuals = await Database.query(`
      SELECT
        i.id,
        i.first_name,
        i.last_name,
        i.people_type,
        i.is_child,
        i.badge_text,
        i.badge_color,
        i.badge_icon,
        i.family_id,
        f.family_name,
        i.is_active,
        i.created_at,
        GROUP_CONCAT(DISTINCT gt.id) as gathering_ids,
        GROUP_CONCAT(DISTINCT gt.name) as gathering_names
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      LEFT JOIN gathering_types gt ON gl.gathering_type_id = gt.id
      WHERE i.is_active = true AND i.church_id = ?
      GROUP BY i.id
      ORDER BY i.last_name, i.first_name
    `, [req.user.church_id]);
    
    // Process gathering assignments and use systematic conversion utility
    const processedIndividuals = individuals.map(individual => ({
      ...individual,
      isActive: Boolean(individual.is_active),
      isChild: Boolean(individual.is_child),
      peopleType: individual.people_type,
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

// Get archived (inactive) individuals
router.get('/archived', async (req, res) => {
  try {
    const individuals = await Database.query(`
      SELECT
        i.id,
        i.first_name,
        i.last_name,
        i.people_type,
        i.is_child,
        i.badge_text,
        i.badge_color,
        i.badge_icon,
        i.family_id,
        f.family_name,
        i.is_active,
        i.created_at,
        GROUP_CONCAT(DISTINCT gt.id) as gathering_ids,
        GROUP_CONCAT(DISTINCT gt.name) as gathering_names
      FROM individuals i
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN gathering_lists gl ON i.id = gl.individual_id
      LEFT JOIN gathering_types gt ON gl.gathering_type_id = gt.id
      WHERE i.is_active = false AND i.church_id = ?
      GROUP BY i.id
      ORDER BY i.last_name, i.first_name
    `, [req.user.church_id]);

    const processedIndividuals = individuals.map(individual => ({
      ...individual,
      isActive: Boolean(individual.is_active),
      isChild: Boolean(individual.is_child),
      peopleType: individual.people_type,
      gatheringAssignments: individual.gathering_ids ? 
        individual.gathering_ids.split(',').map((id, index) => ({
          id: Number(id),
          name: individual.gathering_names.split(',')[index]
        })) : []
    }));

    const responseData = processApiResponse({ people: processedIndividuals });
    res.json(responseData);
  } catch (error) {
    console.error('Get archived individuals error:', error);
    res.status(500).json({ error: 'Failed to retrieve archived individuals.' });
  }
});

// Create individual (Admin/Coordinator)
router.post('/', requireRole(['admin', 'coordinator']), auditLog('CREATE_INDIVIDUAL'), async (req, res) => {
  try {
    const { firstName, lastName, familyId, isChild } = req.body;
    
    const result = await Database.query(`
      INSERT INTO individuals (first_name, last_name, family_id, is_child, created_by, church_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [firstName, lastName, familyId || null, isChild ? true : false, req.user.id, req.user.church_id]);

    res.status(201).json({ 
      message: 'Individual created successfully',
      id: Number(result.insertId)
    });
  } catch (error) {
    console.error('Create individual error:', error);
    res.status(500).json({ error: 'Failed to create individual.' });
  }
});

// Helper function to sync family_type when all members have the same people_type
async function syncFamilyTypeIfUnified(familyId, churchId) {
  if (!familyId) return;
  
  try {
    // Get all active family members' people_type
    const familyMembers = await Database.query(
      'SELECT DISTINCT people_type FROM individuals WHERE family_id = ? AND is_active = true AND church_id = ?',
      [familyId, churchId]
    );

    // If all family members have the same type, update family_type to match
    if (familyMembers.length === 1 && familyMembers[0].people_type) {
      await Database.query(
        'UPDATE families SET family_type = ?, updated_at = NOW() WHERE id = ? AND church_id = ?',
        [familyMembers[0].people_type, familyId, churchId]
      );
    }
  } catch (error) {
    console.error('Error syncing family type:', error);
    // Don't throw - this is a sync operation, shouldn't fail the main update
  }
}

// Update individual (Admin/Coordinator)
router.put('/:id', requireRole(['admin', 'coordinator']), auditLog('UPDATE_INDIVIDUAL'), async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, familyId, peopleType, isChild, badgeText, badgeColor, badgeIcon } = req.body;

    console.log(`Updating individual ${id} with:`, { firstName, lastName, familyId, peopleType, isChild, badgeText, badgeColor, badgeIcon });

    // Get current family_id before update (to sync old family if familyId is changing)
    const currentIndividual = await Database.query(
      'SELECT family_id FROM individuals WHERE id = ? AND church_id = ?',
      [id, req.user.church_id]
    );

    if (currentIndividual.length === 0) {
      return res.status(404).json({ error: 'Individual not found' });
    }

    const oldFamilyId = currentIndividual[0].family_id;
    const newFamilyId = familyId !== undefined ? familyId : oldFamilyId;

    // Build dynamic update - only include fields that are actually provided
    const fields = ['first_name = ?', 'last_name = ?'];
    const values = [firstName, lastName];

    // Only update familyId if it's explicitly provided (not undefined)
    if (familyId !== undefined) {
      fields.push('family_id = ?');
      values.push(familyId);
    }

    if (peopleType && ['regular', 'local_visitor', 'traveller_visitor'].includes(peopleType)) {
      fields.push('people_type = ?');
      values.push(peopleType);
    }

    if (isChild !== undefined) {
      fields.push('is_child = ?');
      values.push(isChild ? true : false);
    }

    if (badgeText !== undefined) {
      fields.push('badge_text = ?');
      // Keep null as null (use default), empty string as empty string (no text), value as value (custom)
      values.push(badgeText);
    }

    if (badgeColor !== undefined) {
      fields.push('badge_color = ?');
      values.push(badgeColor || null);
    }

    if (badgeIcon !== undefined) {
      fields.push('badge_icon = ?');
      values.push(badgeIcon || null);
    }

    values.push(id, req.user.church_id);

    console.log('SQL query:', `UPDATE individuals SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ? AND church_id = ?`);
    console.log('Values:', values);

    const result = await Database.query(
      `UPDATE individuals SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ? AND church_id = ?`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Individual not found' });
    }

    // Sync family_type for both old and new families if people_type was changed
    if (peopleType) {
      // Sync new family (if individual is in a family)
      if (newFamilyId) {
        await syncFamilyTypeIfUnified(newFamilyId, req.user.church_id);
      }
      
      // Sync old family if family_id changed (to update old family's type)
      if (oldFamilyId && oldFamilyId !== newFamilyId) {
        await syncFamilyTypeIfUnified(oldFamilyId, req.user.church_id);
      }
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
router.delete('/:id', requireRole(['admin', 'coordinator']), auditLog('DELETE_INDIVIDUAL'), async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await Database.query(`
      UPDATE individuals 
      SET is_active = false, updated_at = NOW()
      WHERE id = ? AND church_id = ?
    `, [id, req.user.church_id]);

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

// Permanently delete individual (Admin only)
router.delete('/:id/permanent', requireRole(['admin']), auditLog('PERMANENT_DELETE_INDIVIDUAL'), async (req, res) => {
  try {
    const { id } = req.params;

    await Database.transaction(async (conn) => {
      // Remove gathering assignments first to satisfy FK constraints
      await conn.query(
        `DELETE FROM gathering_lists WHERE individual_id = ? AND church_id = ?`,
        [id, req.user.church_id]
      );

      // Delete attendance records for this individual (church-scoped when available)
      const hasArChurchId = await (async () => {
        try {
          const col = await conn.query("SHOW COLUMNS FROM attendance_records LIKE 'church_id'");
          return col && col.length > 0;
        } catch {
          return false;
        }
      })();
      if (hasArChurchId) {
        await conn.query(
          `DELETE FROM attendance_records WHERE individual_id = ? AND church_id = ?`,
          [id, req.user.church_id]
        );
      } else {
        await conn.query(
          `DELETE FROM attendance_records WHERE individual_id = ?`,
          [id]
        );
      }

      // Finally delete the individual record
      const result = await conn.query(
        `DELETE FROM individuals WHERE id = ? AND church_id = ?`,
        [id, req.user.church_id]
      );

      if (result.affectedRows === 0) {
        throw Object.assign(new Error('Individual not found'), { statusCode: 404 });
      }
    });

    res.json({ 
      message: 'Individual permanently deleted',
      id: Number(id)
    });
  } catch (error) {
    if (error && error.statusCode === 404) {
      return res.status(404).json({ error: 'Individual not found' });
    }
    console.error('Permanent delete individual error:', error);
    res.status(500).json({ error: 'Failed to permanently delete individual.' });
  }
});

// Restore individual (set is_active = true)
router.post('/:id/restore', requireRole(['admin', 'coordinator']), auditLog('RESTORE_INDIVIDUAL'), async (req, res) => {
  try {
    const { id } = req.params;

    const result = await Database.query(`
      UPDATE individuals 
      SET is_active = true, updated_at = NOW()
      WHERE id = ? AND church_id = ?
    `, [id, req.user.church_id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Individual not found' });
    }

    res.json({ message: 'Individual restored successfully', id: Number(id) });
  } catch (error) {
    console.error('Restore individual error:', error);
    res.status(500).json({ error: 'Failed to restore individual.' });
  }
});

// Assign individual to gathering (Admin/Coordinator)
router.post('/:id/gatherings/:gatheringId', requireRole(['admin', 'coordinator']), auditLog('ASSIGN_INDIVIDUAL_TO_GATHERING'), async (req, res) => {
  try {
    const { id, gatheringId } = req.params;
    
    // Check if assignment already exists
    const existingAssignment = await Database.query(
      'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?',
      [gatheringId, id, req.user.church_id]
    );
    
    if (existingAssignment.length > 0) {
      // Update the existing assignment
      await Database.query(`
        UPDATE gathering_lists 
        SET added_by = ?, added_at = NOW()
        WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?
      `, [req.user.id, gatheringId, id, req.user.church_id]);
      
      res.json({ 
        message: 'Individual assignment updated successfully'
      });
    } else {
      // Create new assignment
      await Database.query(`
        INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
        VALUES (?, ?, ?, ?)
      `, [gatheringId, id, req.user.id, req.user.church_id]);
      
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
      'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?',
      [gatheringId, id, req.user.church_id]
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
        WHERE gathering_type_id = ? AND individual_id = ? AND church_id = ?
      `, [gatheringId, id, req.user.church_id]);

      res.json({ 
        message: 'Individual unassigned from gathering successfully'
      });
    }
  } catch (error) {
    console.error('Unassign individual from gathering error:', error);
    res.status(500).json({ error: 'Failed to unassign individual from gathering.' });
  }
});

// Get attendance history for a specific individual
router.get('/:id/attendance-history', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if individual exists and belongs to user's church
    const individual = await Database.query(
      'SELECT id, first_name, last_name, church_id FROM individuals WHERE id = ?',
      [id]
    );

    if (individual.length === 0) {
      return res.status(404).json({ error: 'Individual not found' });
    }

    if (individual[0].church_id !== req.user.church_id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get last attendance record (any service)
    const lastAttendance = await Database.query(`
      SELECT 
        ar.present,
        ar.updated_at,
        as_table.session_date,
        gt.name as gathering_name,
        gt.id as gathering_id
      FROM attendance_records ar
      JOIN attendance_sessions as_table ON ar.session_id = as_table.id
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      WHERE ar.individual_id = ? 
        AND ar.church_id = ?
        AND ar.present = true
      ORDER BY as_table.session_date DESC, ar.updated_at DESC
      LIMIT 1
    `, [id, req.user.church_id]);

    // Get attendance records for the last 12 months to calculate regularity
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const oneYearAgoStr = oneYearAgo.toISOString().split('T')[0];

    // Get attendance records for the last 12 months to calculate regularity per gathering
    const attendanceHistory = await Database.query(`
      SELECT 
        as_table.session_date,
        gt.name as gathering_name,
        gt.id as gathering_id,
        gt.frequency as gathering_frequency
      FROM attendance_records ar
      JOIN attendance_sessions as_table ON ar.session_id = as_table.id
      JOIN gathering_types gt ON as_table.gathering_type_id = gt.id
      WHERE ar.individual_id = ? 
        AND ar.church_id = ?
        AND ar.present = true
        AND as_table.session_date >= ?
      ORDER BY as_table.session_date ASC
    `, [id, req.user.church_id, oneYearAgoStr]);

    // Calculate regularity per gathering
    const gatheringRegularity = new Map();
    const gatheringAttendanceCounts = new Map();
    
    if (attendanceHistory.length > 0) {
      // Group attendance by gathering
      attendanceHistory.forEach(record => {
        const gatheringId = record.gathering_id;
        if (!gatheringAttendanceCounts.has(gatheringId)) {
          gatheringAttendanceCounts.set(gatheringId, {
            name: record.gathering_name,
            count: 0,
            dates: []
          });
        }
        const gathering = gatheringAttendanceCounts.get(gatheringId);
        gathering.count++;
        gathering.dates.push(record.session_date);
      });

      // Calculate regularity for each gathering
      gatheringAttendanceCounts.forEach((gathering, gatheringId) => {
        // Find the actual date range for this gathering's data
        const dates = gathering.dates.sort();
        const firstDate = new Date(dates[0]);
        const lastDate = new Date(dates[dates.length - 1]);
        
        // Calculate average per month based on actual data range
        const monthsDiff = (lastDate.getFullYear() - firstDate.getFullYear()) * 12 + 
                          (lastDate.getMonth() - firstDate.getMonth()) + 1;
        
        // Ensure we have at least 1 month of data
        const actualMonths = Math.max(monthsDiff, 1);
        const averagePerMonth = gathering.count / actualMonths;
        
        let regularity = 'less than once a month';
        if (averagePerMonth >= 3.5) {
          regularity = 'every week';
        } else if (averagePerMonth >= 2.5) {
          regularity = 'three times a month';
        } else if (averagePerMonth >= 1.5) {
          regularity = 'twice a month';
        } else if (averagePerMonth >= 0.5) {
          regularity = 'once a month';
        }
        
        gatheringRegularity.set(gatheringId, {
          name: gathering.name,
          regularity,
          attendanceCount: gathering.count
        });
      });
    }

    const response = {
      lastAttendance: lastAttendance.length > 0 ? {
        date: lastAttendance[0].session_date,
        gatheringName: lastAttendance[0].gathering_name,
        gatheringId: lastAttendance[0].gathering_id,
        recordedAt: lastAttendance[0].updated_at
      } : null,
      gatheringRegularity: Array.from(gatheringRegularity.values())
    };

    res.json(response);
  } catch (error) {
    console.error('Error getting attendance history:', error);
    res.status(500).json({ error: 'Failed to retrieve attendance history' });
  }
});

module.exports = router; 