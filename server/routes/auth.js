const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const moment = require('moment');

const Database = require('../config/database');
const { generateOTC, sendOTCEmail } = require('../utils/email');
const { sendOTCSMS, getChurchCountry, validatePhoneNumber, getInternationalFormat, maskPhoneNumber } = require('../utils/sms');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs
  message: { error: 'Too many authentication attempts, please try again later.' }
});

// Disabled rate limiting for development/testing
// const otcLimiter = rateLimit({
//   windowMs: 60 * 1000, // 1 minute
//   max: 10, // limit each IP to 10 OTC requests per minute (increased for testing)
//   message: { error: 'Please wait before requesting another code.' }
// });

// Request One-Time Code (supports both email and SMS)
router.post('/request-code',
  [
    body('contact')
      .trim()
      .notEmpty()
      .withMessage('Contact information is required')
      .custom(async (value) => {
        // Check if it's a valid email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const isEmail = emailRegex.test(value);
        
        if (isEmail) {
          return true;
        }
        
        // Check if it's a valid phone number for the church's country
        try {
          const countryCode = await getChurchCountry();
          const isPhone = validatePhoneNumber(value, countryCode);
          
          if (!isPhone) {
            throw new Error(`Please provide a valid email address or phone number for ${countryCode}`);
          }
          return true;
        } catch (error) {
          throw new Error('Please provide a valid email address or phone number');
        }
      })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { contact } = req.body;
      
      // Determine if contact is email or phone
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const isEmail = emailRegex.test(contact);
      const contactType = isEmail ? 'email' : 'sms';
      
      // Normalize contact information
      let normalizedContact = contact;
      if (!isEmail) {
        // Get church country for intelligent phone number parsing
        const countryCode = await getChurchCountry();
        const internationalFormat = getInternationalFormat(contact, countryCode);
        
        if (!internationalFormat) {
          return res.status(400).json({ 
            error: `Invalid phone number format for ${countryCode}. Please check your number and try again.` 
          });
        }
        
        normalizedContact = internationalFormat;
      }

      // Check if user exists and is active
      const whereClause = isEmail ? 'email = ?' : 'mobile_number = ?';
      const users = await Database.query(
        `SELECT id, email, mobile_number, primary_contact_method, role, is_active FROM users WHERE ${whereClause}`,
        [isEmail ? contact : normalizedContact]
      );

      if (users.length === 0) {
        const contactMethod = isEmail ? 'email address' : 'phone number';
        return res.status(404).json({ error: `No user found with this ${contactMethod}.` });
      }

      const user = users[0];
      if (!user.is_active) {
        return res.status(403).json({ error: 'User account is deactivated.' });
      }

      // Use the user's preferred contact method if available
      let finalContactMethod = contactType;
      let finalContact = normalizedContact;
      
      // If user has both email and mobile, use their preference
      if (user.email && user.mobile_number && user.primary_contact_method !== contactType) {
        if (user.primary_contact_method === 'email') {
          finalContactMethod = 'email';
          finalContact = user.email;
        } else if (user.primary_contact_method === 'sms') {
          finalContactMethod = 'sms';
          finalContact = user.mobile_number;
        }
      }

      // Cooldown check disabled for development/testing
      // const cooldownSeconds = parseInt(process.env.OTC_RESEND_COOLDOWN_SECONDS) || 60;
      // const recentCodes = await Database.query(`
      //   SELECT id FROM otc_codes 
      //   WHERE contact_identifier = ? AND contact_type = ? AND used = false 
      //   AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
      // `, [finalContact, finalContactMethod, cooldownSeconds]);

      // if (recentCodes.length > 0) {
      //   return res.status(429).json({ 
      //     error: `Please wait ${cooldownSeconds} seconds before requesting a new code.`,
      //     cooldownSeconds 
      //   });
      // }

      // Clean up expired codes
      await Database.query(
        'DELETE FROM otc_codes WHERE contact_identifier = ? AND contact_type = ? AND (used = true OR expires_at < NOW())',
        [finalContact, finalContactMethod]
      );

      // Generate new OTC
      const code = generateOTC();
      const expiresAt = moment().utc().add(parseInt(process.env.OTC_EXPIRE_MINUTES) || 10, 'minutes').format('YYYY-MM-DD HH:mm:ss');

      // Store OTC in database
      await Database.query(`
        INSERT INTO otc_codes (contact_identifier, contact_type, code, expires_at)
        VALUES (?, ?, ?, ?)
      `, [finalContact, finalContactMethod, code, expiresAt]);

      // Send code via appropriate method (don't wait for it to complete)
      setImmediate(async () => {
        try {
          if (finalContactMethod === 'email') {
            await sendOTCEmail(finalContact, code);
          } else {
            await sendOTCSMS(finalContact, code);
          }
        } catch (error) {
          console.error(`Failed to send OTC via ${finalContactMethod}:`, error);
        }
      });

      // Mask the contact information for response
      let maskedContact;
      if (finalContactMethod === 'email') {
        maskedContact = finalContact.replace(/(.{2})(.*)(@.*)/, '$1***$3');
      } else {
        const countryCode = await getChurchCountry();
        maskedContact = maskPhoneNumber(finalContact, countryCode);
      }

      res.json({ 
        message: `Verification code sent to your ${finalContactMethod === 'email' ? 'email address' : 'phone number'}.`,
        contact: maskedContact,
        contactType: finalContactMethod,
        expiresIn: parseInt(process.env.OTC_EXPIRE_MINUTES) || 10
      });

    } catch (error) {
      console.error('Request code error:', error);
      res.status(500).json({ error: 'Failed to send verification code.' });
    }
  }
);

// Verify One-Time Code and login (supports both email and SMS)
router.post('/verify-code',
  authLimiter,
  [
    body('contact')
      .trim()
      .notEmpty()
      .withMessage('Contact information is required'),
    body('code')
      .isLength({ min: 6, max: 6 })
      .isNumeric()
      .withMessage('Code must be 6 digits')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { contact, code } = req.body;

      // Determine if contact is email or phone and normalize
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const isEmail = emailRegex.test(contact);
      const contactType = isEmail ? 'email' : 'sms';
      
      let normalizedContact = contact;
      if (!isEmail) {
        // Get church country for intelligent phone number parsing
        const countryCode = await getChurchCountry();
        const internationalFormat = getInternationalFormat(contact, countryCode);
        
        if (!internationalFormat) {
          return res.status(401).json({ error: 'Invalid phone number format' });
        }
        
        normalizedContact = internationalFormat;
      }

      // Get user by contact method
      const whereClause = isEmail ? 'email = ?' : 'mobile_number = ?';
      const users = await Database.query(
        `SELECT id, email, mobile_number, primary_contact_method, role, first_name, last_name, is_active, first_login_completed, default_gathering_id FROM users WHERE ${whereClause}`,
        [isEmail ? contact : normalizedContact]
      );

      if (users.length === 0) {
        return res.status(404).json({ error: 'No user found with this email address.', code: 'USER_NOT_FOUND' });
      }
      
      if (!users[0].is_active) {
        return res.status(401).json({ error: 'Account is deactivated. Please contact your administrator.' });
      }

      const user = users[0];

      // Find the most recent valid OTC for this contact
      const otcRecords = await Database.query(`
        SELECT id, contact_identifier, contact_type FROM otc_codes 
        WHERE contact_identifier = ? AND contact_type = ? AND code = ? AND used = false AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
      `, [normalizedContact, contactType, code]);

      // Also check if they have alternative contact methods with valid codes
      let validOtcRecord = null;
      if (otcRecords.length > 0) {
        validOtcRecord = otcRecords[0];
      } else if (user.email && user.mobile_number) {
        // Check alternative contact method
        const altContactType = contactType === 'email' ? 'sms' : 'email';
        const altContact = contactType === 'email' ? user.mobile_number : user.email;
        
        const altOtcRecords = await Database.query(`
          SELECT id, contact_identifier, contact_type FROM otc_codes 
          WHERE contact_identifier = ? AND contact_type = ? AND code = ? AND used = false AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [altContact, altContactType, code]);
        
        if (altOtcRecords.length > 0) {
          validOtcRecord = altOtcRecords[0];
        }
      }

      if (!validOtcRecord) {
        return res.status(401).json({ error: 'Invalid or expired verification code.' });
      }

      // Mark code as used
      await Database.query(
        'UPDATE otc_codes SET used = true WHERE id = ?',
        [validOtcRecord.id]
      );

      // Clean up old codes for this user's contact methods
      const cleanupTasks = [];
      if (user.email) {
        cleanupTasks.push(
          Database.query(
            'DELETE FROM otc_codes WHERE contact_identifier = ? AND contact_type = ? AND (used = true OR expires_at < NOW())',
            [user.email, 'email']
          )
        );
      }
      if (user.mobile_number) {
        cleanupTasks.push(
          Database.query(
            'DELETE FROM otc_codes WHERE contact_identifier = ? AND contact_type = ? AND (used = true OR expires_at < NOW())',
            [user.mobile_number, 'sms']
          )
        );
      }
      await Promise.all(cleanupTasks);

      // Generate JWT token
      const token = jwt.sign(
        { 
          userId: user.id, 
          email: user.email, 
          mobile: user.mobile_number,
          role: user.role 
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '30d' }
      );

      // Set HTTP-only cookie with the token
      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Only use secure in production
        sameSite: 'strict',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
        path: '/'
      };
      
      res.cookie('authToken', token, cookieOptions);

      // Get user's gathering assignments
      const assignments = await Database.query(`
        SELECT gt.id, gt.name, gt.description
        FROM user_gathering_assignments uga
        JOIN gathering_types gt ON uga.gathering_type_id = gt.id
        WHERE uga.user_id = ? AND gt.is_active = true
        ORDER BY gt.name
      `, [user.id]);

      // Convert BigInt IDs to regular numbers
      const assignmentsWithNumbers = assignments.map(assignment => ({
        ...assignment,
        id: Number(assignment.id)
      }));

      // Mark first login as completed if this is their first time
      // Only mark as completed if user has gathering assignments or is admin
      if (!user.first_login_completed) {
        const hasAssignments = assignments.length > 0;
        const isAdmin = user.role === 'admin';
        
        if (hasAssignments || isAdmin) {
        await Database.query(
          'UPDATE users SET first_login_completed = true WHERE id = ?',
          [user.id]
        );
      }
      }

      // Determine if this is first login based on assignments and role
      const hasAssignments = assignments.length > 0;
      const isAdmin = user.role === 'admin';
      const isFirstLogin = !user.first_login_completed && (!hasAssignments || !isAdmin);

      res.json({
        message: 'Login successful',
        user: {
          id: user.id,
          email: user.email,
          mobileNumber: user.mobile_number,
          primaryContactMethod: user.primary_contact_method,
          role: user.role,
          firstName: user.first_name,
          lastName: user.last_name,
          isFirstLogin: isFirstLogin,
          defaultGatheringId: user.default_gathering_id,
          gatheringAssignments: assignmentsWithNumbers
        }
      });

    } catch (error) {
      console.error('Verify code error:', error);
      res.status(500).json({ error: 'Login failed.' });
    }
  }
);

// Get current user info
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = req.user;
    
    // Get user's gathering assignments
    const assignments = await Database.query(`
      SELECT gt.id, gt.name, gt.description
      FROM user_gathering_assignments uga
      JOIN gathering_types gt ON uga.gathering_type_id = gt.id
      WHERE uga.user_id = ? AND gt.is_active = true
      ORDER BY gt.name
    `, [user.id]);

    // Convert BigInt IDs to regular numbers
    const assignmentsWithNumbers = assignments.map(assignment => ({
      ...assignment,
      id: Number(assignment.id)
    }));

    // Get unread notifications count
    const notificationCount = await Database.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = false',
      [user.id]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        isFirstLogin: !user.first_login_completed,
        defaultGatheringId: user.default_gathering_id,
        gatheringAssignments: assignmentsWithNumbers,
        unreadNotifications: Number(notificationCount[0].count)
      }
    });

  } catch (error) {
    console.error('Get user info error:', error);
    res.status(500).json({ error: 'Failed to get user information.' });
  }
});

// Refresh token
router.post('/refresh', verifyToken, async (req, res) => {
  try {
    const user = req.user;
    
    // Generate new token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        role: user.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '30d' }
    );

    // Set new HTTP-only cookie with the refreshed token
    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
      path: '/'
    };
    
    res.cookie('authToken', token, cookieOptions);
    res.json({ message: 'Token refreshed successfully' });

  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({ error: 'Failed to refresh token.' });
  }
});

// Set default gathering
router.post('/set-default-gathering', 
  verifyToken,
  [
    body('gatheringId').isInt().withMessage('Valid gathering ID is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { gatheringId } = req.body;

      // Verify user has access to this gathering
      const assignments = await Database.query(
        'SELECT id FROM user_gathering_assignments WHERE user_id = ? AND gathering_type_id = ?',
        [req.user.id, gatheringId]
      );

      if (assignments.length === 0) {
        return res.status(403).json({ error: 'You do not have access to this gathering' });
      }

      // Update user's default gathering
      await Database.query(
        'UPDATE users SET default_gathering_id = ? WHERE id = ?',
        [gatheringId, req.user.id]
      );

      res.json({ message: 'Default gathering updated successfully' });

    } catch (error) {
      console.error('Set default gathering error:', error);
      res.status(500).json({ error: 'Failed to set default gathering' });
    }
  }
);

// Register new user
router.post('/register', 
  [
    body('email')
      .isEmail()
      .withMessage('Valid email address is required'),
    body('firstName')
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('First name is required (max 100 characters)'),
    body('lastName')
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Last name is required (max 100 characters)'),
    body('role')
      .optional()
      .isIn(['admin', 'attendance_taker', 'coordinator'])
      .withMessage('Role must be either admin, attendance_taker, or coordinator')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, firstName, lastName, role } = req.body;
      
      // Default to admin role if not specified
      const userRole = role || 'admin';

      // Check if user already exists
      const existingUser = await Database.query(
        'SELECT id FROM users WHERE email = ?',
        [email]
      );

      if (existingUser.length > 0) {
        return res.status(409).json({ error: 'A user with this email address already exists.' });
      }

      // Create new user
      const result = await Database.query(`
        INSERT INTO users (email, first_name, last_name, role, is_active, first_login_completed)
        VALUES (?, ?, ?, ?, true, false)
      `, [email, firstName, lastName, userRole]);

      const userId = result.insertId;

      // Generate OTC for first login
      const code = generateOTC();
      const expiresAt = moment().utc().add(parseInt(process.env.OTC_EXPIRE_MINUTES) || 10, 'minutes').format('YYYY-MM-DD HH:mm:ss');

      // Store OTC in database
      await Database.query(`
        INSERT INTO otc_codes (contact_identifier, contact_type, code, expires_at)
        VALUES (?, 'email', ?, ?)
      `, [email, code, expiresAt]);

      // Send welcome email with OTC
      setImmediate(async () => {
        try {
          await sendOTCEmail(email, code);
        } catch (error) {
          console.error('Failed to send welcome email:', error);
        }
      });

      res.status(201).json({ 
        message: 'Account created successfully. Please check your email for a verification code to complete your first login.',
        email: email.replace(/(.{2})(.*)(@.*)/, '$1***$3')
      });

    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({ error: 'Failed to create account.' });
    }
  }
);

// Logout - clear the auth cookie
router.post('/logout', verifyToken, (req, res) => {
  res.clearCookie('authToken', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/'
  });
  res.json({ message: 'Logged out successfully' });
});

module.exports = router; 