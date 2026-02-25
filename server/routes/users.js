const express = require('express');
const { body, validationResult } = require('express-validator');
const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');
const { getChurchCountry, validatePhoneNumber, getInternationalFormat } = require('../utils/sms');
const { processApiResponse } = require('../utils/caseConverter');

const router = express.Router();
// Update current user's own profile (any authenticated user)
router.put('/me', 
  verifyToken,
  [
    body('firstName').optional().trim().isLength({ min: 1 }).withMessage('First name cannot be empty'),
    body('lastName').optional().trim().isLength({ min: 1 }).withMessage('Last name cannot be empty'),
    body('email')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === '') return true;
        return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value);
      }).withMessage('Please provide a valid email address'),
    body('mobileNumber')
      .optional({ nullable: true })
      .custom(async (value) => {
        if (!value) return true;
        const countryCode = await getChurchCountry();
        if (!validatePhoneNumber(value, countryCode)) {
          throw new Error(`Please provide a valid phone number for ${countryCode}`);
        }
        return true;
      }),
    body('primaryContactMethod')
      .optional()
      .isIn(['email', 'sms'])
      .withMessage('Invalid primary contact method'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.user.id;
      let { firstName, lastName, email, mobileNumber, primaryContactMethod } = req.body;

      // Normalize mobile number if provided
      let normalizedMobile = undefined;
      if (mobileNumber !== undefined) {
        if (mobileNumber === null || mobileNumber === '') {
          normalizedMobile = null;
        } else {
          const countryCode = await getChurchCountry();
          normalizedMobile = getInternationalFormat(mobileNumber, countryCode);
          if (!normalizedMobile) {
            return res.status(400).json({ error: `Invalid mobile number format for ${await getChurchCountry()}` });
          }
        }
      }

      // Duplicate checks (exclude current user) — global uniqueness, not per-church
      if (email !== undefined && email !== null && email !== '') {
        const emailDup = await Database.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]);
        if (emailDup.length > 0) {
          return res.status(409).json({ error: 'This email address is already in use' });
        }
      }
      if (normalizedMobile !== undefined && normalizedMobile !== null) {
        const mobileDup = await Database.query('SELECT id FROM users WHERE mobile_number = ? AND id != ?', [normalizedMobile, userId]);
        if (mobileDup.length > 0) {
          return res.status(409).json({ error: 'This phone number is already in use' });
        }
      }

      // Build update
      const updateFields = [];
      const updateValues = [];
      if (firstName !== undefined) { updateFields.push('first_name = ?'); updateValues.push(firstName); }
      if (lastName !== undefined) { updateFields.push('last_name = ?'); updateValues.push(lastName); }
      if (email !== undefined) { updateFields.push('email = ?'); updateValues.push(email === '' ? null : email); }
      if (normalizedMobile !== undefined) { updateFields.push('mobile_number = ?'); updateValues.push(normalizedMobile); }
      if (primaryContactMethod !== undefined) { updateFields.push('primary_contact_method = ?'); updateValues.push(primaryContactMethod); }
      if (updateFields.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }
      updateFields.push('updated_at = NOW()');
      updateValues.push(userId);

      await Database.query(`
        UPDATE users SET ${updateFields.join(', ')}
        WHERE id = ?
      `, updateValues);

      return res.json({ message: 'Profile updated successfully' });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        const msg = error.sqlMessage?.includes('unique_mobile')
          ? 'This phone number is already in use'
          : 'This email address is already in use';
        return res.status(409).json({ error: msg });
      }
      console.error('Update profile (me) error:', error);
      res.status(500).json({ error: 'Failed to update profile.' });
    }
  }
);

// All routes require authentication
router.use(verifyToken);

// Get all users (Admin and Coordinators can see users they have access to)
router.get('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    let query = `
      SELECT u.id, u.email, u.mobile_number, u.primary_contact_method, u.role, 
             u.first_name, u.last_name, u.is_active, u.is_invited, u.first_login_completed,
             u.email_notifications, u.sms_notifications, u.notification_frequency, u.created_at, u.last_login_at,
             COUNT(DISTINCT uga.gathering_type_id) as gathering_count
      FROM users u
      LEFT JOIN user_gathering_assignments uga 
        ON u.id = uga.user_id AND uga.church_id = u.church_id
      WHERE u.church_id = ? AND u.is_active = true
    `;
    
    let params = [req.user.church_id];

    // Coordinators can only see users they have access to (same gatherings)
    if (req.user.role === 'coordinator') {
      query += `
        AND (u.id IN (
          SELECT DISTINCT uga2.user_id 
          FROM user_gathering_assignments uga2
          WHERE uga2.gathering_type_id IN (
            SELECT gathering_type_id 
            FROM user_gathering_assignments 
            WHERE user_id = ?
          )
        ) OR u.id = ?)
      `;
      params.push(req.user.id, req.user.id);
    }

    query += `
      GROUP BY u.id
      ORDER BY u.last_name, u.first_name
    `;
    
    const users = await Database.query(query, params);
    
    // Use systematic conversion utility for field name conversion and BigInt handling
    const responseData = processApiResponse({ 
      users: users.map(user => ({
        ...user,
        gathering_count: Number(user.gathering_count)
      }))
    });
    
    res.json(responseData);
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
        WHERE uga1.user_id = ? AND uga2.user_id = ? AND uga1.church_id = ?
        LIMIT 1
      `, [req.user.id, id, req.user.church_id]);

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
      WHERE id = ? AND church_id = ?
    `, [id, req.user.church_id]);

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
      WHERE uga.user_id = ? AND gt.is_active = true AND gt.church_id = ? AND uga.church_id = ?
      ORDER BY gt.name
    `, [id, req.user.church_id, req.user.church_id]);

    // Use systematic conversion utility for consistent field naming
    const responseData = processApiResponse({
      user: {
        ...user,
        default_gathering_id: user.default_gathering_id ? Number(user.default_gathering_id) : null
      },
      gathering_assignments: assignments
    });
    
    res.json(responseData);

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
      .optional()
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

      // If primary method provided, ensure corresponding contact exists
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

      // Check for duplicate email or mobile number — global uniqueness
      if (email) {
        const emailDup = await Database.query('SELECT id FROM users WHERE email = ?', [email]);
        if (emailDup.length > 0) {
          return res.status(409).json({ error: 'This email address is already in use' });
        }
      }
      if (normalizedMobile) {
        const mobileDup = await Database.query('SELECT id FROM users WHERE mobile_number = ?', [normalizedMobile]);
        if (mobileDup.length > 0) {
          return res.status(409).json({ error: 'This phone number is already in use' });
        }
      }

      const result = await Database.query(`
        INSERT INTO users (email, mobile_number, primary_contact_method, role, first_name, last_name, is_invited, church_id)
        VALUES (?, ?, ?, ?, ?, ?, true, ?)
      `, [email || null, normalizedMobile, primaryContactMethod, role, firstName, lastName, req.user.church_id]);

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
          isActive: true,
          isInvited: true,
          firstLoginCompleted: false
        }
      });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        const msg = error.sqlMessage?.includes('unique_mobile')
          ? 'This phone number is already in use'
          : 'This email address is already in use';
        return res.status(409).json({ error: msg });
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
    body('email')
      .optional({ nullable: true })
      .custom((value) => {
        if (value === null || value === '') return true; // allow clearing
        return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value);
      })
      .withMessage('Please provide a valid email address'),
    body('mobileNumber')
      .optional({ nullable: true })
      .custom(async (value) => {
        if (!value) return true; // allow clearing
        const countryCode = await getChurchCountry();
        if (!validatePhoneNumber(value, countryCode)) {
          throw new Error(`Please provide a valid phone number for ${countryCode}`);
        }
        return true;
      }),
    body('primaryContactMethod')
      .optional()
      .isIn(['email', 'sms'])
      .withMessage('Invalid primary contact method'),
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
      let { email, mobileNumber, primaryContactMethod } = req.body;

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

      // Normalize mobile number if provided
      let normalizedMobile = undefined;
      if (mobileNumber !== undefined) {
        if (mobileNumber === null || mobileNumber === '') {
          normalizedMobile = null;
        } else {
          const countryCode = await getChurchCountry();
          normalizedMobile = getInternationalFormat(mobileNumber, countryCode);
          if (!normalizedMobile) {
            return res.status(400).json({ error: `Invalid mobile number format for ${await getChurchCountry()}` });
          }
        }
      }

      // Duplicate checks (exclude current user)
      // Duplicate checks — global uniqueness, not per-church
      if (email !== undefined && email !== null && email !== '') {
        const emailDup = await Database.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, id]);
        if (emailDup.length > 0) {
          return res.status(409).json({ error: 'This email address is already in use' });
        }
      }
      if (normalizedMobile !== undefined && normalizedMobile !== null) {
        const mobileDup = await Database.query('SELECT id FROM users WHERE mobile_number = ? AND id != ?', [normalizedMobile, id]);
        if (mobileDup.length > 0) {
          return res.status(409).json({ error: 'This phone number is already in use' });
        }
      }

      // Build update query dynamically
      const updateFields = [];
      const updateValues = [];

      if (role !== undefined) {
        updateFields.push('role = ?');
        updateValues.push(role);
      }
      if (email !== undefined) {
        // Treat empty string as NULL to clear the field
        updateFields.push('email = ?');
        updateValues.push(email === '' ? null : email);
      }
      if (normalizedMobile !== undefined) {
        updateFields.push('mobile_number = ?');
        updateValues.push(normalizedMobile);
      }
      if (primaryContactMethod !== undefined) {
        updateFields.push('primary_contact_method = ?');
        updateValues.push(primaryContactMethod);
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
      if (error.code === 'ER_DUP_ENTRY') {
        const msg = error.sqlMessage?.includes('unique_mobile')
          ? 'This phone number is already in use'
          : 'This email address is already in use';
        return res.status(409).json({ error: msg });
      }
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
        'SELECT id, email, first_name, last_name FROM users WHERE id = ? AND church_id = ?',
        [userId, req.user.church_id]
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
          WHERE uga1.user_id = ? AND uga2.user_id = ? AND uga1.church_id = ? AND uga2.church_id = ?
          LIMIT 1
        `, [req.user.id, userId, req.user.church_id, req.user.church_id]);

        if (hasAccess.length === 0) {
          return res.status(403).json({ error: 'Access denied to this user' });
        }
      }

      // Get available gatherings the acting user can assign
      let availableGatherings;
      if (req.user.role === 'coordinator') {
        if (parseInt(userId) === req.user.id) {
          // Coordinators can associate themselves with any active gathering in their church
          availableGatherings = await Database.query(`
            SELECT id, name FROM gathering_types WHERE is_active = true AND church_id = ?
          `, [req.user.church_id]);
        } else {
          // Coordinators can only manage users where they share gatherings (within the same church)
          availableGatherings = await Database.query(`
            SELECT gt.id, gt.name 
            FROM gathering_types gt
            JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
            WHERE uga.user_id = ? AND gt.is_active = true AND gt.church_id = ? AND uga.church_id = ?
          `, [req.user.id, req.user.church_id, req.user.church_id]);
        }
      } else {
        availableGatherings = await Database.query(`
          SELECT id, name FROM gathering_types WHERE is_active = true AND church_id = ?
        `, [req.user.church_id]);
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
        'DELETE FROM user_gathering_assignments WHERE user_id = ? AND church_id = ?',
        [userId, req.user.church_id]
      );

      // Add new assignments
      for (const gatheringId of gatheringIds) {
        await Database.query(`
          INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by, church_id)
          VALUES (?, ?, ?, ?)
        `, [userId, gatheringId, req.user.id, req.user.church_id]);
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
      'SELECT id, email, first_name, last_name FROM users WHERE id = ? AND church_id = ?',
      [userId, req.user.church_id]
    );

      if (users.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if coordinator has access to this user
      if (req.user.role === 'coordinator' && parseInt(userId) !== req.user.id) {
        const hasAccess = await Database.query(`
          SELECT 1 FROM user_gathering_assignments uga1
          JOIN user_gathering_assignments uga2 ON uga1.gathering_type_id = uga2.gathering_type_id
          WHERE uga1.user_id = ? AND uga2.user_id = ? AND uga1.church_id = ? AND uga2.church_id = ?
          LIMIT 1
        `, [req.user.id, userId, req.user.church_id, req.user.church_id]);

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
        WHERE uga.user_id = ? AND gt.is_active = true AND gt.church_id = ? AND uga.church_id = ?
        ORDER BY gt.name
      `, [userId, req.user.church_id, req.user.church_id]);

      // Get available gatherings for assignment
      let availableGatherings;
      if (req.user.role === 'coordinator') {
        if (parseInt(userId) === req.user.id) {
          // Coordinators can assign themselves to any active gathering in their church
          availableGatherings = await Database.query(`
            SELECT id, name, description
            FROM gathering_types 
            WHERE is_active = true AND church_id = ?
            ORDER BY name
          `, [req.user.church_id]);
        } else {
          availableGatherings = await Database.query(`
            SELECT gt.id, gt.name, gt.description
            FROM gathering_types gt
            JOIN user_gathering_assignments uga ON gt.id = uga.gathering_type_id
            WHERE uga.user_id = ? AND gt.is_active = true AND gt.church_id = ? AND uga.church_id = ?
            ORDER BY gt.name
          `, [req.user.id, req.user.church_id, req.user.church_id]);
        }
      } else {
        availableGatherings = await Database.query(`
          SELECT id, name, description
          FROM gathering_types 
          WHERE is_active = true AND church_id = ?
          ORDER BY name
        `, [req.user.church_id]);
      }

      res.json({
        user: {
          id: Number(users[0].id),
          email: users[0].email,
          firstName: users[0].first_name,
          lastName: users[0].last_name
        },
        currentAssignments: assignments,
        availableGatherings: availableGatherings
      });

    } catch (error) {
      console.error('Get user gathering assignments error:', error);
      res.status(500).json({ error: 'Failed to get user gathering assignments' });
    }
  }
);

// User preferences endpoints
// Get user preferences
router.get('/me/preferences', verifyToken, async (req, res) => {
  try {
    const preferences = await Database.query(`
      SELECT preference_key, preference_value, updated_at
      FROM user_preferences 
      WHERE user_id = ? AND church_id = ?
      ORDER BY updated_at DESC
    `, [req.user.id, req.user.church_id]);

    // Convert to object format for easier frontend consumption
    const preferencesObj = {};
    preferences.forEach(pref => {
      try {
        // Handle different data types that might be returned from the database
        let parsedValue;
        if (typeof pref.preference_value === 'string') {
          // If it's a string, try to parse it as JSON
          parsedValue = JSON.parse(pref.preference_value);
        } else if (typeof pref.preference_value === 'object' && pref.preference_value !== null) {
          // If it's already an object, use it directly
          parsedValue = pref.preference_value;
        } else {
          // If it's null or undefined, use null
          parsedValue = null;
        }
        preferencesObj[pref.preference_key] = parsedValue;
      } catch (e) {
        console.warn(`Failed to parse preference ${pref.preference_key}:`, e);
        // Set to null if parsing fails
        preferencesObj[pref.preference_key] = null;
      }
    });

    res.json({ preferences: preferencesObj });
  } catch (error) {
    console.error('Get user preferences error:', error);
    res.status(500).json({ error: 'Failed to get user preferences' });
  }
});

// Save user preference
router.post('/me/preferences', 
  verifyToken,
  [
    body('key').trim().isLength({ min: 1, max: 100 }).withMessage('Preference key is required and must be 1-100 characters'),
    body('value').isObject().withMessage('Preference value must be an object'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { key, value } = req.body;
      const userId = req.user.id;
      const churchId = req.user.church_id;

      // Insert or update preference
      await Database.query(`
        INSERT INTO user_preferences (user_id, preference_key, preference_value, church_id)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          preference_value = VALUES(preference_value),
          updated_at = CURRENT_TIMESTAMP
      `, [userId, key, JSON.stringify(value), churchId]);

      res.json({ message: 'Preference saved successfully' });
    } catch (error) {
      console.error('Save user preference error:', error);
      res.status(500).json({ error: 'Failed to save user preference' });
    }
  }
);

// Save multiple user preferences
router.post('/me/preferences/batch', 
  verifyToken,
  [
    body('preferences').isObject().withMessage('Preferences must be an object'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { preferences } = req.body;
      const userId = req.user.id;
      const churchId = req.user.church_id;

      // Validate each preference
      for (const [key, value] of Object.entries(preferences)) {
        if (typeof key !== 'string' || key.length === 0 || key.length > 100) {
          return res.status(400).json({ error: `Invalid preference key: ${key}` });
        }
        if (typeof value !== 'object' || value === null) {
          return res.status(400).json({ error: `Preference value for ${key} must be an object` });
        }
      }

      // Insert or update all preferences
      for (const [key, value] of Object.entries(preferences)) {
        await Database.query(`
          INSERT INTO user_preferences (user_id, preference_key, preference_value, church_id)
          VALUES (?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE 
            preference_value = VALUES(preference_value),
            updated_at = CURRENT_TIMESTAMP
        `, [userId, key, JSON.stringify(value), churchId]);
      }

      res.json({ message: 'Preferences saved successfully' });
    } catch (error) {
      console.error('Save user preferences batch error:', error);
      res.status(500).json({ error: 'Failed to save user preferences' });
    }
  }
);

module.exports = router; 