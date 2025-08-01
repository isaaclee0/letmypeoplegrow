const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireGatheringAccess } = require('../middleware/auth');
const { requireIsVisitorColumn, requireLastAttendedColumn } = require('../utils/databaseSchema');
const { processApiResponse } = require('../utils/caseConverter');

const router = express.Router();
router.use(verifyToken);

// Get attendance for a specific date and gathering
router.get('/:gatheringTypeId/:date', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    
    // Get attendance session
    const sessions = await Database.query(`
      SELECT id FROM attendance_sessions 
      WHERE gathering_type_id = ? AND session_date = ?
    `, [gatheringTypeId, date]);

    let sessionId = null;
    let visitors = [];

    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      
      // Get visitors for this session with family information
      visitors = await Database.query(`
        SELECT v.id, v.name, v.visitor_type, v.visitor_family_group, v.notes, v.last_attended,
               f.family_name, f.id as family_id
        FROM visitors v
        LEFT JOIN individuals i ON i.first_name = SUBSTRING_INDEX(v.name, ' ', 1) 
          AND i.last_name = SUBSTRING(v.name, LENGTH(SUBSTRING_INDEX(v.name, ' ', 1)) + 2)
          AND i.is_visitor = true
        LEFT JOIN families f ON i.family_id = f.id
        WHERE v.session_id = ?
        ORDER BY v.name
      `, [sessionId]);
    }

    // Get regular attendees with attendance status (always return the list)
    const attendanceList = await Database.query(`
      SELECT i.id, i.first_name, i.last_name, f.family_name, f.id as family_id,
             COALESCE(ar.present, false) as present
      FROM gathering_lists gl
      JOIN individuals i ON gl.individual_id = i.id
      LEFT JOIN families f ON i.family_id = f.id
      LEFT JOIN attendance_records ar ON ar.individual_id = i.id AND ar.session_id = ?
      WHERE gl.gathering_type_id = ? 
        AND i.is_active = true 
        AND (i.is_visitor = false OR i.is_visitor IS NULL)
      ORDER BY i.last_name, i.first_name
    `, [sessionId, gatheringTypeId]);

    // Use systematic conversion utility to handle BigInt and snake_case to camelCase conversion
    const responseData = processApiResponse({
      attendanceList: attendanceList.map(attendee => ({
        ...attendee,
        present: attendee.present === 1 || attendee.present === true
      })),
      visitors
    });

    res.json(responseData);
  } catch (error) {
    console.error('Get attendance error:', error);
    res.status(500).json({ error: 'Failed to retrieve attendance.' });
  }
});

// Record attendance
router.post('/:gatheringTypeId/:date', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { attendanceRecords, visitors } = req.body;

    console.log('Recording attendance:', { gatheringTypeId, date, attendanceRecords, visitors });

    await Database.transaction(async (conn) => {
      // Create or get attendance session
      let sessionResult = await conn.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE updated_at = NOW()
      `, [gatheringTypeId, date, req.user.id]);

      console.log('Session result:', sessionResult);

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = Number(sessionResult.insertId);
      } else {
        // If no insertId, the session already exists, so get its ID
        const sessions = await conn.query(
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
          [gatheringTypeId, date]
        );
        if (sessions.length === 0) {
          throw new Error('Failed to create or retrieve attendance session');
        }
        sessionId = Number(sessions[0].id);
      }

      console.log('Session ID:', sessionId);

      // Update individual attendance records with better concurrency handling
      if (attendanceRecords && attendanceRecords.length > 0) {
        for (const record of attendanceRecords) {
          // Use REPLACE INTO to handle concurrent updates more reliably
          await conn.query(`
            REPLACE INTO attendance_records (session_id, individual_id, present)
            VALUES (?, ?, ?)
          `, [sessionId, record.individualId, record.present]);
        }
        console.log('Updated attendance records for session:', sessionId);
      } else {
        console.log('No attendance records to update');
      }

      // CRITICAL FIX: Do NOT manage visitors in the regular attendance endpoint
      // Visitors should only be managed through dedicated visitor endpoints:
      // - POST /:gatheringTypeId/:date/visitors (add visitors)
      // - PUT /:gatheringTypeId/:date/visitors/:visitorId (update visitors)
      // This prevents accidental deletion of visitors when updating regular attendance
      
      console.log('Regular attendance update - preserving existing visitors');
    });

    // Trigger notifications (moved outside transaction to avoid scope issues)
    try {
      const { triggerAttendanceNotifications } = require('../utils/attendanceNotifications');
      await triggerAttendanceNotifications(gatheringTypeId, date);
    } catch (notificationError) {
      console.error('Error triggering notifications:', notificationError);
      // Don't fail the attendance save if notifications fail
    }

    res.json({ message: 'Attendance recorded successfully' });
  } catch (error) {
    console.error('Record attendance error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to record attendance.', details: error.message });
  }
});

// Get recent visitors (for suggestions)
router.get('/:gatheringTypeId/visitors/recent', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId } = req.params;
    
    // Check if last_attended column exists
    await requireLastAttendedColumn();
    
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
    
    // Get visitors who attended in the last 2 months
    const recentVisitors = await Database.query(`
      SELECT DISTINCT v.name, v.visitor_type, v.visitor_family_group, v.notes, v.last_attended
      FROM visitors v
      JOIN attendance_sessions s ON v.session_id = s.id
      WHERE s.gathering_type_id = ? 
        AND v.last_attended >= ?
      ORDER BY v.last_attended DESC, v.name
    `, [gatheringTypeId, twoMonthsAgo.toISOString().split('T')[0]]);

    const processedVisitors = recentVisitors.map(visitor => ({
      name: visitor.name,
      visitorType: visitor.visitor_type,
      visitorFamilyGroup: visitor.visitor_family_group,
      notes: visitor.notes,
      lastAttended: visitor.last_attended
    }));

    res.json({ visitors: processedVisitors });
  } catch (error) {
    console.error('Get recent visitors error:', error);
    res.status(500).json({ error: 'Failed to retrieve recent visitors.' });
  }
});

// Add visitor to a session and create individual
router.post('/:gatheringTypeId/:date/visitors', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { name, visitorType, visitorFamilyGroup, familyName, notes, people } = req.body;

    if ((!name || !name.trim()) && (!people || people.length === 0)) {
      return res.status(400).json({ error: 'Visitor information is required' });
    }

    // Check if is_visitor column exists
    await requireIsVisitorColumn();

    await Database.transaction(async (conn) => {
      // Get or create attendance session
      let sessionResult = await conn.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE created_by = VALUES(created_by), updated_at = NOW()
      `, [gatheringTypeId, date, req.user.id]);

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = Number(sessionResult.insertId);
      } else {
        const sessions = await conn.query(
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
          [gatheringTypeId, date]
        );
        sessionId = Number(sessions[0].id);
      }

      // Prepare people to create
      let peopleToCreate = [];
      if (people && people.length > 0) {
        peopleToCreate = people;
      } else {
        // Fallback to parsing name
        const nameParts = name.trim().split(' & ');
        for (const namePart of nameParts) {
          const personParts = namePart.trim().split(' ');
          const firstName = personParts[0] || 'Unknown';
          const lastName = personParts.slice(1).join(' ') || 'Unknown';
          peopleToCreate.push({ firstName, lastName, isChild: false });
        }
      }

      // Create family if multiple people or if family name is provided
      let familyId = null;
      let familyLastName = 'Unknown';
      if (peopleToCreate.length > 1 || familyName) {
        // Use provided family name if available, otherwise generate one
        let finalFamilyName = familyName;
        
        if (!finalFamilyName) {
          // Find a known last name, preferring non-children
          for (const person of peopleToCreate) {
            if (!person.isChild && person.lastName && person.lastName !== 'Unknown') {
              familyLastName = person.lastName;
              break;
            }
          }
          if (familyLastName === 'Unknown') {
            for (const person of peopleToCreate) {
              if (person.lastName && person.lastName !== 'Unknown') {
                familyLastName = person.lastName;
                break;
              }
            }
          }

          const mainFirstName = peopleToCreate[0].firstName !== 'Unknown' ? peopleToCreate[0].firstName : 'Visitor';
          finalFamilyName = `${mainFirstName} ${familyLastName} Family`;
        }

        const familyResult = await conn.query(`
          INSERT INTO families (family_name, created_by)
          VALUES (?, ?)
        `, [finalFamilyName, req.user.id]);
        familyId = Number(familyResult.insertId);
      }

      // Process and create individuals
      const createdIndividuals = [];
      let childCount = 0;
      for (let i = 0; i < peopleToCreate.length; i++) {
        let { firstName, lastName, firstUnknown = false, lastUnknown = false, isChild = false } = peopleToCreate[i];

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
          lastName = familyId && familyLastName ? familyLastName : 'Unknown';
        } else {
          lastName = lastName.trim() || 'Unknown';
        }

        // Check if individual already exists (only match visitors)
        const existingIndividual = await conn.query(`
          SELECT id FROM individuals 
          WHERE LOWER(first_name) = LOWER(?) 
            AND LOWER(last_name) = LOWER(?) 
            AND is_visitor = true
        `, [firstName, lastName]);

        let individualId;
        if (existingIndividual.length === 0) {
          // Create new individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, is_visitor, created_by)
            VALUES (?, ?, ?, true, ?)
          `, [firstName, lastName, familyId, req.user.id]);

          individualId = Number(individualResult.insertId);
        } else {
          // Use existing
          individualId = Number(existingIndividual[0].id);
          
          // Update family_id if creating a new family
          if (familyId) {
            await conn.query(`
              UPDATE individuals 
              SET family_id = ? 
              WHERE id = ?
            `, [familyId, individualId]);
          }
        }

        // Visitors should not be added to gathering_lists or attendance_records
        // They are tracked separately in the visitors table

        createdIndividuals.push({
          id: individualId,
          firstName,
          lastName
        });
      }

      // Compute full name for visitors table
      const fullName = createdIndividuals.map(ind => `${ind.firstName} ${ind.lastName}`).join(' & ');

      // Generate a single family group ID for all family members
      const familyGroupId = peopleToCreate.length > 1 ? visitorFamilyGroup || `family_${sessionId}_${Date.now()}` : null;

      // Add to visitors table - Create separate records for each person instead of one combined record
      const visitorIds = [];
      for (const individual of createdIndividuals) {
        const visitorResult = await conn.query(`
          INSERT INTO visitors (session_id, name, visitor_type, visitor_family_group, notes, last_attended)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          sessionId, 
          `${individual.firstName} ${individual.lastName}`, // Individual name, not combined
          visitorType || 'temporary_other', 
          familyGroupId, // Use the same family group ID for all members
          notes || null, 
          date
        ]);
        visitorIds.push(Number(visitorResult.insertId));
      }

      res.json({ 
        message: 'Visitor(s) added successfully',
        visitorIds: visitorIds,
        individuals: createdIndividuals
      });
    });
  } catch (error) {
    console.error('Add visitor error:', error);
    res.status(500).json({ error: 'Failed to add visitor.' });
  }
});

// Update visitor
router.put('/:gatheringTypeId/:date/visitors/:visitorId', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date, visitorId } = req.params;
    const { people, visitorType, familyName, notes } = req.body;

    if (!people || people.length === 0) {
      return res.status(400).json({ error: 'Visitor information is required' });
    }

    // Check if is_visitor column exists
    await requireIsVisitorColumn();

    await Database.transaction(async (conn) => {
      // Get or create attendance session
      let sessionResult = await conn.query(`
        INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE created_by = VALUES(created_by), updated_at = NOW()
      `, [gatheringTypeId, date, req.user.id]);

      let sessionId;
      if (sessionResult.insertId) {
        sessionId = Number(sessionResult.insertId);
      } else {
        const sessions = await conn.query(
          'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
          [gatheringTypeId, date]
        );
        sessionId = Number(sessions[0].id);
      }

      // Get the existing visitor and their family group
      const existingVisitor = await conn.query(`
        SELECT id, name, visitor_family_group FROM visitors WHERE id = ? AND session_id = ?
      `, [visitorId, sessionId]);

      if (existingVisitor.length === 0) {
        return res.status(404).json({ error: 'Visitor not found' });
      }

      const existingFamilyGroup = existingVisitor[0].visitor_family_group;

      // Delete ALL visitors in the same family group (or just the individual if no family group)
      if (existingFamilyGroup) {
        await conn.query(`
          DELETE FROM visitors WHERE session_id = ? AND visitor_family_group = ?
        `, [sessionId, existingFamilyGroup]);
      } else {
        await conn.query(`
          DELETE FROM visitors WHERE id = ?
        `, [visitorId]);
      }

      // Process each person in the people array
      const createdIndividuals = [];
      let familyId = null;
      let familyLastName = null;
      let childCount = 0;

      // Create family if multiple people or if family name is provided
      if (people.length > 1 || familyName) {
        // Use provided family name if available, otherwise generate one
        let finalFamilyName = familyName;
        
        if (!finalFamilyName) {
          const mainPerson = people.find(p => !p.isChild);
          if (mainPerson && !mainPerson.lastUnknown) {
            familyLastName = mainPerson.lastName.toUpperCase();
            finalFamilyName = `${familyLastName}, ${people.map(p => p.firstName).join(' & ')}`;
          }
        }
        
        if (finalFamilyName) {
          const familyResult = await conn.query(`
            INSERT INTO families (family_name, created_by) VALUES (?, ?)
          `, [finalFamilyName, req.user.id]);
          
          familyId = Number(familyResult.insertId);
        }
      }

      for (const person of people) {
        let { firstName, lastName, firstUnknown, lastUnknown, isChild } = person;

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
          if (isChild) {
            // For children, use family last name if available, otherwise use parent's last name
            lastName = familyId && familyLastName ? familyLastName : 'Unknown';
          } else {
            lastName = familyId && familyLastName ? familyLastName : 'Unknown';
          }
        } else {
          lastName = lastName.trim() || 'Unknown';
        }

        // Update existing individual or create new one
        const existingIndividual = await conn.query(`
          SELECT id FROM individuals 
          WHERE LOWER(first_name) = LOWER(?) 
            AND LOWER(last_name) = LOWER(?) 
            AND is_visitor = true
        `, [firstName, lastName]);

        let individualId;
        if (existingIndividual.length === 0) {
          // Create new individual
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, is_visitor, created_by)
            VALUES (?, ?, ?, true, ?)
          `, [firstName, lastName, familyId, req.user.id]);

          individualId = Number(individualResult.insertId);
        } else {
          // Use existing and update family_id if needed
          individualId = Number(existingIndividual[0].id);
          if (familyId) {
            await conn.query(`
              UPDATE individuals 
              SET family_id = ? 
              WHERE id = ?
            `, [familyId, individualId]);
          }
        }

        // Visitors should not be added to gathering_lists or attendance_records
        // They are tracked separately in the visitors table

        createdIndividuals.push({
          id: individualId,
          firstName,
          lastName
        });
      }

      // Compute full name for visitors table
      const fullName = createdIndividuals.map(ind => `${ind.firstName} ${ind.lastName}`).join(' & ');

      // Generate a single family group ID for all family members
      const familyGroupId = createdIndividuals.length > 1 ? existingFamilyGroup || `family_${sessionId}_${Date.now()}` : null;

      // Add updated visitor to visitors table - Create separate records for each person
      const visitorIds = [];
      for (const individual of createdIndividuals) {
        const visitorResult = await conn.query(`
          INSERT INTO visitors (session_id, name, visitor_type, visitor_family_group, notes, last_attended)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          sessionId, 
          `${individual.firstName} ${individual.lastName}`, // Individual name, not combined
          visitorType || 'temporary_other', 
          familyGroupId, // Use the same family group ID for all members
          notes || null, 
          date
        ]);
        visitorIds.push(Number(visitorResult.insertId));
      }

      res.json({ 
        message: 'Visitor updated successfully',
        visitorIds: visitorIds,
        individuals: createdIndividuals
      });
    });
  } catch (error) {
    console.error('Update visitor error:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({ error: 'Failed to update visitor.', details: error.message });
  }
});

// Add regular attendee to a gathering from attendance page
router.post('/:gatheringTypeId/:date/regulars', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date } = req.params;
    const { people } = req.body;

    if (!people || people.length === 0) {
      return res.status(400).json({ error: 'People information is required' });
    }

    // Check if is_visitor column exists
    await requireIsVisitorColumn();

    await Database.transaction(async (conn) => {
      // Create family if multiple people
      let familyId = null;
      let familyLastName = 'Unknown';
      let childCount = 0;
      const createdIndividuals = [];

      if (people.length > 1) {
        const mainPerson = people.find(p => !p.isChild);
        if (mainPerson && !mainPerson.lastUnknown) {
          familyLastName = mainPerson.lastName.toUpperCase();
          const familyName = `${familyLastName}, ${people.map(p => p.firstName).join(' & ')}`;
          
          const familyResult = await conn.query(`
            INSERT INTO families (family_name) VALUES (?)
          `, [familyName]);
          
          familyId = Number(familyResult.insertId);
        }
      }

      for (const person of people) {
        let { firstName, lastName, firstUnknown, lastUnknown, isChild } = person;

        // Handle unknown first name
        if (firstUnknown || !firstName.trim()) {
          if (isChild) {
            childCount++;
            firstName = `Child ${childCount}`;
          } else {
            firstName = 'Unknown';
          }
        } else {
          firstName = firstName.trim();
        }

        // Handle unknown last name
        if (lastUnknown || !lastName || !lastName.trim()) {
          lastName = familyId ? familyLastName : 'Unknown';
        } else {
          lastName = lastName.trim();
        }

        // Check if individual already exists (only match non-visitors)
        const existingIndividual = await conn.query(`
          SELECT id FROM individuals 
          WHERE LOWER(first_name) = LOWER(?) 
            AND LOWER(last_name) = LOWER(?) 
            AND (is_visitor = false OR is_visitor IS NULL)
            AND is_active = true
        `, [firstName, lastName]);

        let individualId;
        if (existingIndividual.length === 0) {
          // Create new individual as regular (not visitor)
          const individualResult = await conn.query(`
            INSERT INTO individuals (first_name, last_name, family_id, is_visitor, created_by)
            VALUES (?, ?, ?, false, ?)
          `, [firstName, lastName, familyId, req.user.id]);

          individualId = Number(individualResult.insertId);
        } else {
          // Use existing individual
          individualId = Number(existingIndividual[0].id);
          
          // Update family_id if creating a new family
          if (familyId) {
            await conn.query(`
              UPDATE individuals 
              SET family_id = ? 
              WHERE id = ?
            `, [familyId, individualId]);
          }
        }

        // Add to gathering list if not already there
        const existingAssignment = await conn.query(
          'SELECT id FROM gathering_lists WHERE gathering_type_id = ? AND individual_id = ?',
          [gatheringTypeId, individualId]
        );
        
        if (existingAssignment.length === 0) {
          await conn.query(`
            INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by)
            VALUES (?, ?, ?)
          `, [gatheringTypeId, individualId, req.user.id]);
        }

        createdIndividuals.push({
          id: individualId,
          firstName,
          lastName
        });
      }

      res.json({ 
        message: 'Regular attendee(s) added successfully',
        individuals: createdIndividuals
      });
    });
  } catch (error) {
    console.error('Add regular attendee error:', error);
    res.status(500).json({ error: 'Failed to add regular attendee.' });
  }
});

// Delete visitor(s)
router.delete('/:gatheringTypeId/:date/visitors/:visitorId', requireGatheringAccess, async (req, res) => {
  try {
    const { gatheringTypeId, date, visitorId } = req.params;
    const { deleteFamily } = req.query; // Optional query parameter to delete entire family

    await Database.transaction(async (conn) => {
      // Get or verify attendance session exists
      const sessions = await conn.query(
        'SELECT id FROM attendance_sessions WHERE gathering_type_id = ? AND session_date = ?',
        [gatheringTypeId, date]
      );

      if (sessions.length === 0) {
        return res.status(404).json({ error: 'Attendance session not found' });
      }

      const sessionId = Number(sessions[0].id);

      // Get the visitor to delete and their family group
      const visitor = await conn.query(`
        SELECT id, name, visitor_family_group FROM visitors 
        WHERE id = ? AND session_id = ?
      `, [visitorId, sessionId]);

      if (visitor.length === 0) {
        return res.status(404).json({ error: 'Visitor not found' });
      }

      const visitorData = visitor[0];
      const familyGroup = visitorData.visitor_family_group;

      let deletedCount = 0;
      let deletedNames = [];

      if (deleteFamily === 'true' && familyGroup) {
        // Delete entire family group
        const familyMembers = await conn.query(`
          SELECT name FROM visitors WHERE session_id = ? AND visitor_family_group = ?
        `, [sessionId, familyGroup]);

        deletedNames = familyMembers.map(member => member.name);

        const result = await conn.query(`
          DELETE FROM visitors WHERE session_id = ? AND visitor_family_group = ?
        `, [sessionId, familyGroup]);

        deletedCount = result.affectedRows;
      } else {
        // Delete only the specific visitor
        deletedNames = [visitorData.name];

        const result = await conn.query(`
          DELETE FROM visitors WHERE id = ?
        `, [visitorId]);

        deletedCount = result.affectedRows;
      }

      if (deletedCount === 0) {
        return res.status(404).json({ error: 'No visitors found to delete' });
      }

      const message = deleteFamily === 'true' && familyGroup 
        ? `Deleted visitor family: ${deletedNames.join(', ')}`
        : `Deleted visitor: ${deletedNames[0]}`;

      res.json({ 
        message,
        deletedCount,
        deletedNames
      });
    });
  } catch (error) {
    console.error('Delete visitor error:', error);
    res.status(500).json({ error: 'Failed to delete visitor.' });
  }
});

module.exports = router; 