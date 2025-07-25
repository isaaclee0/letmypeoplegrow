const express = require('express');
const { body, validationResult } = require('express-validator');
const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');
const { getChurchCountry, validatePhoneNumber, getInternationalFormat } = require('../utils/sms');

const router = express.Router();

// All routes require authentication
router.use(verifyToken);

// Get all users (Admin only)
router.get('/', requireRole(['admin']), async (req, res) => {
  try {
    const users = await Database.query(`
      SELECT id, email, role, first_name, last_name, is_active, 
             email_notifications, email_frequency, created_at
      FROM users 
      ORDER BY last_name, first_name
    `);
    
    // Convert BigInt values to regular numbers to avoid JSON serialization issues
    const processedUsers = users.map(user => ({
      ...user,
      id: Number(user.id)
    }));
    
    res.json({ users: processedUsers });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to retrieve users.' });
  }
});

// Create new user (Admin only)
router.post('/', 
  requireRole(['admin']),
  auditLog('CREATE_USER'),
  [
    body('email')
      .optional()
      .isEmail()
      .normalizeEmail()
      .withMessage('Please provide a valid email address'),
    body('mobileNumber')
      .optional()
      .custom(async (value) => {
        if (value) {
          const countryCode = await getChurchCountry();
          if (!validatePhoneNumber(value, countryCode)) {
            throw new Error(`Please provide a valid phone number for ${countryCode}`);
          }
        }
        return true;
      }),
    body('primaryContactMethod')
      .isIn(['email', 'sms'])
      .withMessage('Primary contact method must be email or sms'),
    body('role')
      .isIn(['admin', 'coordinator', 'attendance_taker'])
      .withMessage('Invalid role'),
    body('firstName')
      .trim()
      .isLength({ min: 1 })
      .withMessage('First name is required'),
    body('lastName')
      .trim()
      .isLength({ min: 1 })
      .withMessage('Last name is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, mobileNumber, primaryContactMethod, role, firstName, lastName } = req.body;

      // Validate that at least one contact method is provided
      if (!email && !mobileNumber) {
        return res.status(400).json({ error: 'Either email or mobile number must be provided' });
      }

      // Validate that primary contact method matches available contact info
      if (primaryContactMethod === 'email' && !email) {
        return res.status(400).json({ error: 'Email is required when primary contact method is email' });
      }
      if (primaryContactMethod === 'sms' && !mobileNumber) {
        return res.status(400).json({ error: 'Mobile number is required when primary contact method is SMS' });
      }

      // Normalize mobile number if provided
      let normalizedMobile = null;
      if (mobileNumber) {
        const countryCode = await getChurchCountry();
        normalizedMobile = getInternationalFormat(mobileNumber, countryCode);
        
        if (!normalizedMobile) {
          return res.status(400).json({ 
            error: `Invalid mobile number format for ${countryCode}` 
          });
        }
      }

      // Check for duplicate email or mobile number
      const duplicateChecks = [];
      if (email) {
        duplicateChecks.push(
          Database.query('SELECT id FROM users WHERE email = ?', [email])
        );
      }
      if (normalizedMobile) {
        duplicateChecks.push(
          Database.query('SELECT id FROM users WHERE mobile_number = ?', [normalizedMobile])
        );
      }

      const duplicateResults = await Promise.all(duplicateChecks);
      if (duplicateResults.some(result => result.length > 0)) {
        return res.status(409).json({ error: 'Email or mobile number already exists' });
      }

      const result = await Database.query(`
        INSERT INTO users (email, mobile_number, primary_contact_method, role, first_name, last_name)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [email || null, normalizedMobile, primaryContactMethod, role, firstName, lastName]);

      res.status(201).json({ 
        message: 'User created successfully',
        userId: result.insertId,
        user: {
          id: result.insertId,
          email: email || null,
          mobileNumber: normalizedMobile,
          primaryContactMethod: primaryContactMethod,
          role: role,
          firstName: firstName,
          lastName: lastName
        }
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'Email or mobile number already exists.' });
      }
      console.error('Create user error:', error);
      res.status(500).json({ error: 'Failed to create user.' });
    }
  }
);

// Update user (Admin only)
router.put('/:id', 
  requireRole(['admin']),
  auditLog('UPDATE_USER'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { role, firstName, lastName, isActive, emailNotifications, emailFrequency } = req.body;

      await Database.query(`
        UPDATE users SET 
          role = ?, first_name = ?, last_name = ?, is_active = ?,
          email_notifications = ?, email_frequency = ?, updated_at = NOW()
        WHERE id = ?
      `, [role, firstName, lastName, isActive, emailNotifications, emailFrequency, id]);

      res.json({ message: 'User updated successfully' });
    } catch (error) {
      console.error('Update user error:', error);
      res.status(500).json({ error: 'Failed to update user.' });
    }
  }
);

// Assign user to gatherings (Admin only)
router.post('/:userId/gatherings', 
  requireRole(['admin']),
  auditLog('ASSIGN_USER_GATHERINGS'),
  [
    body('gatheringIds')
      .isArray({ min: 1 })
      .withMessage('At least one gathering ID is required'),
    body('gatheringIds.*')
      .isInt()
      .withMessage('All gathering IDs must be valid integers')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { userId } = req.params;
      const { gatheringIds } = req.body;

      // Verify user exists
      const users = await Database.query(
        'SELECT id, email, first_name, last_name FROM users WHERE id = ?',
        [userId]
      );

      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = users[0];

      // Verify all gatherings exist
      const gatherings = await Database.query(
        'SELECT id, name FROM gathering_types WHERE id IN (?) AND is_active = true',
        [gatheringIds]
      );

      if (gatherings.length !== gatheringIds.length) {
        return res.status(400).json({ error: 'One or more gatherings not found or inactive' });
      }

      // Remove existing assignments for this user
      await Database.query(
        'DELETE FROM user_gathering_assignments WHERE user_id = ?',
        [userId]
      );

      // Add new assignments
      for (const gatheringId of gatheringIds) {
        await Database.query(`
          INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by)
          VALUES (?, ?, ?)
        `, [userId, gatheringId, req.user.id]);
      }

      // Mark first login as completed if user now has assignments
      await Database.query(
        'UPDATE users SET first_login_completed = true WHERE id = ?',
        [userId]
      );

      res.json({ 
        message: `User ${user.first_name} ${user.lastName} assigned to ${gatherings.length} gathering(s)`,
        assignedGatherings: gatherings.map(g => ({ id: g.id, name: g.name }))
      });

    } catch (error) {
      console.error('Assign user to gatherings error:', error);
      res.status(500).json({ error: 'Failed to assign user to gatherings' });
    }
  }
);

// Get user's gathering assignments (Admin only)
router.get('/:userId/gatherings', 
  requireRole(['admin']),
  async (req, res) => {
    try {
      const { userId } = req.params;

      // Verify user exists
      const users = await Database.query(
        'SELECT id, email, first_name, last_name FROM users WHERE id = ?',
        [userId]
      );

      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Get user's current assignments
      const assignments = await Database.query(`
        SELECT gt.id, gt.name, gt.description, uga.assigned_at
        FROM user_gathering_assignments uga
        JOIN gathering_types gt ON uga.gathering_type_id = gt.id
        WHERE uga.user_id = ? AND gt.is_active = true
        ORDER BY gt.name
      `, [userId]);

      // Get all available gatherings for assignment
      const allGatherings = await Database.query(`
        SELECT id, name, description
        FROM gathering_types 
        WHERE is_active = true
        ORDER BY name
      `);

      res.json({
        user: users[0],
        currentAssignments: assignments,
        availableGatherings: allGatherings
      });

    } catch (error) {
      console.error('Get user gathering assignments error:', error);
      res.status(500).json({ error: 'Failed to get user gathering assignments' });
    }
  }
);

module.exports = router; 