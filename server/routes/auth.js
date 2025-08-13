const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const moment = require('moment');
const crypto = require('crypto');

const Database = require('../config/database');
const { sendOTCEmail } = require('../utils/email');
const { generateOTC, sendOTCSMS, getChurchCountry, validatePhoneNumber, getInternationalFormat, maskPhoneNumber } = require('../utils/sms');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// Root auth endpoint - provides basic auth status
router.get('/', (req, res) => {
  // External services availability (Crazytel for SMS, Brevo for Email)
  const externalServices = {
    crazytel: !!(process.env.CRAZYTEL_API_KEY && process.env.CRAZYTEL_API_KEY.trim() && process.env.CRAZYTEL_FROM_NUMBER && process.env.CRAZYTEL_FROM_NUMBER.trim()),
    brevo: !!(process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim())
  };

  const hasExternalServices = externalServices.brevo || externalServices.crazytel;

  res.json({
    message: 'Authentication service is running',
    status: hasExternalServices ? 'full' : 'limited',
    externalServices: externalServices,
    endpoints: {
      'request-code': hasExternalServices ? 'POST - Request one-time code' : 'POST - Disabled (no external services)',
      'verify-code': hasExternalServices ? 'POST - Verify one-time code' : 'POST - Disabled (no external services)',
      'me': 'GET - Get current user info',
      'logout': 'POST - Logout user'
    },
    environment: process.env.NODE_ENV || 'development',
    development: process.env.NODE_ENV === 'development' ? {
      note: 'In development mode, use "dev@church.local" with code "000000" to login',
      devUser: 'dev@church.local',
      devCode: '000000'
    } : null,
    note: !hasExternalServices ? 'Configure Crazytel and/or Brevo API keys to enable full authentication' : null
  });
});

// Rate limiting for auth endpoints - enabled in all environments
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 20 : 5, // More lenient in development
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip successful requests to avoid penalizing normal usage
  skipSuccessfulRequests: true
});

// Rate limiting for OTC requests - enabled in all environments
const otcLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: process.env.NODE_ENV === 'development' ? 30 : 10, // More lenient in development
  message: { error: 'Please wait before requesting another code.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip successful requests to avoid penalizing normal usage
  skipSuccessfulRequests: true
});

// Request One-Time Code (supports both email and SMS)
router.post('/request-code',
  otcLimiter,
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
      let users = await Database.query(
        `SELECT id, email, mobile_number, primary_contact_method, role, is_active, church_id FROM users WHERE ${whereClause}`,
        [isEmail ? contact : normalizedContact]
      );

      if (users.length === 0) {
        // Development mode: Auto-create dev user if requesting code for dev@church.local
        if (process.env.NODE_ENV === 'development' && contact === 'dev@church.local') {
          console.log('🔧 Development mode: Auto-creating dev user for dev@church.local');
          
          try {
            // Use existing church_id from church_settings if available
            const existingSettings = await Database.query(
              'SELECT church_id FROM church_settings WHERE onboarding_completed = 1 LIMIT 1'
            );
            
            let churchId;
            if (existingSettings.length > 0) {
              churchId = existingSettings[0].church_id;
              console.log('✅ Using existing church_id:', churchId);
            } else {
              // Generate a simple church_id for development
              churchId = 'devch1';
              console.log('🆕 Using simple church_id:', churchId);
            }
            
            // Create development admin user
            const result = await Database.query(`
              INSERT INTO users (email, role, first_name, last_name, is_active, first_login_completed, church_id)
              VALUES (?, 'admin', 'Development', 'Admin', true, true, ?)
            `, ['dev@church.local', churchId]);
            
            // Set up church settings to bypass onboarding (only if they don't exist)
            if (existingSettings.length === 0) {
              await Database.query(`
                INSERT INTO church_settings (church_name, country_code, timezone, email_from_name, email_from_address, onboarding_completed, church_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `, [
                'Development Church',
                'AU',
                'Australia/Sydney',
                'Let My People Grow',
                'dev@church.local',
                true,
                churchId
              ]);
            }
            
            console.log('✅ Development user and church settings created');
            
            // Re-query for the newly created user
            const newUsers = await Database.query(
              'SELECT id, email, mobile_number, primary_contact_method, role, is_active, church_id FROM users WHERE email = ?',
              ['dev@church.local']
            );
            
            if (newUsers.length > 0) {
              users = newUsers;
            } else {
              throw new Error('Failed to create development user');
            }
          } catch (error) {
            console.error('Failed to create development user:', error);
            return res.status(500).json({ error: 'Failed to create development user' });
          }
        } else {
          const contactMethod = isEmail ? 'email address' : 'phone number';
          return res.status(404).json({ error: `No user found with this ${contactMethod}.` });
        }
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

      // Check if external services are available
      const externalServices = {
        crazytel: !!(process.env.CRAZYTEL_API_KEY && process.env.CRAZYTEL_API_KEY.trim() && process.env.CRAZYTEL_FROM_NUMBER && process.env.CRAZYTEL_FROM_NUMBER.trim()),
        brevo: !!(process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim())
      };

      const hasRequiredService = (finalContactMethod === 'email' && externalServices.brevo) || 
                                (finalContactMethod === 'sms' && externalServices.crazytel);

      if (!hasRequiredService) {
        // In development mode, we can still proceed without external services
        if (process.env.NODE_ENV === 'development') {
          console.log(`⚠️  Development mode: ${finalContactMethod.toUpperCase()} service not configured, but proceeding with code generation`);
        } else {
          return res.status(503).json({
            error: 'Service temporarily unavailable',
            message: `${finalContactMethod.toUpperCase()} service is not configured`,
            externalServices: externalServices,
            note: 'Configure external services to enable authentication'
          });
        }
      }

      // Send code via appropriate method (don't wait for it to complete)
      setImmediate(async () => {
        try {
          if (finalContactMethod === 'email') {
            if (externalServices.brevo) {
              await sendOTCEmail(finalContact, code);
            } else {
              console.log(`📧 Development mode: Email code ${code} for ${finalContact} (Brevo not configured)`);
            }
          } else {
            if (externalServices.crazytel) {
              await sendOTCSMS(finalContact, code);
            } else {
              console.log(`📱 Development mode: SMS code ${code} for ${finalContact} (Crazytel not configured)`);
            }
          }
        } catch (error) {
          console.error(`Failed to send OTC via ${finalContactMethod}:`, error);
          if (process.env.NODE_ENV === 'development') {
            console.log(`🔧 Development fallback: OTC for ${finalContact} is ${code}`);
          }
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

      const responsePayload = { 
        message: `Verification code sent to your ${finalContactMethod === 'email' ? 'email address' : 'phone number'}.`,
        contact: maskedContact,
        contactType: finalContactMethod,
        expiresIn: parseInt(process.env.OTC_EXPIRE_MINUTES) || 10
      };
      if (process.env.NODE_ENV === 'development') {
        // Return the code in development to simplify testing
        responsePayload.devCode = code;
      }
      res.json(responsePayload);

    } catch (error) {
      console.error('Request code error:', error);
      res.status(500).json({ error: 'Failed to send verification code.' });
    }
  }
);

// Verify One-Time Code and login (supports both email and SMS)
router.post('/verify-code',
  authLimiter,
  // authLimiter, // Temporarily disabled for development
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
        `SELECT id, email, mobile_number, primary_contact_method, role, first_name, last_name, is_active, first_login_completed, default_gathering_id, church_id FROM users WHERE ${whereClause}`,
        [isEmail ? contact : normalizedContact]
      );

      if (users.length === 0) {
        return res.status(404).json({ error: 'No user found with this email address.', code: 'USER_NOT_FOUND' });
      }
      
      if (!users[0].is_active) {
        return res.status(401).json({ error: 'Account is deactivated. Please contact your administrator.' });
      }

      const user = users[0];

      // Development bypass: Accept "000000" for dev@church.local in development mode
      let validOtcRecord = null;
      if (process.env.NODE_ENV === 'development' && 
          user.email === 'dev@church.local' && 
          code === '000000') {
        console.log('🔓 Development bypass: Accepting "000000" for dev@church.local');
        validOtcRecord = { id: 'dev-bypass' };
      } else {
        // Find the most recent valid OTC for this contact
        const otcRecords = await Database.query(`
          SELECT id, contact_identifier, contact_type FROM otc_codes 
          WHERE contact_identifier = ? AND contact_type = ? AND code = ? AND used = false AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [normalizedContact, contactType, code]);

        // Also check if they have alternative contact methods with valid codes
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
      }

      if (!validOtcRecord) {
        return res.status(401).json({ error: 'Invalid or expired verification code.' });
      }

      // Mark code as used (skip for development bypass)
      if (validOtcRecord.id !== 'dev-bypass') {
        await Database.query(
          'UPDATE otc_codes SET used = true WHERE id = ?',
          [validOtcRecord.id]
        );
      }

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
          role: user.role,
          churchId: user.church_id
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '30d' }
      );

      // Set HTTP-only cookie with the token
      const cookieOptions = {
        httpOnly: true,
        secure: req.secure || process.env.NODE_ENV === 'production', // Use secure if request is HTTPS or in production
        sameSite: 'lax', // Always use 'lax' for better iOS Safari compatibility
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
        path: '/'
      };
      
      // Add domain if specified in environment
      if (process.env.COOKIE_DOMAIN) {
        cookieOptions.domain = process.env.COOKIE_DOMAIN;
      }
      
      res.cookie('authToken', token, cookieOptions);

      // Update last login timestamp
      try {
        await Database.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
      } catch (e) {
        console.warn('⚠️  Failed to update last_login_at:', e.message);
      }

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

// Refresh token - additional rate limiting for JWT refresh attacks
const refreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: process.env.NODE_ENV === 'development' ? 50 : 10, // Stricter limits for refresh tokens
  message: { error: 'Too many token refresh attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

router.post('/refresh', verifyToken, authLimiter, refreshLimiter, async (req, res) => {
  try {
    const user = req.user;
    console.log(`🔄 Token refresh requested for user: ${user.email} (ID: ${user.id})`);
    
    // Validate user is still active
    if (!user.is_active) {
      console.log(`❌ Token refresh denied - user ${user.email} is inactive`);
      return res.status(401).json({ 
        error: 'User account is inactive.',
        code: 'USER_INACTIVE'
      });
    }
    
    // Generate new token
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email, 
        role: user.role,
        churchId: user.church_id
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '30d' }
    );

    // Set new HTTP-only cookie with the refreshed token
    const cookieOptions = {
      httpOnly: true,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax', // Always use 'lax' for better iOS Safari compatibility
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days in milliseconds
      path: '/'
    };
    
    // Add domain if specified in environment
    if (process.env.COOKIE_DOMAIN) {
      cookieOptions.domain = process.env.COOKIE_DOMAIN;
    }
    
    res.cookie('authToken', token, cookieOptions);
    console.log(`✅ Token refreshed successfully for user: ${user.email}`);
    res.json({ 
      message: 'Token refreshed successfully',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name
      }
    });

  } catch (error) {
    console.error('💥 Refresh token error:', error);
    res.status(500).json({ 
      error: 'Failed to refresh token.',
      code: 'REFRESH_FAILED'
    });
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

      const { email, firstName, lastName, role, churchName } = req.body;
      
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

      // Get or create church ID for new user (requires church name)
      const { getOrCreateChurchId } = require('../utils/churchIdGenerator');
      const churchId = await getOrCreateChurchId(churchName || 'New Church');
      
      // Create new user
      const result = await Database.query(`
        INSERT INTO users (email, first_name, last_name, role, is_active, first_login_completed, church_id)
        VALUES (?, ?, ?, ?, true, false, ?)
      `, [email, firstName, lastName, userRole, churchId]);

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

// Check if any users exist besides the default admin
router.get('/check-users', async (req, res) => {
  try {
    // Count all active users
    const totalUsers = await Database.query(
      'SELECT COUNT(*) as count FROM users WHERE is_active = true'
    );
    
    // Count admin users
    const adminUsers = await Database.query(
      'SELECT COUNT(*) as count FROM users WHERE role = "admin" AND is_active = true'
    );
    
    // Count non-admin users (excluding the default admin)
    const nonAdminUsers = await Database.query(
      'SELECT COUNT(*) as count FROM users WHERE role != "admin" AND is_active = true'
    );
    
    const totalCount = Number(totalUsers[0].count);
    const adminCount = Number(adminUsers[0].count);
    const nonAdminCount = Number(nonAdminUsers[0].count);
    
    res.json({
      hasUsers: totalCount > 0,
      hasNonAdminUsers: nonAdminCount > 0,
      totalUsers: totalCount,
      adminUsers: adminCount,
      nonAdminUsers: nonAdminCount
    });
  } catch (error) {
    console.error('Check users error:', error);
    res.status(500).json({ error: 'Failed to check users.' });
  }
});

// Logout - clear the auth cookie
router.post('/logout', verifyToken, (req, res) => {
  res.clearCookie('authToken', {
    httpOnly: true,
    secure: req.secure || process.env.NODE_ENV === 'production',
    sameSite: 'lax', // Use 'lax' for better iOS Safari compatibility
    path: '/'
  });
  res.json({ message: 'Logged out successfully' });
});

// Clear expired token route - helps users with expired tokens
router.post('/clear-expired-token', (req, res) => {
  try {
    // Clear the auth cookie
    res.clearCookie('authToken', {
      httpOnly: true,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax', // Use 'lax' for better iOS Safari compatibility
      path: '/'
    });
    
    res.json({ 
      message: 'Expired token cleared. Please log in again.',
      code: 'TOKEN_CLEARED'
    });
  } catch (error) {
    console.error('Clear expired token error:', error);
    res.status(500).json({ error: 'Failed to clear token.' });
  }
});

// Debug endpoint to check cookie status
router.get('/debug-cookies', (req, res) => {
  const cookies = req.cookies;
  const headers = req.headers;
  
  res.json({
    cookies: cookies,
    hasAuthToken: !!cookies.authToken,
    userAgent: headers['user-agent'],
    isIOSSafari: /iPad|iPhone|iPod/.test(headers['user-agent']) && 
                 /Safari/.test(headers['user-agent']) && 
                 !/Chrome/.test(headers['user-agent']),
    cookieHeader: headers.cookie
  });
});

module.exports = router; 