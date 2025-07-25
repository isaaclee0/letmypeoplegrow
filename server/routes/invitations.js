const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');

const Database = require('../config/database');
const { verifyToken, requireRole, auditLog } = require('../middleware/auth');
const { sendInvitationEmail } = require('../utils/email');
const { sendInvitationSMS, getChurchCountry, validatePhoneNumber, getInternationalFormat } = require('../utils/sms');

const router = express.Router();

// All routes require authentication
router.use(verifyToken);

// Send user invitation
router.post('/send',
  requireRole(['admin', 'coordinator']),
  auditLog('SEND_INVITATION'),
  [
    body('email')
      .optional()
      .if(body('email').notEmpty())
      .isEmail()
      .normalizeEmail()
      .withMessage('Valid email is required'),
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
      .withMessage('Valid role is required'),
    body('firstName')
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('First name is required'),
    body('lastName')
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Last name is required'),
    body('gatheringIds')
      .optional()
      .isArray()
      .withMessage('Gathering IDs must be an array')
  ],
  async (req, res) => {
    try {
      console.log('🔍 [INVITATION_DEBUG] Starting invitation process', {
        body: req.body,
        user: req.user.id,
        userRole: req.user.role
      });

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.log('❌ [INVITATION_DEBUG] Validation errors:', errors.array());
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, mobileNumber, primaryContactMethod, role, firstName, lastName, gatheringIds = [] } = req.body;
      
      console.log('✅ [INVITATION_DEBUG] Validation passed', {
        email,
        mobileNumber,
        primaryContactMethod,
        role,
        firstName,
        lastName,
        gatheringIds
      });

      // Validate that at least one contact method is provided
      if (!email && !mobileNumber) {
        console.log('❌ [INVITATION_DEBUG] No contact method provided');
        return res.status(400).json({ error: 'Either email or mobile number must be provided' });
      }

      // Validate that primary contact method matches available contact info
      if (primaryContactMethod === 'email' && !email) {
        console.log('❌ [INVITATION_DEBUG] Email required but not provided');
        return res.status(400).json({ error: 'Email is required when primary contact method is email' });
      }
      if (primaryContactMethod === 'sms' && !mobileNumber) {
        console.log('❌ [INVITATION_DEBUG] Mobile number required but not provided');
        return res.status(400).json({ error: 'Mobile number is required when primary contact method is SMS' });
      }

      // Check if user is coordinator and trying to create admin
      if (req.user.role === 'coordinator' && role === 'admin') {
        console.log('❌ [INVITATION_DEBUG] Coordinator trying to create admin user');
        return res.status(403).json({ error: 'Coordinators cannot create admin users' });
      }

      // Normalize mobile number if provided
      let normalizedMobile = null;
      if (mobileNumber) {
        console.log('📱 [INVITATION_DEBUG] Normalizing mobile number:', mobileNumber);
        const countryCode = await getChurchCountry();
        console.log('🌍 [INVITATION_DEBUG] Church country code:', countryCode);
        
        normalizedMobile = getInternationalFormat(mobileNumber, countryCode);
        console.log('📱 [INVITATION_DEBUG] Normalized mobile number:', normalizedMobile);
        
        if (!normalizedMobile) {
          console.log('❌ [INVITATION_DEBUG] Invalid mobile number format');
          return res.status(400).json({ 
            error: `Invalid mobile number format for ${countryCode}` 
          });
        }
      }

      // Check if user already exists with this email or mobile number
      console.log('🔍 [INVITATION_DEBUG] Checking for existing users');
      const existingUserChecks = [];
      if (email) {
        console.log('📧 [INVITATION_DEBUG] Checking for existing user with email:', email);
        existingUserChecks.push(
          Database.query('SELECT id FROM users WHERE email = ?', [email])
        );
      }
      if (normalizedMobile) {
        console.log('📱 [INVITATION_DEBUG] Checking for existing user with mobile:', normalizedMobile);
        existingUserChecks.push(
          Database.query('SELECT id FROM users WHERE mobile_number = ?', [normalizedMobile])
        );
      }

      const existingUserResults = await Promise.all(existingUserChecks);
      console.log('🔍 [INVITATION_DEBUG] Existing user check results:', existingUserResults);
      
      if (existingUserResults.some(result => result.length > 0)) {
        console.log('❌ [INVITATION_DEBUG] User already exists');
        return res.status(409).json({ error: 'User with this email or mobile number already exists' });
      }

      // Check for pending invitations
      console.log('🔍 [INVITATION_DEBUG] Checking for pending invitations');
      const existingInvitationChecks = [];
      if (email) {
        console.log('📧 [INVITATION_DEBUG] Checking for pending invitation with email:', email);
        existingInvitationChecks.push(
          Database.query('SELECT id FROM user_invitations WHERE email = ? AND accepted = false AND expires_at > NOW()', [email])
        );
      }
      if (normalizedMobile) {
        console.log('📱 [INVITATION_DEBUG] Checking for pending invitation with mobile:', normalizedMobile);
        existingInvitationChecks.push(
          Database.query('SELECT id FROM user_invitations WHERE mobile_number = ? AND accepted = false AND expires_at > NOW()', [normalizedMobile])
        );
      }

      const existingInvitationResults = await Promise.all(existingInvitationChecks);
      console.log('🔍 [INVITATION_DEBUG] Pending invitation check results:', existingInvitationResults);
      
      if (existingInvitationResults.some(result => result.length > 0)) {
        console.log('❌ [INVITATION_DEBUG] Pending invitation already exists');
        return res.status(409).json({ error: 'Invitation already sent to this contact' });
      }

      // Validate gathering access for coordinators
      if (req.user.role === 'coordinator' && gatheringIds.length > 0) {
        console.log('🔍 [INVITATION_DEBUG] Validating gathering access for coordinator');
        const userGatherings = await Database.query(
          'SELECT gathering_type_id FROM user_gathering_assignments WHERE user_id = ?',
          [req.user.id]
        );
        const userGatheringIds = userGatherings.map(g => g.gathering_type_id);
        console.log('🔍 [INVITATION_DEBUG] User gathering IDs:', userGatheringIds);
        console.log('🔍 [INVITATION_DEBUG] Requested gathering IDs:', gatheringIds);
        
        const hasInvalidGathering = gatheringIds.some(id => !userGatheringIds.includes(parseInt(id)));
        if (hasInvalidGathering) {
          console.log('❌ [INVITATION_DEBUG] Coordinator trying to assign unauthorized gatherings');
          return res.status(403).json({ error: 'Cannot assign gatherings you do not have access to' });
        }
        console.log('✅ [INVITATION_DEBUG] Gathering access validated');
      }

      console.log('💾 [INVITATION_DEBUG] Starting database transaction');
      await Database.transaction(async (conn) => {
        // Generate invitation token
        const invitationToken = uuidv4();
        const expiresAt = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');
        
        console.log('🔑 [INVITATION_DEBUG] Generated invitation token:', invitationToken);
        console.log('⏰ [INVITATION_DEBUG] Expires at:', expiresAt);

        // Create invitation
        console.log('💾 [INVITATION_DEBUG] Creating invitation record');
        const invitationResult = await conn.query(`
          INSERT INTO user_invitations (email, mobile_number, primary_contact_method, role, first_name, last_name, invited_by, invitation_token, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [email || null, normalizedMobile, primaryContactMethod, role, firstName, lastName, req.user.id, invitationToken, expiresAt]);
        
        console.log('✅ [INVITATION_DEBUG] Invitation record created with ID:', invitationResult.insertId);

        // Send invitation via appropriate method
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const invitationLink = `${protocol}://${host}/accept-invitation/${invitationToken}`;
        
        console.log('🔗 [INVITATION_DEBUG] Generated invitation link:', invitationLink);
        console.log('📤 [INVITATION_DEBUG] Sending invitation via:', primaryContactMethod);
        
        if (primaryContactMethod === 'email') {
          console.log('📧 [INVITATION_DEBUG] Sending email invitation');
          const emailResult = await sendInvitationEmail(email, firstName, lastName, role, invitationLink, req.user);
          console.log('📧 [INVITATION_DEBUG] Email invitation result:', emailResult);
        } else {
          console.log('📱 [INVITATION_DEBUG] Sending SMS invitation');
          const smsResult = await sendInvitationSMS(normalizedMobile, firstName, lastName, role, invitationLink, req.user);
          console.log('📱 [INVITATION_DEBUG] SMS invitation result:', smsResult);
        }

        // If gathering IDs are provided, store them for later assignment
        if (gatheringIds.length > 0) {
          console.log('🏛️ [INVITATION_DEBUG] Storing gathering assignments:', gatheringIds);
          await conn.query(
            'UPDATE user_invitations SET gathering_assignments = ? WHERE id = ?',
            [JSON.stringify(gatheringIds), invitationResult.insertId]
          );
          console.log('✅ [INVITATION_DEBUG] Gathering assignments stored');
        }
      });
      
      console.log('✅ [INVITATION_DEBUG] Database transaction completed successfully');

      console.log('✅ [INVITATION_DEBUG] Invitation process completed successfully');
      res.json({ 
        message: 'Invitation sent successfully',
        email: email
      });

    } catch (error) {
      console.error('❌ [INVITATION_DEBUG] Send invitation error:', error);
      console.error('❌ [INVITATION_DEBUG] Error stack:', error.stack);
      res.status(500).json({ error: 'Failed to send invitation' });
    }
  }
);

// Get pending invitations
router.get('/pending', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    let query = `
      SELECT ui.id, ui.email, ui.role, ui.first_name, ui.last_name, 
             ui.expires_at, ui.created_at,
             u.first_name as invited_by_first_name, u.last_name as invited_by_last_name
      FROM user_invitations ui
      JOIN users u ON ui.invited_by = u.id
      WHERE ui.accepted = false AND ui.expires_at > NOW()
    `;
    
    let params = [];

    // Coordinators can only see invitations they sent
    if (req.user.role === 'coordinator') {
      query += ' AND ui.invited_by = ?';
      params.push(req.user.id);
    }

    query += ' ORDER BY ui.created_at DESC';

    const invitations = await Database.query(query, params);
    res.json({ invitations });

  } catch (error) {
    console.error('Get pending invitations error:', error);
    res.status(500).json({ error: 'Failed to retrieve invitations' });
  }
});

// Resend invitation
router.post('/resend/:id',
  requireRole(['admin', 'coordinator']),
  auditLog('RESEND_INVITATION'),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Get invitation details
      const invitations = await Database.query(`
        SELECT ui.*, u.first_name as invited_by_first_name, u.last_name as invited_by_last_name
        FROM user_invitations ui
        JOIN users u ON ui.invited_by = u.id
        WHERE ui.id = ? AND ui.accepted = false
      `, [id]);

      if (invitations.length === 0) {
        return res.status(404).json({ error: 'Invitation not found or already accepted' });
      }

      const invitation = invitations[0];

      // Check if coordinator can resend this invitation
      if (req.user.role === 'coordinator' && invitation.invited_by !== req.user.id) {
        return res.status(403).json({ error: 'Cannot resend invitation you did not send' });
      }

      // Generate new token and extend expiry
      const newToken = uuidv4();
      const newExpiresAt = moment().add(7, 'days').format('YYYY-MM-DD HH:mm:ss');

      await Database.query(`
        UPDATE user_invitations 
        SET invitation_token = ?, expires_at = ?, updated_at = NOW()
        WHERE id = ?
      `, [newToken, newExpiresAt, id]);

      // Resend email
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const invitationLink = `${protocol}://${host}/accept-invitation/${newToken}`;
      await sendInvitationEmail(
        invitation.email, 
        invitation.first_name, 
        invitation.last_name, 
        invitation.role, 
        invitationLink, 
        req.user
      );

      res.json({ message: 'Invitation resent successfully' });

    } catch (error) {
      console.error('Resend invitation error:', error);
      res.status(500).json({ error: 'Failed to resend invitation' });
    }
  }
);

// Cancel invitation
router.delete('/:id',
  requireRole(['admin', 'coordinator']),
  auditLog('CANCEL_INVITATION'),
  async (req, res) => {
    try {
      const { id } = req.params;

      // Check invitation exists and permissions
      const invitations = await Database.query(
        'SELECT invited_by FROM user_invitations WHERE id = ? AND accepted = false',
        [id]
      );

      if (invitations.length === 0) {
        return res.status(404).json({ error: 'Invitation not found or already accepted' });
      }

      // Check if coordinator can cancel this invitation
      if (req.user.role === 'coordinator' && invitations[0].invited_by !== req.user.id) {
        return res.status(403).json({ error: 'Cannot cancel invitation you did not send' });
      }

      await Database.query('DELETE FROM user_invitations WHERE id = ?', [id]);

      res.json({ message: 'Invitation cancelled successfully' });

    } catch (error) {
      console.error('Cancel invitation error:', error);
      res.status(500).json({ error: 'Failed to cancel invitation' });
    }
  }
);

// Accept invitation (public endpoint)
router.get('/accept/:token', async (req, res) => {
  try {
    const { token } = req.params;

    // Validate invitation token
    const invitations = await Database.query(`
      SELECT * FROM user_invitations 
      WHERE invitation_token = ? AND accepted = false AND expires_at > NOW()
    `, [token]);

    if (invitations.length === 0) {
      return res.status(404).json({ error: 'Invalid or expired invitation' });
    }

    const invitation = invitations[0];

    // Check if user already exists (in case they were created after invitation)
    const existingUser = await Database.query(
      'SELECT id FROM users WHERE email = ?',
      [invitation.email]
    );

    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'User account already exists' });
    }

    // Return invitation details for frontend to handle
    res.json({
      invitation: {
        email: invitation.email,
        firstName: invitation.first_name,
        lastName: invitation.last_name,
        role: invitation.role,
        token: invitation.invitation_token
      }
    });

  } catch (error) {
    console.error('Accept invitation error:', error);
    res.status(500).json({ error: 'Failed to process invitation' });
  }
});

// Complete invitation (create user account)
router.post('/complete/:token',
  [
    body('gatheringAssignments')
      .optional()
      .isArray()
      .withMessage('Gathering assignments must be an array')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { token } = req.params;
      const { gatheringAssignments = [] } = req.body;

      // Validate invitation token
      const invitations = await Database.query(`
        SELECT * FROM user_invitations 
        WHERE invitation_token = ? AND accepted = false AND expires_at > NOW()
      `, [token]);

      if (invitations.length === 0) {
        return res.status(404).json({ error: 'Invalid or expired invitation' });
      }

      const invitation = invitations[0];

      await Database.transaction(async (conn) => {
        // Create user account
        const userResult = await conn.query(`
          INSERT INTO users (email, role, first_name, last_name, is_active, is_invited, first_login_completed)
          VALUES (?, ?, ?, ?, true, true, false)
        `, [
          invitation.email,
          invitation.role,
          invitation.first_name,
          invitation.last_name
        ]);

        const userId = userResult.insertId;

        // Assign gatherings
        if (gatheringAssignments.length > 0) {
          const assignmentValues = gatheringAssignments.map(gatheringId => [
            userId, gatheringId, invitation.invited_by
          ]);
          
          await conn.batch(
            'INSERT INTO user_gathering_assignments (user_id, gathering_type_id, assigned_by) VALUES (?, ?, ?)',
            assignmentValues
          );

          // Set first gathering as default if only one assigned
          if (gatheringAssignments.length === 1) {
            await conn.query(
              'UPDATE users SET default_gathering_id = ? WHERE id = ?',
              [gatheringAssignments[0], userId]
            );
          }
        }

        // Mark invitation as accepted
        await conn.query(
          'UPDATE user_invitations SET accepted = true WHERE id = ?',
          [invitation.id]
        );
      });

      res.json({ 
        message: 'Account created successfully',
        email: invitation.email
      });

    } catch (error) {
      console.error('Complete invitation error:', error);
      res.status(500).json({ error: 'Failed to complete invitation' });
    }
  }
);

module.exports = router; 