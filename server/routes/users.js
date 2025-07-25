const express = require('express');
const { body, validationResult } = require('express-validator');
const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');
const { getChurchCountry, validatePhoneNumber, getInternationalFormat } = require('../utils/sms');

const router = express.Router();

// All routes require authentication
router.use(verifyToken);

// Get all users (Admin and Coordinators can see users they have access to)
router.get('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    let query = `
      SELECT u.id, u.email, u.mobile_number, u.primary_contact_method, u.role, 
             u.first_name, u.last_name, u.is_active, u.is_invited, u.first_login_completed,
             u.email_notifications, u.sms_notifications, u.notification_frequency, u.created_at,
             COUNT(DISTINCT uga.gathering_type_id) as gathering_count
      FROM users u
      LEFT JOIN user_gathering_assignments uga ON u.id = uga.user_id
    `;
    
    let params = [];

    // Coordinators can only see users they have access to (same gatherings)
    if (req.user.role === 'coordinator') {
      query += `
        WHERE u.id IN (
          SELECT DISTINCT uga2.user_id 
          FROM user_gathering_assignments uga2
          WHERE uga2.gathering_type_id IN (
            SELECT gathering_type_id 
            FROM user_gathering_assignments 
            WHERE user_id = ?
          )
        ) OR u.id = ?
      `;
      params.push(req.user.id, req.user.id);
    }

    query += `
      GROUP BY u.id
      ORDER BY u.last_name, u.first_name
    `;
    
    const users = await Database.query(query, params);
    
    // Convert BigInt values to regular numbers to avoid JSON serialization issues
    const processedUsers = users.map(user => ({
      ...user,
      id: Number(user.id),
      gatheringCount: Number(user.gathering_count)
    }));
    
    res.json({ users: processedUsers });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to retrieve users.' });
  }
});

// Get user details (Admin and Coordinators can see users they have access to)
router.get('/:id', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;

    // Check if coordinator has access to this user
    if (req.user.role === 'coordinator' && parseInt(id) !== req.user.id) {
      const hasAccess = await Database.query(`
        SELECT 1 FROM user_gathering_assignments uga1
        JOIN user_gathering_assignments uga2 ON uga1.gathering_type_id = uga2.gathering_type_id
        WHERE uga1.user_id = ? AND uga2.user_id = ?
        LIMIT 1
      `, [req.user.id, id]);

      if (hasAccess.length === 0) {
        return res.status(403).json({ error: 'Access denied to this user' });
      }
    }

    const users = await Database.query(`
      SELECT id, email, mobile_number, primary_contact_method, role, 
             first_name, last_name, is_active, is_invited, first_login_completed,
             email_notifications, sms_notifications, notification_frequency, 
             default_gathering_id, created_at, updated_at
      FROM users 
      WHERE id = ?
    `, [id]);

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = users[0];

    // Get user's gathering assignments
    const assignments = await Database.query(`
      SELECT gt.id, gt.name, gt.description, uga.assigned_at,
             u.first_name as assigned_by_first_name, u.last_name as assigned_by_last_name
      FROM user_gathering_assignments uga
      JOIN gathering_types gt ON uga.gathering_type_id = gt.id
      LEFT JOIN users u ON uga.assigned_by = u.id
      WHERE uga.user_id = ? AND gt.is_active = true
      ORDER BY gt.name
    `, [id]);

    res.json({
      user: {
        ...user,
        id: Number(user.id),
        defaultGatheringId: user.default_gathering_id ? Number(user.default_gathering_id) : null
      },
      gatheringAssignments: assignments
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to retrieve user.' });
  }
});

// Create new user (Admin and Coordinators can create users)
router.post('/', 
  requireRole(['admin', 'coordinator']),
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
      .isIn(['coordinator', 'attendance_taker'])
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

      // Coordinators cannot create admin users
      if (req.user.role === 'coordinator' && role === 'admin') {
        return res.status(403).json({ error: 'Coordinators cannot create admin users' });
      }

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
        INSERT INTO users (email, mobile_number, primary_contact_method, role, first_name, last_name, is_invited)
        VALUES (?, ?, ?, ?, ?, ?, true)
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
          lastName: lastName,
          isInvited: true
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

// Update user (Admin and Coordinators can update users they have access to)
router.put('/:id', 
  requireRole(['admin', 'coordinator']),
  auditLog('UPDATE_USER'),
  [
    body('role')
      .optional()
      .isIn(['admin', 'coordinator', 'attendance_taker'])
      .withMessage('Invalid role'),
    body('firstName')
      .optional()
      .trim()
      .isLength({ min: 1 })
      .withMessage('First name cannot be empty'),
    body('lastName')
      .optional()
      .trim()
      .isLength({ min: 1 })
      .withMessage('Last name cannot be empty'),
    body('isActive')
      .optional()
      .isBoolean()
      .withMessage('isActive must be a boolean'),
    body('emailNotifications')
      .optional()
      .isBoolean()
      .withMessage('emailNotifications must be a boolean'),
    body('smsNotifications')
      .optional()
      .isBoolean()
      .withMessage('smsNotifications must be a boolean'),
    body('notificationFrequency')
      .optional()
      .isIn(['instant', 'daily', 'weekly'])
      .withMessage('Invalid notification frequency')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { id } = req.params;
      const { role, firstName, lastName, isActive, emailNotifications, smsNotifications, notificationFrequency } = req.body;

      // Check if coordinator has access to this user
      if (req.user.role === 'coordinator' && parseInt(id) !== req.user.id) {
        const hasAccess = await Database.query(`
          SELECT 1 FROM user_gathering_assignments uga1
          JOIN user_gathering_assignments uga2 ON uga1.gathering_type_id = uga2.gathering_type_id
          WHERE uga1.user_id = ? AND uga2.user_id = ?
          LIMIT 1
        `, [req.user.id, id]);

        if (hasAccess.length === 0) {
          return res.status(403).json({ error: 'Access denied to this user' });
        }
      }

      // Coordinators cannot change roles to admin
      if (req.user.role === 'coordinator' && role === 'admin') {
        return res.status(403).json({ error: 'Coordinators cannot assign admin role' });
      }

      // Build update query dynamically
      const updateFields = [];
      const updateValues = [];

      if (role !== undefined) {
        updateFields.push('role = ?');
        updateValues.push(role);
      }
      if (firstName !== undefined) {
        updateFields.push('first_name = ?');
        updateValues.push(firstName);
      }
      if (lastName !== undefined) {
        updateFields.push('last_name = ?');
        updateValues.push(lastName);
      }
      if (isActive !== undefined) {
        updateFields.push('is_active = ?');
        updateValues.push(isActive);
      }
      if (emailNotifications !== undefined) {
        updateFields.push('email_notifications = ?');
        updateValues.push(emailNotifications);
      }
      if (smsNotifications !== undefined) {
        updateFields.push('sms_notifications = ?');
        updateValues.push(smsNotifications);
      }
      if (notificationFrequency !== undefined) {
        updateFields.push('notification_frequency = ?');
        updateValues.push(notificationFrequency);
      }

      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      updateFields.push('updated_at = NOW()');
      updateValues.push(id);

      await Database.query(`
        UPDATE users SET ${updateFields.join(', ')}
        WHERE id = ?
      `, updateValues);

      res.json({ message: 'User updated successfully' });
    } catch (error) {
      console.error('Update user error:', error);
      res.status(500).json({ error: 'Failed to update user.' });
    }
  }
);

// Delete user (Admin only)
router.delete('/:id', 
  requireRole(['admin']),
  auditLog('DELETE_USER'),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Prevent deleting the last admin user
      if (parseInt(id) === req.user.id) {
        const adminCount = await Database.query(
          'SELECT COUNT(*) as count FROM users WHERE role = "admin" AND is_active = true'
        );
        
        if (adminCount[0].count <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last admin user' });
        }
      }

      // Check if user exists
      const users = await Database.query(
        'SELECT id, first_name, last_name FROM users WHERE id = ?',
        [id]
      );

      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Soft delete by setting is_active to false
      await Database.query(
        'UPDATE users SET is_active = false, updated_at = NOW() WHERE id = ?',
        [id]
      );

      res.json({ message: 'User deactivated successfully' });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete user.' });
    }
  }
);

// Assign user to gatherings (Admin and Coordinators can assign users to gatherings they have access to)
router.post('/:userId/gatherings', 
  requireRole(['admin', 'coordinator']),
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

      // Check if coordinator has access to this user
      if (req.user.role === 'coordinator' && parseInt(userId) !== req.user.id) {
        const hasAccess = await Database.query(`
          SELECT 1 FROM user_gathering_assignments uga1
          JOIN user_gathering_assignments uga2 ON uga1.gathering_type_id = uga2.gathering_type_id
          WHERE uga1.user_id = ? AND uga2.user_id = ?
          LIMIT 1
        `, [req.user.id, userId]);

        if (hasAccess.length === 0) {
          return res.status(403).json({ error: 'Access denied to this user' });
        }
      }

      // Get available gatherings for this user
      let availableGatherings;
      if (req.user.role === 'coordinator') {
        availableGatherings = await Database.query(`
          SELECT gt.id, gt.name 
          FROM gathering_types gt
          JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
          WHERE uga.user_id = ? AND gt.is_active = true
        `, [req.user.id]);
      } else {
        availableGatherings = await Database.query(`
          SELECT id, name FROM gathering_types WHERE is_active = true
        `);
      }

      const availableGatheringIds = availableGatherings.map(g => g.id);
      const invalidGatherings = gatheringIds.filter(id => !availableGatheringIds.includes(parseInt(id)));
      
      if (invalidGatherings.length > 0) {
        return res.status(403).json({ 
          error: 'Cannot assign gatherings you do not have access to',
          invalidGatherings
        });
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
        message: `User ${user.first_name} ${user.last_name} assigned to ${gatheringIds.length} gathering(s)`,
        assignedGatherings: availableGatherings.filter(g => gatheringIds.includes(g.id.toString()))
      });

    } catch (error) {
      console.error('Assign user to gatherings error:', error);
      res.status(500).json({ error: 'Failed to assign user to gatherings' });
    }
  }
);

// Get user's gathering assignments (Admin and Coordinators can see assignments for users they have access to)
router.get('/:userId/gatherings', 
  requireRole(['admin', 'coordinator']),
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

      // Check if coordinator has access to this user
      if (req.user.role === 'coordinator' && parseInt(userId) !== req.user.id) {
        const hasAccess = await Database.query(`
          SELECT 1 FROM user_gathering_assignments uga1
          JOIN user_gathering_assignments uga2 ON uga1.gathering_type_id = uga2.gathering_type_id
          WHERE uga1.user_id = ? AND uga2.user_id = ?
          LIMIT 1
        `, [req.user.id, userId]);

        if (hasAccess.length === 0) {
          return res.status(403).json({ error: 'Access denied to this user' });
        }
      }

      // Get user's current assignments
      const assignments = await Database.query(`
        SELECT gt.id, gt.name, gt.description, uga.assigned_at,
               u.first_name as assigned_by_first_name, u.last_name as assigned_by_last_name
        FROM user_gathering_assignments uga
        JOIN gathering_types gt ON uga.gathering_type_id = gt.id
        LEFT JOIN users u ON uga.assigned_by = u.id
        WHERE uga.user_id = ? AND gt.is_active = true
        ORDER BY gt.name
      `, [userId]);

      // Get available gatherings for assignment
      let availableGatherings;
      if (req.user.role === 'coordinator') {
        availableGatherings = await Database.query(`
          SELECT gt.id, gt.name, gt.description
          FROM gathering_types gt
          JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
          WHERE uga.user_id = ? AND gt.is_active = true
          ORDER BY gt.name
        `, [req.user.id]);
      } else {
        availableGatherings = await Database.query(`
          SELECT id, name, description
          FROM gathering_types 
          WHERE is_active = true
          ORDER BY name
        `);
      }

      res.json({
        user: users[0],
        currentAssignments: assignments,
        availableGatherings: availableGatherings
      });

    } catch (error) {
      console.error('Get user gathering assignments error:', error);
      res.status(500).json({ error: 'Failed to get user gathering assignments' });
    }
  }
);

module.exports = router; 