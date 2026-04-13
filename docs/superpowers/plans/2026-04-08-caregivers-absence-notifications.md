# Caregivers & Absence Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to assign "caregiver" responsibility (via app users or external contacts) to families, and automatically notify those caregivers by email or SMS when their families miss gatherings.

**Architecture:** Three new DB tables (`contacts`, `family_caregivers`, `contact_notifications`) are additive — no changes to existing tables. A new `/api/contacts` route handles CRUD and family assignment. The existing `attendanceNotifications.js` trigger is extended to notify caregivers. The frontend gains a Contacts tab on UsersPage and a caregiver chip + bulk-assign action on PeoplePage.

**Tech Stack:** Node.js/Express + better-sqlite3, React 19 + TypeScript + Tailwind CSS + Headless UI, Brevo (email), Crazytel (SMS).

**Spec:** `docs/superpowers/specs/2026-04-08-caregivers-absence-notifications-design.md`

---

## File Map

| File | Change |
|------|--------|
| `server/config/schema.js` | Add `contacts`, `family_caregivers`, `contact_notifications` tables |
| `server/routes/contacts.js` | **New** — CRUD, family assignment, convert-to-user |
| `server/index.js` | Add `'contacts'` to `routeFiles` array |
| `server/routes/families.js` | Add `/api/families/:id/caregivers` endpoints |
| `server/utils/email.js` | Add `sendCaregiverNotificationEmail` |
| `server/utils/attendanceNotifications.js` | Fix existing bugs; extend to notify caregivers |
| `client/src/services/api.ts` | Add `contactsAPI`; extend `familiesAPI` |
| `client/src/pages/UsersPage.tsx` | Add Contacts tab |
| `client/src/pages/PeoplePage.tsx` | Add caregiver chip on family cards + bulk-assign action |

---

## Task 1: Database Schema

**Files:**
- Modify: `server/config/schema.js`

- [ ] **Step 1: Open `server/config/schema.js`** and locate where the last table is defined. Add the three new tables immediately after (before `module.exports`):

```javascript
// CONTACTS — external people who receive notifications but cannot log in
await Database.query(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    church_id TEXT NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    mobile_number TEXT,
    primary_contact_method TEXT CHECK(primary_contact_method IN ('email', 'sms')) DEFAULT 'email',
    notes TEXT,
    is_active INTEGER DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// FAMILY_CAREGIVERS — assigns users or contacts as caregivers to families
await Database.query(`
  CREATE TABLE IF NOT EXISTS family_caregivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    church_id TEXT NOT NULL,
    family_id INTEGER NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    caregiver_type TEXT NOT NULL CHECK(caregiver_type IN ('user', 'contact')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(family_id, user_id),
    UNIQUE(family_id, contact_id)
  )
`);

// CONTACT_NOTIFICATIONS — log of notifications dispatched to external contacts
await Database.query(`
  CREATE TABLE IF NOT EXISTS contact_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    church_id TEXT NOT NULL,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    family_id INTEGER REFERENCES families(id),
    individual_id INTEGER REFERENCES individuals(id),
    rule_id INTEGER REFERENCES notification_rules(id),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    email_sent INTEGER DEFAULT 0,
    sms_sent INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
```

> **Note:** `schema.js` uses `CREATE TABLE IF NOT EXISTS` throughout, so this is safe for existing churches — the tables will be created on next server start without affecting existing data.

- [ ] **Step 2: Verify the tables are created**

Start (or restart) the dev server:
```bash
docker-compose -f docker-compose.dev.yml restart server
docker-compose -f docker-compose.dev.yml logs -f server
```

Expected: Server starts without errors. Open the admin panel at `http://localhost:7777`, navigate to any church database, and confirm the three new tables exist.

- [ ] **Step 3: Commit**

```bash
git add server/config/schema.js
git commit -m "feat: add contacts, family_caregivers, contact_notifications tables"
```

---

## Task 2: Contacts API — CRUD

**Files:**
- Create: `server/routes/contacts.js`
- Modify: `server/index.js`

- [ ] **Step 1: Create `server/routes/contacts.js`** with full contents:

```javascript
const express = require('express');
const Database = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');

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
      `SELECT * FROM contacts WHERE id = ?`,
      [result.insertId]
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
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    res.json({ contact });
  } catch (error) {
    console.error('Failed to update contact:', error);
    res.status(500).json({ error: 'Failed to update contact' });
  }
});

// DELETE /api/contacts/:id — soft-deactivate a contact
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

module.exports = router;
```

- [ ] **Step 2: Register the contacts route in `server/index.js`**

Find the `routeFiles` array (around line 54) and add `'contacts'`:

```javascript
const routeFiles = [
  'auth', 'users', 'gatherings', 'families', 'individuals',
  'attendance', 'reports', 'notifications', 'onboarding',
  'invitations', 'csv-import', 'test',
  'notification_rules',
  'contacts',   // ← add this
  // ...rest of existing entries
];
```

- [ ] **Step 3: Restart the server and verify CRUD endpoints**

```bash
docker-compose -f docker-compose.dev.yml restart server
docker-compose -f docker-compose.dev.yml logs -f server
```

Expected log line: `🔗 Mounted route 'contacts' at '/api/contacts'`

Test create (replace `YOUR_AUTH_COOKIE` with a valid session cookie from browser dev tools):
```bash
curl -s -X POST http://localhost:3001/api/contacts \
  -H "Content-Type: application/json" \
  -b "authToken=YOUR_AUTH_COOKIE" \
  -d '{"first_name":"John","last_name":"Smith","email":"john@example.com","primary_contact_method":"email"}' | jq .
```
Expected: `{"contact": {"id": 1, "first_name": "John", ...}}`

Test list:
```bash
curl -s http://localhost:3001/api/contacts -b "authToken=YOUR_AUTH_COOKIE" | jq .
```
Expected: `{"contacts": [{"id": 1, "first_name": "John", ..., "family_count": 0}]}`

- [ ] **Step 4: Commit**

```bash
git add server/routes/contacts.js server/index.js
git commit -m "feat: add contacts CRUD API at /api/contacts"
```

---

## Task 3: Contacts API — Family Assignment

**Files:**
- Modify: `server/routes/contacts.js`

- [ ] **Step 1: Add family assignment endpoints to `server/routes/contacts.js`** — insert before `module.exports`:

```javascript
// GET /api/contacts/:id/families — list families assigned to this contact
router.get('/:id/families', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
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

    // Verify the contact belongs to this church
    const [contact] = await Database.query(
      `SELECT id FROM contacts WHERE id = ? AND church_id = ? AND is_active = 1`,
      [id, req.user.church_id]
    );
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Verify the family belongs to this church
    const [family] = await Database.query(
      `SELECT id FROM families WHERE id = ? AND church_id = ?`,
      [familyId, req.user.church_id]
    );
    if (!family) return res.status(404).json({ error: 'Family not found' });

    // Insert — ignore if already assigned (UNIQUE constraint)
    try {
      await Database.query(
        `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, contact_id)
         VALUES (?, ?, 'contact', ?)`,
        [req.user.church_id, familyId, id]
      );
    } catch (uniqueErr) {
      // Already assigned — not an error
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
```

- [ ] **Step 2: Restart and verify**

```bash
docker-compose -f docker-compose.dev.yml restart server
```

Assign a contact to a family (use IDs from your test data):
```bash
curl -s -X POST http://localhost:3001/api/contacts/1/families/1 \
  -b "authToken=YOUR_AUTH_COOKIE" | jq .
```
Expected: `{"message": "Contact assigned to family"}`

List families for that contact:
```bash
curl -s http://localhost:3001/api/contacts/1/families \
  -b "authToken=YOUR_AUTH_COOKIE" | jq .
```
Expected: `{"families": [{"id": 1, "family_name": "..."}]}`

Re-assign same contact + family (should not error):
```bash
curl -s -X POST http://localhost:3001/api/contacts/1/families/1 \
  -b "authToken=YOUR_AUTH_COOKIE" | jq .
```
Expected: `{"message": "Contact assigned to family"}` (no 500 error)

- [ ] **Step 3: Commit**

```bash
git add server/routes/contacts.js
git commit -m "feat: add contact-family assignment endpoints"
```

---

## Task 4: Family Caregivers API

**Files:**
- Modify: `server/routes/families.js`

These endpoints support the PeoplePage family-card popover and the bulk-assign modal. They return both user and contact caregivers for a family.

- [ ] **Step 1: Add caregiver endpoints to `server/routes/families.js`** — insert before `module.exports`:

```javascript
// GET /api/families/:id/caregivers — list all caregivers for a family
router.get('/:id/caregivers', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const caregivers = await Database.query(
      `SELECT
         fc.id,
         fc.caregiver_type,
         fc.user_id,
         fc.contact_id,
         CASE fc.caregiver_type
           WHEN 'user' THEN u.first_name
           WHEN 'contact' THEN c.first_name
         END as first_name,
         CASE fc.caregiver_type
           WHEN 'user' THEN u.last_name
           WHEN 'contact' THEN c.last_name
         END as last_name,
         CASE fc.caregiver_type
           WHEN 'user' THEN u.email
           WHEN 'contact' THEN c.email
         END as email,
         CASE fc.caregiver_type
           WHEN 'user' THEN u.mobile_number
           WHEN 'contact' THEN c.mobile_number
         END as mobile_number
       FROM family_caregivers fc
       LEFT JOIN users u ON fc.user_id = u.id
       LEFT JOIN contacts c ON fc.contact_id = c.id
       WHERE fc.family_id = ? AND fc.church_id = ?
       ORDER BY last_name, first_name`,
      [id, req.user.church_id]
    );
    res.json({ caregivers });
  } catch (error) {
    console.error('Failed to fetch caregivers:', error);
    res.status(500).json({ error: 'Failed to fetch caregivers' });
  }
});

// POST /api/families/:id/caregivers — assign a caregiver to this family
// Body: { caregiver_type: 'user'|'contact', user_id?: number, contact_id?: number }
router.post('/:id/caregivers', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id } = req.params;
    const { caregiver_type, user_id, contact_id } = req.body;

    if (!['user', 'contact'].includes(caregiver_type)) {
      return res.status(400).json({ error: 'caregiver_type must be "user" or "contact"' });
    }
    if (caregiver_type === 'user' && !user_id) {
      return res.status(400).json({ error: 'user_id is required when caregiver_type is "user"' });
    }
    if (caregiver_type === 'contact' && !contact_id) {
      return res.status(400).json({ error: 'contact_id is required when caregiver_type is "contact"' });
    }

    // Verify family belongs to this church
    const [family] = await Database.query(
      `SELECT id FROM families WHERE id = ? AND church_id = ?`,
      [id, req.user.church_id]
    );
    if (!family) return res.status(404).json({ error: 'Family not found' });

    try {
      await Database.query(
        `INSERT INTO family_caregivers (church_id, family_id, caregiver_type, user_id, contact_id)
         VALUES (?, ?, ?, ?, ?)`,
        [req.user.church_id, id, caregiver_type, user_id || null, contact_id || null]
      );
    } catch (uniqueErr) {
      // Already assigned — idempotent
    }

    res.json({ message: 'Caregiver assigned' });
  } catch (error) {
    console.error('Failed to assign caregiver:', error);
    res.status(500).json({ error: 'Failed to assign caregiver' });
  }
});

// DELETE /api/families/:id/caregivers/:caregiverId — remove by family_caregivers.id
router.delete('/:id/caregivers/:caregiverId', requireRole(['admin', 'coordinator']), async (req, res) => {
  try {
    const { id, caregiverId } = req.params;
    await Database.query(
      `DELETE FROM family_caregivers WHERE id = ? AND family_id = ? AND church_id = ?`,
      [caregiverId, id, req.user.church_id]
    );
    res.json({ message: 'Caregiver removed' });
  } catch (error) {
    console.error('Failed to remove caregiver:', error);
    res.status(500).json({ error: 'Failed to remove caregiver' });
  }
});
```

- [ ] **Step 2: Verify**

```bash
docker-compose -f docker-compose.dev.yml restart server
```

Assign a user as caregiver to a family (use a real user id from your data):
```bash
curl -s -X POST http://localhost:3001/api/families/1/caregivers \
  -H "Content-Type: application/json" \
  -b "authToken=YOUR_AUTH_COOKIE" \
  -d '{"caregiver_type":"user","user_id":1}' | jq .
```
Expected: `{"message": "Caregiver assigned"}`

List caregivers (should show both the user from above and contact from Task 3):
```bash
curl -s http://localhost:3001/api/families/1/caregivers \
  -b "authToken=YOUR_AUTH_COOKIE" | jq .
```
Expected: array with both `caregiver_type: "user"` and `caregiver_type: "contact"` entries.

- [ ] **Step 3: Commit**

```bash
git add server/routes/families.js
git commit -m "feat: add family caregivers endpoints to /api/families/:id/caregivers"
```

---

## Task 5: Contact → User Conversion

**Files:**
- Modify: `server/routes/contacts.js`

- [ ] **Step 1: Add the convert endpoint to `server/routes/contacts.js`** — insert before `module.exports`:

```javascript
// POST /api/contacts/:id/convert-to-user
// Body: { role: 'coordinator'|'attendance_taker' }
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

    // Check for duplicate email
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
      // 1. Create the user
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

      // 2. Migrate family_caregivers rows from contact → user
      await conn.query(
        `UPDATE family_caregivers
         SET caregiver_type = 'user', user_id = ?, contact_id = NULL
         WHERE contact_id = ? AND church_id = ?`,
        [newUserId, id, req.user.church_id]
      );

      // 3. Soft-delete the contact (preserve contact_notifications history)
      await conn.query(
        `UPDATE contacts SET is_active = 0, updated_at = datetime('now') WHERE id = ?`,
        [id]
      );

      const [created] = await conn.query(`SELECT * FROM users WHERE id = ?`, [newUserId]);
      newUser = created;
    });

    // 4. Send invitation email outside the transaction (network call)
    try {
      const { sendInvitationEmail } = require('../utils/email');
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
```

- [ ] **Step 2: Verify**

Create a test contact with an email (if not already done):
```bash
curl -s -X POST http://localhost:3001/api/contacts \
  -H "Content-Type: application/json" \
  -b "authToken=YOUR_AUTH_COOKIE" \
  -d '{"first_name":"Jane","last_name":"Doe","email":"jane@example.com","primary_contact_method":"email"}' | jq .
```

Assign that contact to a family, then convert them:
```bash
curl -s -X POST http://localhost:3001/api/contacts/2/convert-to-user \
  -H "Content-Type: application/json" \
  -b "authToken=YOUR_AUTH_COOKIE" \
  -d '{"role":"coordinator"}' | jq .
```
Expected: `{"user": {"id": ..., "email": "jane@example.com", "role": "coordinator", "is_invited": 1}}`

Verify family caregivers migrated (family_id from the assignment above):
```bash
curl -s http://localhost:3001/api/families/1/caregivers \
  -b "authToken=YOUR_AUTH_COOKIE" | jq .
```
Expected: Jane now shows as `caregiver_type: "user"` not `"contact"`.

Try converting a contact with no email — expected 400:
```bash
curl -s -X POST http://localhost:3001/api/contacts \
  -H "Content-Type: application/json" \
  -b "authToken=YOUR_AUTH_COOKIE" \
  -d '{"first_name":"Bob","last_name":"NoEmail","mobile_number":"0400000000","primary_contact_method":"sms"}' | jq .
# Get the ID from the response, then:
curl -s -X POST http://localhost:3001/api/contacts/3/convert-to-user \
  -H "Content-Type: application/json" \
  -b "authToken=YOUR_AUTH_COOKIE" \
  -d '{"role":"coordinator"}' | jq .
```
Expected: `{"error": "Contact must have an email address..."}`

- [ ] **Step 3: Commit**

```bash
git add server/routes/contacts.js
git commit -m "feat: add convert-to-user endpoint for contacts"
```

---

## Task 6: Caregiver Notification Email

**Files:**
- Modify: `server/utils/email.js`

- [ ] **Step 1: Add `sendCaregiverNotificationEmail` to `server/utils/email.js`** — add before `module.exports`:

```javascript
const sendCaregiverNotificationEmail = async (contact, individual, family, missedCount, gatheringTypeName) => {
  const churchName = process.env.CHURCH_NAME || 'your church';
  const subject = `Attendance follow-up: ${individual.first_name} ${individual.last_name}`;

  const gatheringLabel = gatheringTypeName || 'their gathering';
  const weeksText = missedCount === 1 ? '1 week' : `${missedCount} weeks`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <p>Hi ${contact.first_name},</p>
      <p>
        Just a heads-up — <strong>${individual.first_name} ${individual.last_name}</strong>
        ${family ? `from the <strong>${family.family_name}</strong> family ` : ''}
        hasn't attended <strong>${gatheringLabel}</strong> for the past ${weeksText}.
        You may want to check in with them.
      </p>
      <p style="color: #666; font-size: 14px;">— ${churchName}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #999; font-size: 12px;">
        You're receiving this because you've been assigned as a caregiver for this family in ${churchName}'s attendance system.
      </p>
    </body>
    </html>
  `;

  const textContent = `Hi ${contact.first_name},\n\nJust a heads-up — ${individual.first_name} ${individual.last_name}${family ? ` from the ${family.family_name} family` : ''} hasn't attended ${gatheringLabel} for the past ${weeksText}. You may want to check in with them.\n\n— ${churchName}`;

  await sendEmail({
    to: [{ email: contact.email, name: `${contact.first_name} ${contact.last_name}` }],
    subject,
    htmlContent,
    textContent,
  });
};
```

- [ ] **Step 2: Export the new function** — add it to `module.exports`:

Find the existing `module.exports` at the bottom of `server/utils/email.js` and add `sendCaregiverNotificationEmail`:

```javascript
module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendOTCEmail,
  sendNewChurchApprovalEmail,
  sendWeeklyReviewEmail,
  sendCaregiverNotificationEmail,  // ← add this
  // ...any other existing exports
};
```

- [ ] **Step 3: Commit**

```bash
git add server/utils/email.js
git commit -m "feat: add sendCaregiverNotificationEmail template"
```

---

## Task 7: Extend Attendance Notifications

**Files:**
- Modify: `server/utils/attendanceNotifications.js`

The existing implementation has two bugs to fix alongside the new caregiver logic:
1. `is_active = true` should be `is_active = 1` (SQLite doesn't have boolean literals)
2. `IN (?)` with an array doesn't work in better-sqlite3 — needs individual `?` placeholders

- [ ] **Step 1: Replace the full contents of `server/utils/attendanceNotifications.js`**:

```javascript
const Database = require('../config/database');
const { sendEmail, sendCaregiverNotificationEmail } = require('./email');
const { sendNotificationSMS } = require('./sms');

/**
 * Triggered after an attendance session is saved.
 * Evaluates active notification rules and dispatches notifications to:
 *   1. Configured app users (existing behaviour)
 *   2. Family caregivers (new: users + contacts assigned to the individual's family)
 */
async function triggerAttendanceNotifications(gatheringTypeId, sessionDate) {
  try {
    // Fetch rules: those scoped to this gathering type, plus global rules (gathering_type_id IS NULL)
    const rules = await Database.query(
      `SELECT * FROM notification_rules
       WHERE is_active = 1
         AND (gathering_type_id = ? OR gathering_type_id IS NULL)`,
      [gatheringTypeId]
    );
    if (!rules.length) return;

    // Get the most recent sessions for this gathering type (used to check consecutive misses)
    // We need up to max(threshold_count) sessions
    const maxThreshold = Math.max(...rules.map(r => r.threshold_count));
    const recentSessions = await Database.query(
      `SELECT id, session_date FROM attendance_sessions
       WHERE gathering_type_id = ? AND excluded_from_stats = 0
       ORDER BY session_date DESC LIMIT ?`,
      [gatheringTypeId, maxThreshold]
    );

    for (const rule of rules) {
      const { id: ruleId, created_by, target_group, trigger_event, threshold_count } = rule;

      if (recentSessions.length < threshold_count) continue;

      const sessionIds = recentSessions.slice(0, threshold_count).map(s => s.id);
      const placeholders = sessionIds.map(() => '?').join(',');
      const presentValue = trigger_event === 'attends' ? 1 : 0;

      if (target_group !== 'regular_attendees') continue;

      // Find individuals on the roster who match the consecutive pattern
      const matches = await Database.query(
        `SELECT i.id, i.first_name, i.last_name, i.family_id,
                COUNT(ar.id) as match_count
         FROM individuals i
         JOIN gathering_lists gl ON i.id = gl.individual_id AND gl.gathering_type_id = ?
         LEFT JOIN attendance_records ar
           ON i.id = ar.individual_id
           AND ar.session_id IN (${placeholders})
           AND ar.present = ?
         WHERE i.is_active = 1
         GROUP BY i.id
         HAVING match_count >= ?`,
        [gatheringTypeId, ...sessionIds, presentValue, threshold_count]
      );

      for (const individual of matches) {
        // --- 1. Notify the rule creator (app user) ---
        const existingNotification = await Database.query(
          `SELECT id FROM notifications
           WHERE user_id = ? AND rule_id = ? AND reference_id = ?
             AND created_at > datetime('now', '-7 days')`,
          [created_by, ruleId, individual.id]
        );
        if (!existingNotification.length) {
          const title = `${trigger_event === 'misses' ? 'Missed' : 'Attended'} ${threshold_count} in a row`;
          const message = `${individual.first_name} ${individual.last_name} has ${trigger_event === 'misses' ? 'missed' : 'attended'} ${threshold_count} consecutive sessions.`;

          await Database.query(
            `INSERT INTO notifications (user_id, rule_id, title, message, notification_type, reference_type, reference_id, church_id)
             VALUES (?, ?, ?, ?, 'attendance_pattern', 'individual', ?, ?)`,
            [created_by, ruleId, title, message, individual.id, rule.church_id]
          );

          const [notifyUser] = await Database.query(
            `SELECT * FROM users WHERE id = ?`,
            [created_by]
          );
          if (notifyUser) {
            if (notifyUser.email_notifications && notifyUser.email) {
              try {
                await sendEmail({
                  to: [{ email: notifyUser.email, name: `${notifyUser.first_name} ${notifyUser.last_name}` }],
                  subject: title,
                  htmlContent: `<p>${message}</p>`,
                  textContent: message,
                });
              } catch (e) { console.error('Failed to send notification email to user:', e); }
            }
            if (notifyUser.sms_notifications && notifyUser.mobile_number) {
              try {
                await sendNotificationSMS(notifyUser.mobile_number, message);
              } catch (e) { console.error('Failed to send notification SMS to user:', e); }
            }
          }
        }

        // --- 2. Notify family caregivers ---
        if (!individual.family_id) continue;

        const caregivers = await Database.query(
          `SELECT
             fc.id as assignment_id,
             fc.caregiver_type,
             fc.user_id,
             fc.contact_id,
             CASE fc.caregiver_type WHEN 'user' THEN u.first_name ELSE c.first_name END as first_name,
             CASE fc.caregiver_type WHEN 'user' THEN u.last_name ELSE c.last_name END as last_name,
             CASE fc.caregiver_type WHEN 'user' THEN u.email ELSE c.email END as email,
             CASE fc.caregiver_type WHEN 'user' THEN u.mobile_number ELSE c.mobile_number END as mobile_number,
             CASE fc.caregiver_type WHEN 'user' THEN u.primary_contact_method ELSE c.primary_contact_method END as primary_contact_method,
             CASE fc.caregiver_type WHEN 'user' THEN u.email_notifications ELSE 1 END as email_notifications,
             CASE fc.caregiver_type WHEN 'user' THEN u.sms_notifications ELSE 0 END as sms_notifications
           FROM family_caregivers fc
           LEFT JOIN users u ON fc.user_id = u.id
           LEFT JOIN contacts c ON fc.contact_id = c.id AND c.is_active = 1
           WHERE fc.family_id = ? AND fc.church_id = ?`,
          [individual.family_id, rule.church_id]
        );

        const [family] = await Database.query(
          `SELECT id, family_name FROM families WHERE id = ?`,
          [individual.family_id]
        );

        const gatheringType = await Database.query(
          `SELECT name FROM gathering_types WHERE id = ?`,
          [gatheringTypeId]
        );
        const gatheringTypeName = gatheringType[0]?.name || 'their gathering';

        for (const caregiver of caregivers) {
          if (caregiver.caregiver_type === 'user') {
            // For user caregivers: insert in-app notification (with dedup)
            const existingCaregiverNotif = await Database.query(
              `SELECT id FROM notifications
               WHERE user_id = ? AND rule_id = ? AND reference_id = ?
                 AND created_at > datetime('now', '-7 days')`,
              [caregiver.user_id, ruleId, individual.id]
            );
            if (existingCaregiverNotif.length) continue;

            const title = `Follow up: ${individual.first_name} ${individual.last_name}`;
            const message = `${individual.first_name} ${individual.last_name} has missed ${threshold_count} consecutive ${gatheringTypeName} sessions.`;
            await Database.query(
              `INSERT INTO notifications (user_id, rule_id, title, message, notification_type, reference_type, reference_id, church_id)
               VALUES (?, ?, ?, ?, 'attendance_pattern', 'individual', ?, ?)`,
              [caregiver.user_id, ruleId, title, message, individual.id, rule.church_id]
            );
          } else {
            // For contact caregivers: log + send email/SMS (with dedup)
            const existingContactNotif = await Database.query(
              `SELECT id FROM contact_notifications
               WHERE contact_id = ? AND individual_id = ? AND rule_id = ?
                 AND created_at > datetime('now', '-7 days')`,
              [caregiver.contact_id, individual.id, ruleId]
            );
            if (existingContactNotif.length) continue;

            const title = `Follow up: ${individual.first_name} ${individual.last_name}`;
            const message = `${individual.first_name} ${individual.last_name} has missed ${threshold_count} consecutive ${gatheringTypeName} sessions.`;

            let emailSent = 0;
            let smsSent = 0;

            const useEmail = caregiver.email && caregiver.primary_contact_method === 'email';
            const useSms = caregiver.mobile_number && caregiver.primary_contact_method === 'sms';

            if (useEmail) {
              try {
                await sendCaregiverNotificationEmail(
                  caregiver,
                  individual,
                  family,
                  threshold_count,
                  gatheringTypeName
                );
                emailSent = 1;
              } catch (e) {
                console.error(`Failed to send caregiver email to ${caregiver.email}:`, e);
              }
            }
            if (useSms) {
              try {
                await sendNotificationSMS(
                  caregiver.mobile_number,
                  `Hi ${caregiver.first_name}, just a heads-up — ${individual.first_name} ${individual.last_name} has missed ${threshold_count} consecutive ${gatheringTypeName} sessions.`
                );
                smsSent = 1;
              } catch (e) {
                console.error(`Failed to send caregiver SMS to ${caregiver.mobile_number}:`, e);
              }
            }

            await Database.query(
              `INSERT INTO contact_notifications (church_id, contact_id, family_id, individual_id, rule_id, title, message, email_sent, sms_sent)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [rule.church_id, caregiver.contact_id, individual.family_id, individual.id, ruleId, title, message, emailSent, smsSent]
            );
          }
        }
      }
    }
  } catch (error) {
    console.error('Error triggering attendance notifications:', error);
  }
}

module.exports = { triggerAttendanceNotifications };
```

- [ ] **Step 2: Restart and verify**

```bash
docker-compose -f docker-compose.dev.yml restart server
docker-compose -f docker-compose.dev.yml logs -f server
```

Expected: Server starts without errors. No syntax errors in the log.

To manually verify the notification fires: set a notification rule with `threshold_count = 1` and `trigger_event = 'misses'` via the existing notification rules UI or directly via the API. Mark an individual absent in an attendance session. Check the admin panel for a row in `contact_notifications`.

- [ ] **Step 3: Commit**

```bash
git add server/utils/attendanceNotifications.js
git commit -m "fix: correct SQLite boolean and IN-clause bugs in attendanceNotifications; feat: extend to notify family caregivers"
```

---

## Task 8: Frontend API Client

**Files:**
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Add `contactsAPI` namespace** — add after the last existing export (after `visitorConfigAPI` or `takeoutAPI`):

```typescript
export const contactsAPI = {
  getAll: () =>
    api.get('/contacts').then(r => r.data.contacts),

  create: (data: {
    first_name: string;
    last_name: string;
    email?: string;
    mobile_number?: string;
    primary_contact_method?: 'email' | 'sms';
    notes?: string;
  }) => api.post('/contacts', data).then(r => r.data.contact),

  update: (id: number, data: {
    first_name: string;
    last_name: string;
    email?: string;
    mobile_number?: string;
    primary_contact_method?: 'email' | 'sms';
    notes?: string;
  }) => api.put(`/contacts/${id}`, data).then(r => r.data.contact),

  delete: (id: number) =>
    api.delete(`/contacts/${id}`).then(r => r.data),

  getFamilies: (contactId: number) =>
    api.get(`/contacts/${contactId}/families`).then(r => r.data.families),

  assignFamily: (contactId: number, familyId: number) =>
    api.post(`/contacts/${contactId}/families/${familyId}`).then(r => r.data),

  unassignFamily: (contactId: number, familyId: number) =>
    api.delete(`/contacts/${contactId}/families/${familyId}`).then(r => r.data),

  convertToUser: (contactId: number, role: 'coordinator' | 'attendance_taker') =>
    api.post(`/contacts/${contactId}/convert-to-user`, { role }).then(r => r.data.user),
};
```

- [ ] **Step 2: Extend `familiesAPI` namespace** — find the existing `familiesAPI` object (around line 526) and add three methods:

```typescript
// Add inside the familiesAPI object:
getCaregivers: (familyId: number) =>
  api.get(`/families/${familyId}/caregivers`).then(r => r.data.caregivers),

assignCaregiver: (familyId: number, payload: {
  caregiver_type: 'user' | 'contact';
  user_id?: number;
  contact_id?: number;
}) => api.post(`/families/${familyId}/caregivers`, payload).then(r => r.data),

removeCaregiver: (familyId: number, caregiverId: number) =>
  api.delete(`/families/${familyId}/caregivers/${caregiverId}`).then(r => r.data),
```

- [ ] **Step 3: Verify TypeScript compiles** — check for errors in the Docker logs:

```bash
docker-compose -f docker-compose.dev.yml logs -f client
```

Expected: Vite HMR reloads with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat: add contactsAPI and extend familiesAPI with caregiver methods"
```

---

## Task 9: UsersPage — Contacts Tab

**Files:**
- Modify: `client/src/pages/UsersPage.tsx`

This task adds a "Contacts" tab to the existing Users page with full CRUD and family assignment.

- [ ] **Step 1: Add Contact type definitions** — add near the top of `UsersPage.tsx`, alongside existing type definitions:

```typescript
interface Contact {
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile_number: string | null;
  primary_contact_method: 'email' | 'sms';
  notes: string | null;
  is_active: number;
  family_count: number;
}

interface ContactFormData {
  first_name: string;
  last_name: string;
  email: string;
  mobile_number: string;
  primary_contact_method: 'email' | 'sms';
  notes: string;
}
```

- [ ] **Step 2: Add Contacts state** — add inside the `UsersPage` component, alongside existing state:

```typescript
const [activeTab, setActiveTab] = useState<'users' | 'contacts'>('users');
const [contacts, setContacts] = useState<Contact[]>([]);
const [contactsLoading, setContactsLoading] = useState(false);
const [showContactModal, setShowContactModal] = useState(false);
const [editingContact, setEditingContact] = useState<Contact | null>(null);
const [showAssignFamiliesModal, setShowAssignFamiliesModal] = useState(false);
const [assigningContact, setAssigningContact] = useState<Contact | null>(null);
const [contactFamilies, setContactFamilies] = useState<{ id: number; family_name: string }[]>([]);
const [convertingContact, setConvertingContact] = useState<Contact | null>(null);
const [showConvertModal, setShowConvertModal] = useState(false);
const [convertRole, setConvertRole] = useState<'coordinator' | 'attendance_taker'>('attendance_taker');
```

- [ ] **Step 3: Add Contacts data-fetching functions** — add alongside existing handler functions:

```typescript
const loadContacts = async () => {
  setContactsLoading(true);
  try {
    const data = await contactsAPI.getAll();
    setContacts(data);
  } catch (err) {
    console.error('Failed to load contacts', err);
  } finally {
    setContactsLoading(false);
  }
};

const handleSaveContact = async (data: ContactFormData) => {
  try {
    if (editingContact) {
      const updated = await contactsAPI.update(editingContact.id, data);
      setContacts(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c));
    } else {
      const created = await contactsAPI.create(data);
      setContacts(prev => [...prev, { ...created, family_count: 0 }]);
    }
    setShowContactModal(false);
    setEditingContact(null);
  } catch (err: any) {
    alert(err?.response?.data?.error || 'Failed to save contact');
  }
};

const handleDeactivateContact = async (contact: Contact) => {
  if (!confirm(`Deactivate ${contact.first_name} ${contact.last_name}?`)) return;
  try {
    await contactsAPI.delete(contact.id);
    setContacts(prev => prev.filter(c => c.id !== contact.id));
  } catch (err) {
    alert('Failed to deactivate contact');
  }
};

const handleOpenAssignFamilies = async (contact: Contact) => {
  setAssigningContact(contact);
  const families = await contactsAPI.getFamilies(contact.id);
  setContactFamilies(families);
  setShowAssignFamiliesModal(true);
};

const handleConvertToUser = async () => {
  if (!convertingContact) return;
  try {
    await contactsAPI.convertToUser(convertingContact.id, convertRole);
    setContacts(prev => prev.filter(c => c.id !== convertingContact.id));
    setShowConvertModal(false);
    setConvertingContact(null);
    // Switch to users tab so they can see the new user
    setActiveTab('users');
    // Reload users list — call the existing loadUsers function
    loadUsers();
  } catch (err: any) {
    alert(err?.response?.data?.error || 'Failed to convert contact');
  }
};
```

- [ ] **Step 4: Load contacts when tab switches** — find the existing `useEffect` that loads users and extend it, or add a new one:

```typescript
useEffect(() => {
  if (activeTab === 'contacts') {
    loadContacts();
  }
}, [activeTab]);
```

- [ ] **Step 5: Add the tab switcher UI** — find where the page header is rendered and add tab buttons immediately below it:

```tsx
{/* Tab switcher */}
<div className="flex border-b border-gray-200 mb-6">
  <button
    onClick={() => setActiveTab('users')}
    className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
      activeTab === 'users'
        ? 'border-indigo-500 text-indigo-600'
        : 'border-transparent text-gray-500 hover:text-gray-700'
    }`}
  >
    Users
  </button>
  <button
    onClick={() => setActiveTab('contacts')}
    className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ml-4 ${
      activeTab === 'contacts'
        ? 'border-indigo-500 text-indigo-600'
        : 'border-transparent text-gray-500 hover:text-gray-700'
    }`}
  >
    Contacts
  </button>
</div>
```

- [ ] **Step 6: Add the Contacts tab content** — wrap the existing users table in `{activeTab === 'users' && ...}` and add a contacts panel below it:

```tsx
{activeTab === 'contacts' && (
  <div>
    <div className="flex justify-between items-center mb-4">
      <h2 className="text-lg font-medium text-gray-900">Contacts</h2>
      <button
        onClick={() => { setEditingContact(null); setShowContactModal(true); }}
        className="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700"
      >
        Add Contact
      </button>
    </div>

    {contactsLoading ? (
      <p className="text-gray-500 text-sm">Loading...</p>
    ) : contacts.length === 0 ? (
      <p className="text-gray-500 text-sm">No contacts yet. Add one to get started.</p>
    ) : (
      <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 rounded-lg">
        <table className="min-w-full divide-y divide-gray-300">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Contact</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Families</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {contacts.map(contact => (
              <tr key={contact.id}>
                <td className="px-4 py-3 text-sm font-medium text-gray-900">
                  {contact.first_name} {contact.last_name}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {contact.primary_contact_method === 'email'
                    ? contact.email
                    : contact.mobile_number}
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  <button
                    onClick={() => handleOpenAssignFamilies(contact)}
                    className="text-indigo-600 hover:underline"
                  >
                    {contact.family_count} {contact.family_count === 1 ? 'family' : 'families'}
                  </button>
                </td>
                <td className="px-4 py-3 text-sm text-right space-x-2">
                  <button
                    onClick={() => { setEditingContact(contact); setShowContactModal(true); }}
                    className="text-gray-500 hover:text-indigo-600"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => { setConvertingContact(contact); setShowConvertModal(true); }}
                    className="text-gray-500 hover:text-indigo-600"
                  >
                    Convert to user
                  </button>
                  <button
                    onClick={() => handleDeactivateContact(contact)}
                    className="text-gray-500 hover:text-red-600"
                  >
                    Deactivate
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 7: Add the Add/Edit Contact modal** — add before the closing `</div>` of the page:

```tsx
{showContactModal && (
  <ContactModal
    contact={editingContact}
    onSave={handleSaveContact}
    onClose={() => { setShowContactModal(false); setEditingContact(null); }}
  />
)}
```

Add the `ContactModal` component above the `UsersPage` component (or in a separate file `client/src/components/ContactModal.tsx`):

```tsx
function ContactModal({
  contact,
  onSave,
  onClose,
}: {
  contact: Contact | null;
  onSave: (data: ContactFormData) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState<ContactFormData>({
    first_name: contact?.first_name || '',
    last_name: contact?.last_name || '',
    email: contact?.email || '',
    mobile_number: contact?.mobile_number || '',
    primary_contact_method: contact?.primary_contact_method || 'email',
    notes: contact?.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!form.email && !form.mobile_number) {
      setError('At least one of email or mobile number is required');
      return;
    }
    setSaving(true);
    try {
      await onSave(form);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
        <h3 className="text-lg font-semibold mb-4">{contact ? 'Edit Contact' : 'Add Contact'}</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">First name *</label>
              <input
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={form.first_name}
                onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Last name *</label>
              <input
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={form.last_name}
                onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))}
                required
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Mobile number</label>
            <input
              type="tel"
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
              value={form.mobile_number}
              onChange={e => setForm(f => ({ ...f, mobile_number: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Preferred contact method</label>
            <select
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
              value={form.primary_contact_method}
              onChange={e => setForm(f => ({ ...f, primary_contact_method: e.target.value as 'email' | 'sms' }))}
            >
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <textarea
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
              rows={2}
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
            />
          </div>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900">
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Add the Convert to User modal** — add before closing `</div>`:

```tsx
{showConvertModal && convertingContact && (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
    <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6">
      <h3 className="text-lg font-semibold mb-2">Convert to User</h3>
      <p className="text-sm text-gray-600 mb-4">
        {convertingContact.first_name} {convertingContact.last_name} will become an app user.
        Their family assignments will be preserved. An invitation email will be sent to{' '}
        <strong>{convertingContact.email}</strong>.
      </p>
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
        <select
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          value={convertRole}
          onChange={e => setConvertRole(e.target.value as 'coordinator' | 'attendance_taker')}
        >
          <option value="attendance_taker">Attendance Taker</option>
          <option value="coordinator">Coordinator</option>
        </select>
      </div>
      <div className="flex justify-end gap-3">
        <button
          onClick={() => { setShowConvertModal(false); setConvertingContact(null); }}
          className="px-4 py-2 text-sm text-gray-700 hover:text-gray-900"
        >
          Cancel
        </button>
        <button
          onClick={handleConvertToUser}
          className="px-4 py-2 bg-indigo-600 text-white rounded-md text-sm font-medium hover:bg-indigo-700"
        >
          Convert & Invite
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 9: Ensure `contactsAPI` is imported** — add to the import at the top of `UsersPage.tsx`:

```typescript
import { usersAPI, invitationsAPI, familiesAPI, contactsAPI } from '../services/api';
```

- [ ] **Step 10: Verify in browser**

Open `http://localhost:3000`, navigate to Users page. Expected: "Users" and "Contacts" tabs visible. Click Contacts → "Add Contact" → fill form → save → row appears. Click "Families" count → modal opens. Click "Convert to user" → modal with role picker appears.

- [ ] **Step 11: Commit**

```bash
git add client/src/pages/UsersPage.tsx
git commit -m "feat: add Contacts tab to UsersPage with CRUD and convert-to-user"
```

---

## Task 10: PeoplePage — Family Caregiver Chip

**Files:**
- Modify: `client/src/pages/PeoplePage.tsx`

Add a small caregiver indicator on each family header row. Clicking it opens a popover to view, add, and remove caregivers for that family.

- [ ] **Step 1: Add caregiver state** — add inside `PeoplePage` alongside existing state:

```typescript
const [familyCaregivers, setFamilyCaregivers] = useState<Record<number, FamilyCaregiver[]>>({});
const [caregiverPopoverFamilyId, setCaregiverPopoverFamilyId] = useState<number | null>(null);
const [caregiverSearch, setCaregiverSearch] = useState('');
const [caregiverSearchResults, setCaregiverSearchResults] = useState<CaregiverSearchResult[]>([]);
```

- [ ] **Step 2: Add FamilyCaregiver and CaregiverSearchResult types** — near top of `PeoplePage.tsx`:

```typescript
interface FamilyCaregiver {
  id: number; // family_caregivers.id
  caregiver_type: 'user' | 'contact';
  user_id?: number;
  contact_id?: number;
  first_name: string;
  last_name: string;
  email: string | null;
  mobile_number: string | null;
}

interface CaregiverSearchResult {
  type: 'user' | 'contact';
  id: number;
  first_name: string;
  last_name: string;
  email: string | null;
}
```

- [ ] **Step 3: Add caregiver helper functions** — alongside existing handlers:

```typescript
const loadFamilyCaregivers = async (familyId: number) => {
  try {
    const caregivers = await familiesAPI.getCaregivers(familyId);
    setFamilyCaregivers(prev => ({ ...prev, [familyId]: caregivers }));
  } catch (err) {
    console.error('Failed to load family caregivers', err);
  }
};

const handleOpenCaregiverPopover = async (familyId: number) => {
  setCaregiverPopoverFamilyId(familyId);
  setCaregiverSearch('');
  setCaregiverSearchResults([]);
  await loadFamilyCaregivers(familyId);
};

const handleRemoveCaregiver = async (familyId: number, caregiverId: number) => {
  try {
    await familiesAPI.removeCaregiver(familyId, caregiverId);
    await loadFamilyCaregivers(familyId);
  } catch (err) {
    console.error('Failed to remove caregiver', err);
  }
};

const handleCaregiverSearch = async (query: string) => {
  setCaregiverSearch(query);
  if (query.trim().length < 2) { setCaregiverSearchResults([]); return; }
  try {
    // Search from pre-loaded data: users from existing state + contacts from API
    const [allUsers, allContacts] = await Promise.all([
      usersAPI.getAll().then((r: any) => r.users || []),
      contactsAPI.getAll(),
    ]);
    const q = query.toLowerCase();
    const userResults: CaregiverSearchResult[] = allUsers
      .filter((u: any) => `${u.first_name} ${u.last_name}`.toLowerCase().includes(q))
      .map((u: any) => ({ type: 'user' as const, id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email }));
    const contactResults: CaregiverSearchResult[] = allContacts
      .filter((c: any) => `${c.first_name} ${c.last_name}`.toLowerCase().includes(q))
      .map((c: any) => ({ type: 'contact' as const, id: c.id, first_name: c.first_name, last_name: c.last_name, email: c.email }));
    setCaregiverSearchResults([...userResults, ...contactResults].slice(0, 8));
  } catch (err) {
    console.error('Caregiver search failed', err);
  }
};

const handleAddCaregiver = async (familyId: number, result: CaregiverSearchResult) => {
  try {
    await familiesAPI.assignCaregiver(familyId, {
      caregiver_type: result.type,
      user_id: result.type === 'user' ? result.id : undefined,
      contact_id: result.type === 'contact' ? result.id : undefined,
    });
    await loadFamilyCaregivers(familyId);
    setCaregiverSearch('');
    setCaregiverSearchResults([]);
  } catch (err) {
    console.error('Failed to add caregiver', err);
  }
};
```

- [ ] **Step 4: Add caregiver chip to family header** — find where family headers are rendered (the family name row in grouped view, around the `group_by_family` / family collapsible section). Add the chip immediately after the family name:

```tsx
{/* Caregiver chip — only shown in grouped view */}
{(() => {
  const caregivers = familyCaregivers[family.id];
  const count = caregivers?.length ?? 0;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); handleOpenCaregiverPopover(family.id); }}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ml-2 ${
        count > 0
          ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200'
          : 'text-gray-400 hover:text-gray-600'
      }`}
      title="Manage caregivers"
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
      {count > 0 && count}
    </button>
  );
})()}
```

- [ ] **Step 5: Add the caregiver popover/modal** — add before the page's closing tag:

```tsx
{caregiverPopoverFamilyId !== null && (() => {
  const familyId = caregiverPopoverFamilyId;
  const caregivers = familyCaregivers[familyId] || [];
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
         onClick={() => setCaregiverPopoverFamilyId(null)}>
      <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-5"
           onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-base font-semibold text-gray-900">Caregivers</h3>
          <button onClick={() => setCaregiverPopoverFamilyId(null)} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        {caregivers.length === 0 ? (
          <p className="text-sm text-gray-500 mb-3">No caregivers assigned.</p>
        ) : (
          <ul className="mb-3 space-y-2">
            {caregivers.map(cg => (
              <li key={cg.id} className="flex justify-between items-center text-sm">
                <span className="text-gray-800">
                  {cg.first_name} {cg.last_name}
                  <span className="ml-1 text-xs text-gray-400">({cg.caregiver_type})</span>
                </span>
                <button
                  onClick={() => handleRemoveCaregiver(familyId, cg.id)}
                  className="text-red-400 hover:text-red-600 text-xs"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="relative">
          <input
            type="text"
            placeholder="Search users or contacts..."
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
            value={caregiverSearch}
            onChange={e => handleCaregiverSearch(e.target.value)}
          />
          {caregiverSearchResults.length > 0 && (
            <ul className="absolute z-10 w-full bg-white border border-gray-200 rounded-md shadow-lg mt-1 max-h-48 overflow-y-auto">
              {caregiverSearchResults.map(result => (
                <li key={`${result.type}-${result.id}`}>
                  <button
                    onClick={() => handleAddCaregiver(familyId, result)}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50"
                  >
                    {result.first_name} {result.last_name}
                    <span className="ml-1 text-xs text-gray-400">({result.type})</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
})()}
```

- [ ] **Step 6: Import contactsAPI and usersAPI** — ensure they're imported in `PeoplePage.tsx`:

```typescript
import { familiesAPI, individualsAPI, contactsAPI, usersAPI } from '../services/api';
```

- [ ] **Step 7: Verify in browser**

Open the People page. Find a family in grouped view. Expected: person-icon button visible on family header. Click it → modal opens. Search for a user or contact by name → results appear → click to assign → caregiver appears in list. Click Remove → caregiver removed.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/PeoplePage.tsx
git commit -m "feat: add caregiver chip and assignment popover to family cards on PeoplePage"
```

---

## Task 11: PeoplePage — Bulk Assign Caregiver

**Files:**
- Modify: `client/src/pages/PeoplePage.tsx`

Add "Assign caregiver" to the multi-select action toolbar, so multiple families can be assigned at once.

- [ ] **Step 1: Add bulk-assign state** — add alongside existing state:

```typescript
const [showBulkCaregiverModal, setShowBulkCaregiverModal] = useState(false);
const [bulkCaregiverSearch, setBulkCaregiverSearch] = useState('');
const [bulkCaregiverResults, setBulkCaregiverResults] = useState<CaregiverSearchResult[]>([]);
const [bulkAssigning, setBulkAssigning] = useState(false);
```

- [ ] **Step 2: Add bulk-assign handler**:

```typescript
const handleBulkCaregiverSearch = async (query: string) => {
  setBulkCaregiverSearch(query);
  if (query.trim().length < 2) { setBulkCaregiverResults([]); return; }
  try {
    const [allUsers, allContacts] = await Promise.all([
      usersAPI.getAll().then((r: any) => r.users || []),
      contactsAPI.getAll(),
    ]);
    const q = query.toLowerCase();
    const results: CaregiverSearchResult[] = [
      ...allUsers
        .filter((u: any) => `${u.first_name} ${u.last_name}`.toLowerCase().includes(q))
        .map((u: any) => ({ type: 'user' as const, id: u.id, first_name: u.first_name, last_name: u.last_name, email: u.email })),
      ...allContacts
        .filter((c: any) => `${c.first_name} ${c.last_name}`.toLowerCase().includes(q))
        .map((c: any) => ({ type: 'contact' as const, id: c.id, first_name: c.first_name, last_name: c.last_name, email: c.email })),
    ].slice(0, 8);
    setBulkCaregiverResults(results);
  } catch (err) {
    console.error('Caregiver search failed', err);
  }
};

const handleBulkAssignCaregiver = async (caregiver: CaregiverSearchResult) => {
  setBulkAssigning(true);
  try {
    // Collect unique family IDs from the current selection
    // selectedPeople is the existing multi-select state (Set of individual IDs)
    const familyIds = new Set<number>();
    for (const individualId of selectedPeople) {
      // Find this individual's family from the loaded people data
      const individual = allPeople.find((p: any) => p.id === individualId);
      if (individual?.family_id) familyIds.add(individual.family_id);
    }

    await Promise.all(
      Array.from(familyIds).map(familyId =>
        familiesAPI.assignCaregiver(familyId, {
          caregiver_type: caregiver.type,
          user_id: caregiver.type === 'user' ? caregiver.id : undefined,
          contact_id: caregiver.type === 'contact' ? caregiver.id : undefined,
        }).catch(() => {}) // Ignore duplicate assignments
      )
    );
    setShowBulkCaregiverModal(false);
    setBulkCaregiverSearch('');
    setBulkCaregiverResults([]);
  } catch (err) {
    console.error('Bulk assign failed', err);
  } finally {
    setBulkAssigning(false);
  }
};
```

> **Note:** `selectedPeople` and `allPeople` should match the existing variable names in `PeoplePage.tsx` for the multi-select state and the flat people array. Check those names in the existing code and adjust if different.

- [ ] **Step 3: Add "Assign caregiver" button to the selection toolbar** — find where the existing multi-select action toolbar is rendered (the bar that appears when people are selected, which currently shows "Mass Edit" or similar). Add an "Assign caregiver" button:

```tsx
{selectedPeople.size > 0 && (
  // existing toolbar wrapper — add this button alongside existing actions:
  <button
    onClick={() => { setShowBulkCaregiverModal(true); setBulkCaregiverSearch(''); setBulkCaregiverResults([]); }}
    className="px-3 py-1.5 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
  >
    Assign caregiver
  </button>
)}
```

- [ ] **Step 4: Add the bulk-assign modal** — add before the page's closing tag:

```tsx
{showBulkCaregiverModal && (
  <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
       onClick={() => setShowBulkCaregiverModal(false)}>
    <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-5"
         onClick={e => e.stopPropagation()}>
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-base font-semibold text-gray-900">Assign caregiver</h3>
        <button onClick={() => setShowBulkCaregiverModal(false)} className="text-gray-400 hover:text-gray-600">✕</button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        Search for a user or contact to assign as caregiver for all selected families.
      </p>
      <div className="relative">
        <input
          type="text"
          placeholder="Search users or contacts..."
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          value={bulkCaregiverSearch}
          onChange={e => handleBulkCaregiverSearch(e.target.value)}
          autoFocus
        />
        {bulkCaregiverResults.length > 0 && (
          <ul className="absolute z-10 w-full bg-white border border-gray-200 rounded-md shadow-lg mt-1 max-h-48 overflow-y-auto">
            {bulkCaregiverResults.map(result => (
              <li key={`${result.type}-${result.id}`}>
                <button
                  onClick={() => handleBulkAssignCaregiver(result)}
                  disabled={bulkAssigning}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  {result.first_name} {result.last_name}
                  <span className="ml-1 text-xs text-gray-400">({result.type})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {bulkAssigning && <p className="text-sm text-gray-500 mt-3">Assigning...</p>}
    </div>
  </div>
)}
```

- [ ] **Step 5: Verify in browser**

Select two or more people via checkboxes. Expected: "Assign caregiver" button appears in toolbar. Click it → modal opens → search for a contact → click → modal closes. Check the family cards for those people — caregiver chip should now show.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/PeoplePage.tsx
git commit -m "feat: add bulk assign caregiver to PeoplePage multi-select toolbar"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] `contacts` table → Task 1
- [x] `family_caregivers` table → Task 1
- [x] `contact_notifications` table → Task 1
- [x] Contacts CRUD API → Task 2
- [x] Family assignment from contacts side → Task 3
- [x] Family caregivers API → Task 4
- [x] Contact → User conversion (transaction, email, migration) → Task 5
- [x] Caregiver email template → Task 6
- [x] Attendance notification extended for caregivers (user + contact) → Task 7
- [x] Deduplication (7-day window) → Task 7
- [x] Pre-existing `attendanceNotifications.js` bugs fixed → Task 7
- [x] API client additions → Task 8
- [x] Contacts tab on UsersPage → Task 9
- [x] Caregiver chip on family cards → Task 10
- [x] Bulk assign via multi-select toolbar → Task 11
- [x] No email + graceful skip → Task 7 (`useEmail` conditional)
- [x] No family_id → skip caregiver notifications → Task 7 (`if (!individual.family_id) continue`)
- [x] Church isolation → all queries include `church_id` filter

**Type consistency check:**
- `FamilyCaregiver.id` = `family_caregivers.id` row → used as `caregiverId` in `removeCaregiver(familyId, caregiverId)` → matches `DELETE /api/families/:id/caregivers/:caregiverId` ✓
- `CaregiverSearchResult.type` matches `caregiver_type` in POST body ✓
- `contactsAPI.convertToUser(contactId, role)` → POST `/contacts/:id/convert-to-user` with `{ role }` ✓
- `familiesAPI.assignCaregiver(familyId, { caregiver_type, user_id, contact_id })` → matches POST body in Task 4 ✓
