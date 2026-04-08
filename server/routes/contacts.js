const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { sendInvitationEmail } = require('../utils/email');

const router = express.Router();
router.use(verifyToken);

// GET /api/contacts — list all active contacts with assigned family count
router.get('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const contacts = await Database.query(
      `SELECT c.*,
        COUNT(fc.id) as family_count
       FROM contacts c
       LEFT JOIN family_caregivers fc ON fc.contact_id = c.id
       WHERE c.church_id = ? AND c.is_active = 1
       GROUP BY c.id
       ORDER BY c.last_name, c.first_name`,
      [req.user.church_id]
    );
    res.json({ contacts });
  } catch (error) {
    console.error('Failed to fetch contacts:', error);
    res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// POST /api/contacts — create a contact
router.post('/', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { first_name, last_name, email, mobile_number, primary_contact_method, notes } = req.body;

    if (!first_name || !last_name) {
      return res.status(400).json({ error: 'First name and last name are required' });
    }
    if (!email && !mobile_number) {
      return res.status(400).json({ error: 'At least one of email or mobile number is required' });
    }
    if (primary_contact_method && !['email', 'sms'].includes(primary_contact_method)) {
      return res.status(400).json({ error: 'primary_contact_method must be "email" or "sms"' });
    }

    const result = await Database.query(
      `INSERT INTO contacts (church_id, first_name, last_name, email, mobile_number, primary_contact_method, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.church_id,
        first_name.trim(),
        last_name.trim(),
        email?.trim() || null,
        mobile_number?.trim() || null,
        primary_contact_method || 'email',
        notes?.trim() || null,
        req.user.id,
      ]
    );
    const [contact] = await Database.query(
      `SELECT * FROM contacts WHERE id = ? AND church_id = ?`,
      [result.insertId, req.user.church_id]
    );
    res.status(201).json({ contact });
  } catch (error) {
    console.error('Failed to create contact:', error);
    res.status(500).json({ error: 'Failed to create contact' });
  }
});

// PUT /api/contacts/:id — update a contact
router.put('/:id', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, email, mobile_number, primary_contact_method, notes } = req.body;

    if (!first_name || !last_name) {
      return res.status(400).json({ error: 'First name and last name are required' });
    }
    if (primary_contact_method && !['email', 'sms'].includes(primary_contact_method)) {
      return res.status(400).json({ error: 'primary_contact_method must be "email" or "sms"' });
    }

    const [existing] = await Database.query(
      `SELECT id FROM contacts WHERE id = ? AND church_id = ?`,
      [id, req.user.church_id]
    );
    if (!existing) return res.status(404).json({ error: 'Contact not found' });

    await Database.query(
      `UPDATE contacts
       SET first_name = ?, last_name = ?, email = ?, mobile_number = ?,
           primary_contact_method = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ? AND church_id = ?`,
      [
        first_name.trim(),
        last_name.trim(),
        email?.trim() || null,
        mobile_number?.trim() || null,
        primary_contact_method || 'email',
        notes?.trim() || null,
        id,
        req.user.church_id,
      ]
    );
    const [contact] = await Database.query(
      `SELECT * FROM contacts WHERE id = ? AND church_id = ?`,
      [id, req.user.church_id]
    );
    res.json({ contact });
  } catch (error) {
    console.error('Failed to update contact:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/contacts/:id — soft-deactivate
router.delete('/:id', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    await Database.query(
      `UPDATE contacts SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
      [id, req.user.church_id]
    );
    res.json({ message: 'Contact deactivated' });
  } catch (error) {
    console.error('Failed to deactivate contact:', error);
    res.status(500).json({ error: 'Failed to deactivate contact' });
  }
});

// GET /api/contacts/:id/families — list families assigned to this contact
router.get('/:id/families', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;

    const [contact] = await Database.query(
      `SELECT id FROM contacts WHERE id = ? AND church_id = ? AND is_active = 1`,
      [id, req.user.church_id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const families = await Database.query(
      `SELECT f.id, f.family_name
       FROM families f
       JOIN family_caregivers fc ON fc.family_id = f.id
       WHERE fc.contact_id = ? AND f.church_id = ?
       ORDER BY f.family_name`,
      [id, req.user.church_id]
    );
    res.json({ families });
  } catch (error) {
    console.error('Failed to fetch contact families:', error);
    res.status(500).json({ error: 'Failed to fetch families' });
  }
});

// POST /api/contacts/:id/families/:familyId — assign contact to a family
router.post('/:id/families/:familyId', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id, familyId } = req.params;

    const [contact] = await Database.query(
      `SELECT id FROM contacts WHERE id = ? AND church_id = ? AND is_active = 1`,
      [id, req.user.church_id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const [family] = await Database.query(
      `SELECT id FROM families WHERE id = ? AND church_id = ?`,
      [familyId, req.user.church_id]
    );
    if (!family) return res.status(404).json({ error: 'Family not found' });

    try {
      await Database.query(
        `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, contact_id)
         VALUES (?, ?, 'contact', ?)`,
        [req.user.church_id, familyId, id]
      );
    } catch (uniqueErr) {
      if (!uniqueErr.message?.includes('UNIQUE constraint failed')) throw uniqueErr;
    }

    res.json({ message: 'Contact assigned to family' });
  } catch (error) {
    console.error('Failed to assign contact to family:', error);
    res.status(500).json({ error: 'Failed to assign contact to family' });
  }
});

// DELETE /api/contacts/:id/families/:familyId — remove assignment
router.delete('/:id/families/:familyId', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id, familyId } = req.params;
    await Database.query(
      `DELETE FROM family_caregivers WHERE contact_id = ? AND family_id = ? AND church_id = ?`,
      [id, familyId, req.user.church_id]
    );
    res.json({ message: 'Assignment removed' });
  } catch (error) {
    console.error('Failed to remove assignment:', error);
    res.status(500).json({ error: 'Failed to remove assignment' });
  }
});

// POST /api/contacts/:id/convert-to-user — convert a contact to a user account
router.post('/:id/convert-to-user', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!['coordinator', 'attendance_taker'].includes(role)) {
      return res.status(400).json({ error: 'Role must be "coordinator" or "attendance_taker"' });
    }

    const [contact] = await Database.query(
      `SELECT * FROM contacts WHERE id = ? AND church_id = ? AND is_active = 1`,
      [id, req.user.church_id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    if (!contact.email) {
      return res.status(400).json({
        error: 'Contact must have an email address to be converted to a user'
      });
    }

    const [existingUser] = await Database.query(
      `SELECT id FROM users WHERE email = ? AND church_id = ?`,
      [contact.email, req.user.church_id]
    );
    if (existingUser) {
      return res.status(409).json({
        error: `A user with email ${contact.email} already exists`
      });
    }

    let newUser;
    await Database.transaction(async (conn) => {
      const userResult = await conn.query(
        `INSERT INTO users (church_id, email, mobile_number, primary_contact_method, first_name, last_name, role, is_active, is_invited)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        [
          req.user.church_id,
          contact.email,
          contact.mobile_number || null,
          contact.primary_contact_method || 'email',
          contact.first_name,
          contact.last_name,
          role,
        ]
      );
      const newUserId = userResult.insertId;

      await conn.query(
        `UPDATE family_caregivers
         SET caregiver_type = 'user', user_id = ?, contact_id = NULL
         WHERE contact_id = ? AND church_id = ?`,
        [newUserId, id, req.user.church_id]
      );

      await conn.query(
        `UPDATE contacts SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [id, req.user.church_id]
      );

      const [created] = await conn.query(`SELECT * FROM users WHERE id = ?`, [newUserId]);
      newUser = created;
    });

    // Register user in registry so OTC login routing works
    Database.registerUserLookup(newUser.id, newUser.email, newUser.mobile_number || null, req.user.church_id);

    // Send invitation email outside transaction (network call)
    try {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const loginLink = `${frontendUrl}/login`;
      await sendInvitationEmail(
        newUser.email,
        newUser.first_name,
        newUser.last_name,
        newUser.role,
        loginLink,
        { first_name: req.user.first_name, last_name: req.user.last_name }
      );
    } catch (emailErr) {
      console.error('Failed to send invitation email after conversion:', emailErr);
      // Don't fail the request — user was created successfully
    }

    res.json({ user: newUser });
  } catch (error) {
    console.error('Failed to convert contact to user:', error);
    res.status(500).json({ error: 'Failed to convert contact to user' });
  }
});

module.exports = router;
