# Caregivers & Absence Notifications — Design Spec

**Date:** 2026-04-08
**Status:** Awaiting implementation

---

## Problem

Churches want named individuals to have pastoral responsibility for specific families, and to be notified automatically when those families miss gatherings. The responsible person (caregiver) may or may not be an app user — they might be a home group leader or volunteer with no login.

---

## Solution Summary

Introduce a **Caregiver** concept: any person (app user or external contact) responsible for one or more families. When a notification rule fires for an individual, every caregiver assigned to that individual's family is notified by their preferred method (email or SMS).

The existing `notification_rules` system remains the trigger engine. Caregivers are additive — no breaking changes to existing tables.

---

## Entities

### Contact (new)

An external person who receives notifications but cannot log in. Stored in a new `contacts` table.

Fields: `first_name`, `last_name`, `email`, `mobile_number`, `primary_contact_method` (email | sms), `notes`, `is_active`, `created_by`, `church_id`.

A contact must have at least one of email or mobile — validated at the API level.

### Caregiver

Not a separate table — a caregiver is either an existing **user** or a **contact**, both assignable to families via the `family_caregivers` junction table.

---

## Database Schema

### New table: `contacts`

```sql
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
);
```

### New table: `family_caregivers`

```sql
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
);
```

Application-level constraint: exactly one of `user_id` / `contact_id` is set based on `caregiver_type`.

### New table: `contact_notifications`

Log of notifications dispatched to external contacts (they have no in-app inbox).

```sql
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
);
```

No changes to `notification_rules`, `notifications`, `users`, `families`, or `individuals`.

---

## Notification Trigger Logic

**File:** `server/utils/attendanceNotifications.js`

The existing `triggerAttendanceNotifications(gatheringTypeId, sessionDate)` function is extended:

1. For each individual who hits a rule threshold (X consecutive misses of the same gathering type):
   a. Look up their `family_id`.
   b. Query `family_caregivers` for that family, joining to `users` and `contacts` as appropriate.
   c. For each assigned **user caregiver**: insert into the existing `notifications` table (same as app-user notifications today).
   d. For each assigned **contact caregiver**: send email or SMS, then insert into `contact_notifications`.
2. Deduplication: skip if a `contact_notifications` row already exists for the same `(contact_id, individual_id, rule_id)` within the last 7 days — prevents re-firing on every subsequent session. 7 days aligns with a weekly gathering cadence so a new notification can fire the following week if the person is still absent.
3. Individuals without a `family_id` receive no caregiver notifications (edge case; individuals generally have a family).

### Absence scope (per rule)

Controlled by the existing `notification_rules.gathering_type_id` field — no schema change needed:

| `gathering_type_id` | Behaviour |
|---|---|
| Set to a specific gathering | Consecutive misses of that gathering type only |
| NULL | Absence across any gathering type |

Default threshold: **3 consecutive misses** (the existing `threshold_count` default).

---

## Email Template

**File:** `server/utils/email.js`

New function: `sendCaregiverNotificationEmail(contact, individual, family, missedCount, gatheringTypeName)`

Tone: warm and pastoral, not alarm-like. Example content:

> Hi [Contact first name],
>
> Just a heads-up — [Individual name] from the [Family name] family hasn't attended [Gathering name] for the past [X] weeks. You may want to check in with them.
>
> — [Church name]

Follows the Brevo API pattern used by `sendOTCEmail()` and `sendWeeklyReviewEmail()`.

---

## API Routes

### New file: `server/routes/contacts.js`

Access: admin and coordinator roles only.

| Method | Path | Description |
|---|---|---|
| GET | `/api/contacts` | List all active contacts, with assigned family count |
| POST | `/api/contacts` | Create a contact |
| PUT | `/api/contacts/:id` | Update a contact |
| DELETE | `/api/contacts/:id` | Soft-deactivate (`is_active = 0`) |
| GET | `/api/contacts/:id/families` | List families assigned to this contact |
| POST | `/api/contacts/:id/families/:familyId` | Assign contact to a family |
| DELETE | `/api/contacts/:id/families/:familyId` | Remove assignment |

### Extended: `server/routes/families.js` (or individuals/reports route)

| Method | Path | Description |
|---|---|---|
| GET | `/api/families/:id/caregivers` | List all caregivers (users + contacts) for a family |
| POST | `/api/families/:id/caregivers` | Assign a caregiver — body: `{ caregiver_type, user_id? contact_id? }` |
| DELETE | `/api/families/:id/caregivers/:caregiverId` | Remove a caregiver assignment — `:caregiverId` is the `family_caregivers.id` row, not the user or contact id |

### Contact → User conversion

| Method | Path | Description |
|---|---|---|
| POST | `/api/contacts/:id/convert-to-user` | Convert a contact into a full app user |

Request body: `{ role: 'coordinator' | 'attendance_taker' }` (admin role not allowed as a default to prevent accidental privilege escalation).

Server steps (wrapped in a transaction):
1. Validate the contact has an email address (required for user login).
2. Check no existing user has the same email — return a 409 with a clear message if so.
3. Create a new row in `users` using the contact's `first_name`, `last_name`, `email`, `mobile_number`, `primary_contact_method`, and the chosen `role`. Set `is_invited = 1`.
4. Update all `family_caregivers` rows where `contact_id = :id`: set `caregiver_type = 'user'`, `user_id = <new user id>`, `contact_id = NULL`.
5. Set `contacts.is_active = 0` on the original contact (soft delete; preserves `contact_notifications` history).
6. Send the standard invitation email to the new user via `sendInvitationEmail()`.

On success, return the new user object so the UI can redirect to the Users tab.

Register `contacts` router in `server/server.js`.

---

## Frontend

### `client/src/services/api.ts`

New `contactsAPI` namespace:

```ts
contactsAPI.getAll()
contactsAPI.create(data)
contactsAPI.update(id, data)
contactsAPI.delete(id)
contactsAPI.getFamilies(contactId)
contactsAPI.convertToUser(contactId, { role })
contactsAPI.assignFamily(contactId, familyId)
contactsAPI.unassignFamily(contactId, familyId)

familiesAPI.getCaregivers(familyId)
familiesAPI.assignCaregiver(familyId, payload)    // { caregiver_type, user_id | contact_id }
familiesAPI.removeCaregiver(familyId, caregiverId)
```

### `client/src/pages/UsersPage.tsx` — Contacts tab

Add a **"Contacts"** tab alongside the existing users list.

- Table columns: Name, Contact details (email / mobile), Families assigned (count), Status
- **Add Contact** button → modal: first name, last name, email, mobile, preferred contact method, notes
- Per-row actions: Edit, Deactivate, **Convert to user**
- Per-row **"Families"** button → searchable multi-select modal of all families. Uses checkbox-diff pattern (compare initial vs. desired, sync only changed items) matching the gathering assignment pattern in PeoplePage.

### `client/src/pages/PeoplePage.tsx` — three caregiver surfaces

**1. Family card indicator**
Each family header row gains a small caregiver chip (person icon + count) when caregivers are assigned. Clicking opens a popover listing assigned caregivers by name, with a remove button per entry and an **"Add caregiver"** search field (searches across both users and contacts).

**2. Multi-select toolbar action — "Assign caregiver"**
When one or more families are selected via checkboxes, the existing selection toolbar gains an **"Assign caregiver"** button. This opens a modal with:
- Search field across users and contacts
- Select one caregiver
- Confirm → assigns that caregiver to all selected families in one operation (POST per family, same diff pattern)

Note: this action is family-level. If the selection contains individuals rather than whole families, the caregiver is assigned to each selected individual's family. If two selected individuals share a family, that family is only assigned once.

**3. Read-only display**
The caregiver chip on family cards is always visible (zero-state shows nothing). No caregiver data is loaded until the chip is clicked — lazy fetch to keep page load fast.

---

## Out of Scope (this iteration)

- Notifying caregivers of visitor patterns (rules with `target_group = 'potential_regular_visitors'`)
- Per-caregiver threshold customisation (all caregivers use the same rule thresholds)
- Caregiver access to any part of the app (contacts remain notification-only)
- Individual-level caregiver assignment (family-level only)

---

## Verification Checklist

- [ ] New tables appear in a freshly created church database
- [ ] Existing churches: tables are created on next server start (schema.js `CREATE TABLE IF NOT EXISTS` handles this)
- [ ] CRUD for contacts works; deactivating a contact does not delete `family_caregivers` rows (soft delete)
- [ ] Assigning a contact to a family via Contacts page is reflected in PeoplePage family card
- [ ] Assigning multiple families via PeoplePage multi-select creates the correct `family_caregivers` rows
- [ ] Marking an individual absent for X consecutive sessions triggers email/SMS to assigned caregiver
- [ ] `contact_notifications` deduplication prevents re-firing within 7 days for the same individual + rule
- [ ] Individual with no `family_id` → no crash, no caregiver notification
- [ ] Contact with no email and `primary_contact_method = 'email'` → graceful skip, log warning
- [ ] Church isolation: all queries scoped to `church_id`
- [ ] Converting a contact to a user migrates all `family_caregivers` rows and deactivates the contact in a single transaction
- [ ] Converting a contact with no email returns a clear error (email required for login)
- [ ] Converting a contact whose email already belongs to a user returns a 409 with a clear message
- [ ] After conversion, the new user appears on the Users tab and receives an invitation email
- [ ] `contact_notifications` history is preserved after conversion (still references the original `contact_id`)
