const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const moment = require('moment');
const crypto = require('crypto');

const Database = require('../config/database');
const { sendOTCEmail, sendNewChurchApprovalEmail } = require('../utils/email');
const { generateOTC, sendOTCSMS, getChurchCountry, validatePhoneNumber, getInternationalFormat, maskPhoneNumber } = require('../utils/sms');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

const isDev = process.env.NODE_ENV === 'development';
const devBypassEnabled = process.env.AUTH_DEV_BYPASS === 'true';

router.get('/', (req, res) => {
  const externalServices = {
    crazytel: !!(process.env.CRAZYTEL_API_KEY && process.env.CRAZYTEL_API_KEY.trim() && process.env.CRAZYTEL_FROM_NUMBER && process.env.CRAZYTEL_FROM_NUMBER.trim()),
    brevo: !!(process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim())
  };
  const hasExternalServices = externalServices.brevo || externalServices.crazytel;

  const payload = {
    message: 'Authentication service is running',
    status: hasExternalServices ? 'full' : 'limited',
    externalServices,
    endpoints: {
      'request-code': hasExternalServices ? 'POST - Request one-time code' : 'POST - Disabled (no external services)',
      'verify-code': hasExternalServices ? 'POST - Verify one-time code' : 'POST - Disabled (no external services)',
      'me': 'GET - Get current user info',
      'logout': 'POST - Logout user'
    },
    environment: process.env.NODE_ENV || 'development',
    development: null,
    note: !hasExternalServices ? 'Configure Crazytel and/or Brevo API keys to enable full authentication' : null
  };

  if (isDev) {
    payload.development = devBypassEnabled
      ? { note: 'Development bypass is ENABLED: use dev@church.local with code 000000', devUser: 'dev@church.local', devCode: '000000' }
      : { note: 'Development bypass is DISABLED. Full OTC flow required.' };
  }

  res.json(payload);
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 20 : 5,
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

const otcLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isDev ? 30 : 10,
  message: { error: 'Please wait before requesting another code.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

async function findUserByContact(contact, specificChurchId = null) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isEmail = emailRegex.test(contact);

  let normalizedContact = contact;
  if (!isEmail) {
    const countryCode = await getChurchCountry();
    normalizedContact = getInternationalFormat(contact, countryCode) || contact;
  }

  let churchId;
  if (specificChurchId) {
    churchId = specificChurchId;
  } else {
    const lookup = isEmail
      ? Database.lookupChurchByEmail(contact)
      : Database.lookupChurchByMobile(normalizedContact);

    if (!lookup) return { users: [], isEmail, normalizedContact, churchId: null };
    churchId = lookup.church_id;
  }

  const whereClause = isEmail ? 'email = ?' : 'mobile_number = ?';
  const users = await Database.queryForChurch(
    churchId,
    `SELECT id, email, mobile_number, primary_contact_method, role, is_active, church_id FROM users WHERE ${whereClause}`,
    [isEmail ? contact : normalizedContact]
  );

  return { users, isEmail, normalizedContact, churchId };
}

router.post('/request-code',
  otcLimiter,
  [
    body('contact')
      .trim()
      .notEmpty()
      .withMessage('Contact information is required')
      .custom(async (value) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (emailRegex.test(value)) return true;
        try {
          const countryCode = await getChurchCountry();
          if (!validatePhoneNumber(value, countryCode)) {
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

      const { contact, churchId: selectedChurchId } = req.body;
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const isEmail = emailRegex.test(contact);
      const contactType = isEmail ? 'email' : 'sms';

      let normalizedContact = contact;
      if (!isEmail) {
        const countryCode = await getChurchCountry();
        const internationalFormat = getInternationalFormat(contact, countryCode);
        if (!internationalFormat) {
          return res.status(400).json({ error: `Invalid phone number format for ${countryCode}. Please check your number and try again.` });
        }
        normalizedContact = internationalFormat;
      }

      if (!selectedChurchId) {
        const allLookups = isEmail
          ? Database.lookupAllChurchesByEmail(contact)
          : Database.lookupAllChurchesByMobile(normalizedContact);

        if (allLookups.length > 1) {
          return res.json({
            requiresChurchSelection: true,
            churches: allLookups.map(l => ({
              churchId: l.church_id,
              churchName: l.church_name
            }))
          });
        }
      }

      let { users, churchId } = await findUserByContact(
        isEmail ? contact : normalizedContact,
        selectedChurchId || null
      );

      if (users.length === 0) {
        if (isDev && devBypassEnabled && contact === 'dev@church.local') {
          console.log('🔧 Development mode: Auto-creating dev user for dev@church.local');
          try {
            let devChurchId = 'devch1';
            const churches = Database.listChurches();
            if (churches.length > 0) {
              devChurchId = churches[0].church_id;
              console.log('✅ Using existing church:', devChurchId);
            } else {
              Database.ensureChurch(devChurchId, 'Development Church');
              Database.approveChurch(devChurchId, true);
              await Database.setChurchContext(devChurchId, async () => {
                await Database.query(
                  `INSERT OR IGNORE INTO church_settings (church_name, country_code, timezone, email_from_name, email_from_address, onboarding_completed, church_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`,
                  ['Development Church', 'AU', 'Australia/Sydney', 'Let My People Grow', 'dev@church.local', 1, devChurchId]
                );
              });
            }

            await Database.setChurchContext(devChurchId, async () => {
              await Database.query(
                `INSERT INTO users (email, role, first_name, last_name, is_active, first_login_completed, church_id)
                 VALUES (?, 'admin', 'Development', 'Admin', 1, 1, ?)`,
                ['dev@church.local', devChurchId]
              );
            });

            const newUsers = await Database.queryForChurch(
              devChurchId,
              'SELECT id, email, mobile_number, primary_contact_method, role, is_active, church_id FROM users WHERE email = ?',
              ['dev@church.local']
            );

            if (newUsers.length > 0) {
              users = newUsers;
              churchId = devChurchId;
              Database.registerUserLookup(newUsers[0].id, 'dev@church.local', null, devChurchId);
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

      let finalContactMethod = contactType;
      let finalContact = normalizedContact;

      if (contactType === 'email' && user.email && user.mobile_number && user.primary_contact_method !== contactType) {
        if (user.primary_contact_method === 'email') {
          finalContactMethod = 'email';
          finalContact = user.email;
        } else if (user.primary_contact_method === 'sms') {
          finalContactMethod = 'sms';
          finalContact = user.mobile_number;
        }
      }

      await Database.queryForChurch(
        churchId || user.church_id,
        "DELETE FROM otc_codes WHERE contact_identifier = ? AND contact_type = ? AND (used = 1 OR expires_at < datetime('now'))",
        [finalContact, finalContactMethod]
      );

      const code = generateOTC();
      const expiresAt = moment().utc().add(parseInt(process.env.OTC_EXPIRE_MINUTES) || 10, 'minutes').format('YYYY-MM-DD HH:mm:ss');

      await Database.queryForChurch(
        churchId || user.church_id,
        `INSERT INTO otc_codes (contact_identifier, contact_type, code, expires_at, church_id) VALUES (?, ?, ?, ?, ?)`,
        [finalContact, finalContactMethod, code, expiresAt, user.church_id]
      );

      const externalServices = {
        crazytel: !!(process.env.CRAZYTEL_API_KEY && process.env.CRAZYTEL_API_KEY.trim() && process.env.CRAZYTEL_FROM_NUMBER && process.env.CRAZYTEL_FROM_NUMBER.trim()),
        brevo: !!(process.env.BREVO_API_KEY && process.env.BREVO_API_KEY.trim())
      };

      const hasRequiredService = (finalContactMethod === 'email' && externalServices.brevo) ||
                                (finalContactMethod === 'sms' && externalServices.crazytel);

      if (!hasRequiredService) {
        if (process.env.NODE_ENV === 'development') {
          console.log(`⚠️  Development mode: ${finalContactMethod.toUpperCase()} service not configured, but proceeding with code generation`);
        } else {
          return res.status(503).json({
            error: 'Service temporarily unavailable',
            message: `${finalContactMethod.toUpperCase()} service is not configured`,
            externalServices,
            note: 'Configure external services to enable authentication'
          });
        }
      }

      setImmediate(async () => {
        try {
          if (finalContactMethod === 'email') {
            if (externalServices.brevo) {
              await sendOTCEmail(finalContact, code);
            } else {
              console.log(`📧 Development mode: Email code sent for ${finalContact ? finalContact.substring(0, 3) + '***' : 'unknown'} (Brevo not configured)`);
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
      if (isDev && devBypassEnabled) {
        responsePayload.devCode = code;
      }
      res.json(responsePayload);

    } catch (error) {
      console.error('Request code error:', error);
      res.status(500).json({ error: 'Failed to send verification code.' });
    }
  }
);

router.post('/verify-code',
  authLimiter,
  [
    body('contact').trim().notEmpty().withMessage('Contact information is required'),
    body('code').isLength({ min: 6, max: 6 }).isNumeric().withMessage('Code must be 6 digits')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { contact, code, churchId: selectedChurchId } = req.body;
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const isEmail = emailRegex.test(contact);
      const contactType = isEmail ? 'email' : 'sms';

      let normalizedContact = contact;
      if (!isEmail) {
        const countryCode = await getChurchCountry();
        const internationalFormat = getInternationalFormat(contact, countryCode);
        if (!internationalFormat) {
          return res.status(401).json({ error: 'Invalid phone number format' });
        }
        normalizedContact = internationalFormat;
      }

      const searchResult = await findUserByContact(
        isEmail ? contact : normalizedContact,
        selectedChurchId || null
      );
      const { users, churchId } = searchResult;

      if (users.length === 0) {
        return res.status(404).json({ error: 'No user found with this email address.', code: 'USER_NOT_FOUND' });
      }
      if (!users[0].is_active) {
        return res.status(401).json({ error: 'Account is deactivated. Please contact your administrator.' });
      }

      const user = users[0];
      const userChurchId = churchId || user.church_id;

      let validOtcRecord = null;
      if (isDev && devBypassEnabled && user.email === 'dev@church.local' && code === '000000') {
        console.log('🔓 Development bypass: Accepting "000000" for dev@church.local');
        validOtcRecord = { id: 'dev-bypass' };
      } else {
        const otcRecords = await Database.queryForChurch(
          userChurchId,
          `SELECT id, contact_identifier, contact_type FROM otc_codes
           WHERE contact_identifier = ? AND contact_type = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
           ORDER BY created_at DESC LIMIT 1`,
          [normalizedContact, contactType, code]
        );

        if (otcRecords.length > 0) {
          validOtcRecord = otcRecords[0];
        } else if (user.email && user.mobile_number) {
          const altContactType = contactType === 'email' ? 'sms' : 'email';
          const altContact = contactType === 'email' ? user.mobile_number : user.email;

          const altOtcRecords = await Database.queryForChurch(
            userChurchId,
            `SELECT id, contact_identifier, contact_type FROM otc_codes
             WHERE contact_identifier = ? AND contact_type = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
             ORDER BY created_at DESC LIMIT 1`,
            [altContact, altContactType, code]
          );
          if (altOtcRecords.length > 0) {
            validOtcRecord = altOtcRecords[0];
          }
        }
      }

      if (!validOtcRecord) {
        return res.status(401).json({ error: 'Invalid or expired verification code.' });
      }

      if (validOtcRecord.id !== 'dev-bypass') {
        await Database.queryForChurch(userChurchId, 'UPDATE otc_codes SET used = 1 WHERE id = ?', [validOtcRecord.id]);
      }

      const cleanupTasks = [];
      if (user.email) {
        cleanupTasks.push(Database.queryForChurch(
          userChurchId,
          "DELETE FROM otc_codes WHERE contact_identifier = ? AND contact_type = ? AND (used = 1 OR expires_at < datetime('now'))",
          [user.email, 'email']
        ));
      }
      if (user.mobile_number) {
        cleanupTasks.push(Database.queryForChurch(
          userChurchId,
          "DELETE FROM otc_codes WHERE contact_identifier = ? AND contact_type = ? AND (used = 1 OR expires_at < datetime('now'))",
          [user.mobile_number, 'sms']
        ));
      }
      await Promise.all(cleanupTasks);

      const fullUsers = await Database.queryForChurch(
        userChurchId,
        'SELECT id, email, mobile_number, primary_contact_method, role, first_name, last_name, is_active, first_login_completed, default_gathering_id, church_id FROM users WHERE id = ?',
        [user.id]
      );
      const fullUser = fullUsers[0];

      const token = jwt.sign(
        { userId: fullUser.id, email: fullUser.email, mobile: fullUser.mobile_number, role: fullUser.role, churchId: fullUser.church_id },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRE || '30d' }
      );

      const cookieOptions = {
        httpOnly: true,
        secure: req.secure || process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/'
      };
      if (process.env.COOKIE_DOMAIN) cookieOptions.domain = process.env.COOKIE_DOMAIN;
      res.cookie('authToken', token, cookieOptions);

      try {
        await Database.queryForChurch(userChurchId, "UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [fullUser.id]);
      } catch (e) {
        console.warn('⚠️  Failed to update last_login_at:', e.message);
      }

      const assignments = await Database.queryForChurch(
        userChurchId,
        `SELECT gt.id, gt.name, gt.description
         FROM user_gathering_assignments uga
         JOIN gathering_types gt ON uga.gathering_type_id = gt.id
         WHERE uga.user_id = ? AND gt.is_active = 1
         ORDER BY gt.name`,
        [fullUser.id]
      );

      const assignmentsWithNumbers = assignments.map(a => ({ ...a, id: Number(a.id) }));

      if (!fullUser.first_login_completed) {
        if (assignments.length > 0 || fullUser.role === 'admin') {
          await Database.queryForChurch(userChurchId, 'UPDATE users SET first_login_completed = 1 WHERE id = ?', [fullUser.id]);
        }
      }

      const isFirstLogin = !fullUser.first_login_completed && (assignments.length === 0 || fullUser.role !== 'admin');

      Database.registerUserLookup(fullUser.id, fullUser.email, fullUser.mobile_number, fullUser.church_id);

      res.json({
        message: 'Login successful',
        user: {
          id: fullUser.id,
          email: fullUser.email,
          mobileNumber: fullUser.mobile_number,
          primaryContactMethod: fullUser.primary_contact_method,
          role: fullUser.role,
          firstName: fullUser.first_name,
          lastName: fullUser.last_name,
          church_id: fullUser.church_id,
          isChurchApproved: Database.isChurchApproved(fullUser.church_id),
          isFirstLogin,
          defaultGatheringId: fullUser.default_gathering_id,
          gatheringAssignments: assignmentsWithNumbers
        }
      });

    } catch (error) {
      console.error('Verify code error:', error);
      res.status(500).json({ error: 'Login failed.' });
    }
  }
);

router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = req.user;

    const assignments = await Database.query(
      `SELECT gt.id, gt.name, gt.description
       FROM user_gathering_assignments uga
       JOIN gathering_types gt ON uga.gathering_type_id = gt.id
       WHERE uga.user_id = ? AND gt.is_active = 1
       ORDER BY gt.name`,
      [user.id]
    );
    const assignmentsWithNumbers = assignments.map(a => ({ ...a, id: Number(a.id) }));

    const notificationCount = await Database.query(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [user.id]
    );

    const churchSettings = await Database.query(
      'SELECT has_sample_data FROM church_settings WHERE church_id = ? LIMIT 1',
      [user.church_id]
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        mobileNumber: user.mobile_number,
        primaryContactMethod: user.primary_contact_method || 'email',
        role: user.role,
        firstName: user.first_name,
        lastName: user.last_name,
        church_id: user.church_id,
        isChurchApproved: Database.isChurchApproved(user.church_id),
        isFirstLogin: !user.first_login_completed,
        defaultGatheringId: user.default_gathering_id,
        gatheringAssignments: assignmentsWithNumbers,
        unreadNotifications: Number(notificationCount[0].count),
        hasSampleData: !!(churchSettings.length && churchSettings[0].has_sample_data)
      }
    });
  } catch (error) {
    console.error('Get user info error:', error);
    res.status(500).json({ error: 'Failed to get user information.' });
  }
});

const refreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: isDev ? 50 : 10,
  message: { error: 'Too many token refresh attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true
});

router.post('/refresh', verifyToken, authLimiter, refreshLimiter, async (req, res) => {
  try {
    const user = req.user;
    if (!user.is_active) {
      return res.status(401).json({ error: 'User account is inactive.', code: 'USER_INACTIVE' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role, churchId: user.church_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '30d' }
    );

    const cookieOptions = {
      httpOnly: true,
      secure: req.secure || process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/'
    };
    if (process.env.COOKIE_DOMAIN) cookieOptions.domain = process.env.COOKIE_DOMAIN;
    res.cookie('authToken', token, cookieOptions);

    res.json({
      message: 'Token refreshed successfully',
      user: { id: user.id, email: user.email, role: user.role, firstName: user.first_name, lastName: user.last_name }
    });
  } catch (error) {
    console.error('💥 Refresh token error:', error);
    res.status(500).json({ error: 'Failed to refresh token.', code: 'REFRESH_FAILED' });
  }
});

router.post('/set-default-gathering',
  verifyToken,
  [body('gatheringId').isInt().withMessage('Valid gathering ID is required')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { gatheringId } = req.body;
      const assignments = await Database.query(
        'SELECT id FROM user_gathering_assignments WHERE user_id = ? AND gathering_type_id = ?',
        [req.user.id, gatheringId]
      );
      if (assignments.length === 0) {
        return res.status(403).json({ error: 'You do not have access to this gathering' });
      }

      await Database.query('UPDATE users SET default_gathering_id = ? WHERE id = ?', [gatheringId, req.user.id]);
      res.json({ message: 'Default gathering updated successfully' });
    } catch (error) {
      console.error('Set default gathering error:', error);
      res.status(500).json({ error: 'Failed to set default gathering' });
    }
  }
);

router.post('/register',
  [
    body('email').isEmail().withMessage('Valid email address is required'),
    body('firstName').trim().isLength({ min: 1, max: 100 }).withMessage('First name is required (max 100 characters)'),
    body('lastName').trim().isLength({ min: 1, max: 100 }).withMessage('Last name is required (max 100 characters)'),
    body('role').optional().isIn(['admin', 'attendance_taker', 'coordinator']).withMessage('Role must be either admin, attendance_taker, or coordinator')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

      const { email, firstName, lastName, role, churchName } = req.body;
      const userRole = role || 'admin';

      const existingLookup = Database.lookupChurchByEmail(email);
      if (existingLookup) {
        return res.status(409).json({ error: 'A user with this email address already exists.' });
      }

      const { getOrCreateChurchId } = require('../utils/churchIdGenerator');
      const churchId = await getOrCreateChurchId(churchName || 'New Church');

      let userId;
      await Database.setChurchContext(churchId, async () => {
        const result = await Database.query(
          `INSERT INTO users (email, first_name, last_name, role, is_active, first_login_completed, church_id)
           VALUES (?, ?, ?, ?, 1, 0, ?)`,
          [email, firstName, lastName, userRole, churchId]
        );
        userId = result.insertId;
      });

      Database.registerUserLookup(userId, email, null, churchId);

      const code = generateOTC();
      const expiresAt = moment().utc().add(parseInt(process.env.OTC_EXPIRE_MINUTES) || 10, 'minutes').format('YYYY-MM-DD HH:mm:ss');

      await Database.queryForChurch(
        churchId,
        `INSERT INTO otc_codes (contact_identifier, contact_type, code, expires_at, church_id) VALUES (?, 'email', ?, ?, ?)`,
        [email, code, expiresAt, churchId]
      );

      setImmediate(async () => {
        try { await sendOTCEmail(email, code); }
        catch (error) { console.error('Failed to send welcome email:', error); }

        // Notify app admin that a new church needs approval
        try {
          await sendNewChurchApprovalEmail(
            churchName || 'New Church',
            churchId,
            `${firstName} ${lastName}`,
            email
          );
        } catch (error) {
          console.error('Failed to send church approval notification:', error);
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

router.get('/check-users', async (req, res) => {
  try {
    const churches = Database.listChurches();
    let totalCount = 0, adminCount = 0, nonAdminCount = 0;

    for (const church of churches) {
      const total = await Database.queryForChurch(church.church_id, 'SELECT COUNT(*) as count FROM users WHERE is_active = 1');
      const admins = await Database.queryForChurch(church.church_id, "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1");
      const nonAdmins = await Database.queryForChurch(church.church_id, "SELECT COUNT(*) as count FROM users WHERE role != 'admin' AND is_active = 1");
      totalCount += Number(total[0].count);
      adminCount += Number(admins[0].count);
      nonAdminCount += Number(nonAdmins[0].count);
    }

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

router.post('/logout', verifyToken, (req, res) => {
  res.clearCookie('authToken', { httpOnly: true, secure: req.secure || process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
  res.json({ message: 'Logged out successfully' });
});

router.post('/clear-expired-token', (req, res) => {
  try {
    res.clearCookie('authToken', { httpOnly: true, secure: req.secure || process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
    res.json({ message: 'Expired token cleared. Please log in again.', code: 'TOKEN_CLEARED' });
  } catch (error) {
    console.error('Clear expired token error:', error);
    res.status(500).json({ error: 'Failed to clear token.' });
  }
});

router.get('/debug-cookies', (req, res) => {
  res.json({
    cookies: req.cookies,
    hasAuthToken: !!req.cookies.authToken,
    userAgent: req.headers['user-agent'],
    isIOSSafari: /iPad|iPhone|iPod/.test(req.headers['user-agent']) && /Safari/.test(req.headers['user-agent']) && !/Chrome/.test(req.headers['user-agent']),
    cookieHeader: req.headers.cookie
  });
});

router.get('/server-time', (req, res) => {
  res.json({ serverTime: Date.now(), iso: new Date().toISOString() });
});

module.exports = router;
