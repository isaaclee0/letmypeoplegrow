# Multi-Church Account Switching

## Problem

Today, `user_lookup` in the registry (`server/config/schema.js:10-16`) already lets the
same email or mobile number belong to more than one church — there's no uniqueness
constraint, and `Database.lookupAllChurchesByEmail`/`lookupAllChurchesByMobile`
(`server/config/database.js:514-532`) already return every matching church. The only
place this is used today is the **pre-login** church picker: if `/request-code` finds
more than one match, it returns `requiresChurchSelection: true` and a church list
(`server/routes/auth.js` ~143-155), and `LoginPage.tsx` renders a picker before the OTC
is even sent.

Once a user is logged in, though, the JWT is permanently scoped to one
`{userId, churchId}` pair (`auth.js:426-430`) for up to 30 days. There's no way to move
to a different linked church without logging out and back in, re-entering the picker,
and going through OTC again. There's also no way to recognize two people who are the
*same real person* across churches when they used different contact details in each
(e.g. a personal email at one church, a work email at another) — those never show up as
linked at all today.

This adds:
1. A post-login **church switcher**, shown just above the logout button, for anyone
   whose email/mobile already matches more than one church.
2. A **manual link** tool in the internal admin panel (localhost:7777) so staff can
   link two user records as the same person even when their contact details don't
   match exactly, so they also appear in each other's switcher.

## Non-goals

- No re-verification (OTC) on switch — see "Trust model" below.
- No merging of user rows across churches. A linked person keeps a fully separate
  `users` row (and role, profile, etc.) per church, exactly as today — linking only
  affects which churches show up in *their own* switcher.
- No self-service linking by end users or church admins. Manual linking is
  localhost-admin-only, since it requires visibility across the church-isolation
  boundary that per-church admins don't have.
- No automatic "suggested match" detection (fuzzy name matching, etc.) for the admin
  tool in this iteration — search is manual, same as the existing `/api/users` admin
  endpoint.

## Trust model

A switch reuses the trust already established at login: the current JWT proves the
user controls the email/mobile that was OTC-verified to sign in. If that same
email/mobile (or an admin-assigned link) matches a user row in another church, moving
to that row requires no new proof — it's the same identity, just a different church's
account. The switch endpoint re-validates server-side on every call (never trusts a
client-supplied church list), and every switch is logged.

## Data model change

Add one nullable column to the registry schema (`server/config/schema.js`):

```sql
ALTER TABLE user_lookup ADD COLUMN person_id TEXT;
CREATE INDEX IF NOT EXISTS idx_user_lookup_person ON user_lookup(person_id);
```

- Automatic linking (already works): same `email` or same `mobile_number` across
  `user_lookup` rows.
- Manual linking (new): admin sets the same `person_id` (a generated UUID) on two or
  more `user_lookup` rows whose contact details don't otherwise match. Unlinking clears
  `person_id` back to `NULL`.
- "Which other churches am I linked to" becomes one query: rows sharing my email, OR
  my mobile, OR my `person_id` (if set) — covering both cases without a second table or
  a graph traversal.

New `Database` helper (`server/config/database.js`, alongside `lookupAllChurchesByEmail`):

```js
static lookupLinkedChurches(userId, churchId, email, mobileNumber) {
  // SELECT ul.church_id, ul.user_id, c.church_name
  // FROM user_lookup ul JOIN churches c ON c.church_id = ul.church_id
  // WHERE ul.church_id != churchId AND (
  //   (email IS NOT NULL AND ul.email = email) OR
  //   (mobileNumber IS NOT NULL AND ul.mobile_number = mobileNumber) OR
  //   (ul.person_id IS NOT NULL AND ul.person_id = (
  //      SELECT person_id FROM user_lookup WHERE user_id = ? AND church_id = ?
  //   ))
  // )
}
```

## Backend: switch endpoints

Both new, in `server/routes/auth.js`, both behind `verifyToken`:

### `GET /api/auth/my-churches`

Calls `Database.lookupLinkedChurches(...)` with the current token's `userId`,
`churchId`, `email`, `mobile`. Filters out any result where the target church isn't
approved (`Database.isChurchApproved`) or the target user row is `is_active = 0`
(cheap per-row check via `Database.queryForChurch`). Returns
`{ churches: [{ churchId, churchName }] }`. Called once when the app loads (from
`AuthContext`), not baked into the JWT, so it's always current — a link removed by an
admin, or a deactivated account, disappears immediately rather than lingering until
token expiry.

### `POST /api/auth/switch-church`

Body `{ targetChurchId }`. Steps:
1. Re-run the same `lookupLinkedChurches` + filter as above — reject with 403 if
   `targetChurchId` isn't actually in the allowed set (never trust the client).
2. Load the target user row (`Database.queryForChurch(targetChurchId, 'SELECT ... FROM users WHERE ...')`),
   matched by `req.user.email`/`req.user.mobile_number` — `verifyToken`
   (`server/middleware/auth.js:31-44`) already re-fetches the full current-church row
   on every request, so both fields are reliably available regardless of whether the
   token came from `verify-code` or a `/refresh` (which only re-signs `email`, not
   `mobile`, into the JWT itself — irrelevant here since we read off the DB row, not
   the JWT claims).
3. Reject with 401 if that row is `is_active = 0`.
4. Mint a new JWT exactly as `verify-code` does (`auth.js:426-430`), scoped to the
   target `{userId, churchId}`, and set it via the same `authToken` cookie options
   (`auth.js:432-440`).
5. Update `last_login_at` for the target row (same as `auth.js:443`).
6. Log the switch: `from churchId/userId -> to churchId/userId` via the existing
   Winston logger, at `info` level — this crosses the isolation boundary the security
   model treats as critical, so it's worth a durable trail even without a UI.
7. Return the same `user` object shape as `verify-code`'s response
   (`auth.js:470-486`), so the client can treat it identically to a fresh login.

## Frontend

### `User` type and auth responses

`client/src/services/api.ts:145-160` — add `churchName?: string` to the `User`
interface. `verify-code`, `switch-church`, and `/me` responses all start including it
(sourced from `Database` registry's `churches.church_name`, already available via
`Database.listChurches()`/the churches table — no new lookup needed since the
churchId is already known at response time).

### AuthContext

`client/src/contexts/AuthContext.tsx` — add:
- `myChurches: {churchId, churchName}[]` state, fetched once after `user` is set
  (mirrors the existing onboarding-status fetch pattern at `login()`, `AuthContext.tsx:154-162`).
- `switchChurch(targetChurchId: string)`: calls `POST /api/auth/switch-church`, then
  calls the existing `login('', response.user)` (`AuthContext.tsx:147-165`) — `login`
  already ignores its `token` argument since auth is cookie-based, so this needs no
  changes to `login` itself — then triggers a full redirect to `/dashboard` (a hard
  `window.location.href` navigation, not just a router push, so every church-scoped
  query in the app re-fetches cleanly rather than needing per-page invalidation logic).

### UI placement

Today only the **mobile** sidebar has a profile block (`Layout.tsx:213-222`, name +
role, just above the logout button at `Layout.tsx:245-251`). The **desktop** sidebar
has no equivalent — it goes straight to the logout button (`Layout.tsx:306-314`) with
no profile section above it.

Add a small church-name element directly above the logout button in both places:
- Mobile: inside the existing profile block, as a third line under name/role.
- Desktop: a new minimal block (just the church name, no avatar/role — keeping the
  desktop sidebar's current lighter footprint) directly above the logout button.

Behavior, in both places:
- If `myChurches.length === 0`: static text, current church's name, no affordance.
- If `myChurches.length > 0`: same text becomes a button that opens a small dropdown
  (new `ChurchSwitcher.tsx` component, reused by both sidebars) listing the other
  linked churches by name; clicking one calls `switchChurch(churchId)`.
- Copy uses "church" throughout (e.g. a dropdown header of "Switch church"), matching
  existing app terminology — not "organisation".
- Shown for all roles (admin, coordinator, attendance_taker) — no role gating.

## Admin panel: manual linking

The admin panel already has a cross-church user search: `GET /api/users` in
`server/admin/index.js:195-252` loops every church via `Database.listChurches()` and
matches `email`/`first_name`/`last_name`/`church_id` with `LIKE`. This is reused as-is
for finding link candidates — no new search endpoint needed.

Changes:
- `GET /api/users` and `GET /api/users/:userId` (`server/admin/index.js:195-290`): join
  in `person_id` from the registry's `user_lookup` for each returned row (by
  `user_id` + `church_id`), so the admin UI can show a "linked" indicator.
- New `POST /api/users/:churchId/:userId/link` — body `{ targetChurchId, targetUserId }`.
  If either row already has a `person_id`, reuse it (so a person can accumulate more
  than two linked churches over time by linking a new one into an existing group);
  otherwise generate a new UUID and set it on both rows.
- New `POST /api/users/:churchId/:userId/unlink` — clears that row's `person_id` to
  `NULL` (only that row leaves the group; other members keep their link).
- `server/admin/public/index.html` (the existing single-page admin UI, ~1717 lines):
  in the existing user list/detail view, add a "linked" badge, a way to select a second
  user row from a search result to link against, and an unlink action.

## Edge case: current church pending approval

`verifyToken` (`server/middleware/auth.js:46-54`) already blocks every endpoint except
`/api/auth/me`, `/api/auth/refresh`, and `/api/auth/logout` while the current church is
unapproved. Add `/api/auth/my-churches` and `/api/auth/switch-church` to that allow-list
— someone stuck on an unapproved church should still be able to switch to an approved
one they're also linked to, rather than being fully locked out until approval.

## Security notes

- `switch-church` re-validates the target on every call — a stale/cached `myChurches`
  list on the client is never trusted directly.
- Deactivating a user in one church, or un-approving a church, immediately removes it
  from `my-churches` results and blocks `switch-church` to/from it — no separate
  cleanup needed since nothing is cached server-side either.
- Every switch is logged (from/to churchId + userId) via the existing Winston logger.
- Manual linking stays localhost-only (existing admin panel access control) since it's
  the only place two churches' user tables are visible together.

## Testing

- Server: unit tests for `lookupLinkedChurches` (email match, mobile match, `person_id`
  match, and the "no match" case), and for `switch-church`'s rejection paths (church
  not approved, target user inactive, target church not actually linked).
- Server: admin `link`/`unlink` endpoints — new group creation, joining an existing
  group, unlink removing only one row.
- Client: `ChurchSwitcher` renders nothing clickable when `myChurches` is empty, renders
  a working dropdown when it isn't.
