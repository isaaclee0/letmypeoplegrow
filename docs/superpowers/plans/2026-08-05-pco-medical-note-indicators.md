# PCO Medical-Note Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize a boolean indicating whether each PCO-linked individual has medical notes, then show a configurable, role- and gathering-scoped icon in People and Take Attendance without exposing medical text.

**Architecture:** A dedicated server sync service is the only boundary that reads PCO's `medical_notes`; it immediately projects each Person to an ID/boolean pair and applies only complete snapshots. A church-scoped policy/settings service owns role hierarchy, relevant gatherings, icon/colour validation, existing-style discovery, and transactional badge adoption. People and attendance APIs return only an optional per-person boolean plus one response-level indicator appearance, rendered by a non-interactive shared React component.

**Tech Stack:** Node.js 26, Express 5, SQLite via `better-sqlite3`, Node's built-in test runner, React 19, TypeScript 6, Axios, Vitest, Testing Library, Tailwind CSS, Heroicons.

## Global Constraints

- Feature default: off.
- Persist only `pco_has_medical_notes`, configuration, safe refresh metadata, and content-free adoption audit metadata.
- Never persist or return medical-note text, excerpts, length, hashes, keywords, summaries, or raw PCO Person envelopes.
- The server may briefly read `Person.attributes.medical_notes` only inside the dedicated status-sync boundary.
- The browser never receives medical text or PCO credentials and has no live medical-note endpoint/modal.
- Minimum-role values are exactly `admin`, `coordinator`, and `attendance_taker`, applied hierarchically.
- Take Attendance requires the exact configured gathering plus current person assignment and existing viewer gathering access.
- People uses union eligibility across configured gatherings and remains admin/coordinator-only.
- Self check-in/kiosk, leader check-in, reports, exports, notifications, audit exports, WebSockets, sync plans/reviews, and offline change queues receive no medical fields.
- Indicator appearance is one valid existing `BadgeIcon` value plus a normalized six-digit hex colour.
- Indicator tooltip/accessibility text is fixed to `Medical note recorded`; no custom visible text.
- Existing-style adoption considers active and archived people but only exact icon-only badges with null/blank `badge_text`.
- Adoption requires explicit confirmation, server-side recount, one transaction, and content-free audit; it is not repeated on ordinary settings edits.
- The computed medical indicator never writes to ordinary `badge_text`, `badge_icon`, or `badge_color` after the one-time adoption cleanup.
- Disabling or disconnecting clears medical booleans but does not restore adopted manual badges.
- Use no new npm dependencies.
- Every SQL read/write is scoped by `church_id`.
- Follow additive-only migration conventions; do not drop columns or rebuild existing tables.
- Approved design: `docs/superpowers/specs/2026-08-05-pco-medical-note-indicators-design.md` at commit `f755228`.

## File Structure

### New files

- `server/services/planningCenter/medicalNotesPolicy.js` — validation, role hierarchy, settings, appearance discovery/adoption, visibility helpers, and disable/clear operation.
- `server/services/planningCenter/medicalNotesPolicy.test.js` — pure validation/role tests.
- `server/services/planningCenter/medicalNotesPolicy.dbintegration.test.js` — church isolation, gathering eligibility, discovery, adoption, audit, rollback, and disable tests.
- `server/services/planningCenter/medicalNotesSync.js` — immediate projection, complete sparse snapshot, boolean application, coalescing, and credential-epoch safety.
- `server/services/planningCenter/medicalNotesSync.test.js` — fetch/projection/coalescing/stale-credential tests.
- `server/services/planningCenter/medicalNotesSync.dbintegration.test.js` — complete application and sentinel non-persistence tests.
- `server/routes/attendance.medicalNotes.dbintegration.test.js` — attendance DTO gating tests.
- `client/src/components/icons/MedicalNoteIndicator.tsx` — non-interactive computed indicator.
- `client/src/components/icons/MedicalNoteIndicator.test.tsx` — appearance/accessibility/event-isolation tests.
- `client/src/components/integrations/PlanningCenterMedicalNotesSettings.tsx` — settings, existing-style picker, new appearance editor, warning, and refresh control.
- `client/src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx` — settings/adoption UI tests.
- `client/src/pages/AttendancePage.medicalNotes.test.tsx` — Take Attendance integration and offline-cache tests.

### Existing files to modify

- `server/config/schema.js`, `server/config/database.js`, `server/config/database.test.js` — base/additive schema.
- `server/routes/settings.js`, `server/routes/settings.integrations.dbintegration.test.js` — settings/discovery/manual refresh API.
- `server/services/peopleSync/pcoCredentialMigration.js`, `.dbintegration.test.js` — atomic disconnect clearing.
- `server/services/peopleSync/orchestrator.js`, `.test.js` — refresh after successful PCO apply.
- `server/services/peopleSync/scheduler.js`, `.test.js` — once-daily refresh under both toggles.
- `server/routes/individuals.js`, `server/routes/families.dbintegration.test.js` — People DTO boolean/appearance.
- `server/routes/attendance.js` — Take Attendance DTO boolean/appearance.
- `client/src/services/api.ts`, `client/src/services/api.test.ts` — typed contracts/settings methods.
- `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`, `.test.tsx` — mount settings section.
- `client/src/components/people/PersonCard.tsx` and focused tests — render computed indicator alongside normal badge.
- `client/src/pages/PeoplePage.tsx`, `client/src/pages/PeoplePage.externalSource.test.tsx` — People response appearance integration.
- `client/src/pages/AttendancePage.tsx` — attendance rendering and cache appearance.

---

### Task 1: Add the additive medical-indicator schema

**Files:**
- Modify: `server/config/schema.js`
- Modify: `server/config/database.js`
- Modify: `server/config/database.test.js`
- Create: `server/config/medicalNotesSchema.dbintegration.test.js`

**Interfaces:**
- Produces: `individuals.pco_has_medical_notes`, six `church_settings` fields, and `planning_center_medical_note_gatherings` in all new/migrated church databases.
- Consumes: existing per-church schema initialization and additive migration path.

- [ ] **Step 1: Write failing fresh-schema tests**

Create `medicalNotesSchema.dbintegration.test.js` using `withTestChurchDb`. Assert:

```js
const individualColumns = await Database.query('PRAGMA table_info(individuals)');
const medicalColumn = individualColumns.find(({ name }) => name === 'pco_has_medical_notes');
assert.equal(medicalColumn.notnull, 1);
assert.equal(medicalColumn.dflt_value, '0');

const settings = (await Database.query(
  `SELECT planning_center_medical_notes_enabled AS enabled,
          planning_center_medical_notes_minimum_role AS minimumRole,
          planning_center_medical_notes_badge_icon AS badgeIcon,
          planning_center_medical_notes_badge_color AS badgeColor,
          planning_center_medical_notes_last_refreshed_at AS refreshedAt,
          planning_center_medical_notes_last_refresh_result AS refreshResult
     FROM church_settings WHERE church_id = ?`,
  [churchId]
))[0];
assert.deepEqual(settings, {
  enabled: 0, minimumRole: 'admin', badgeIcon: null, badgeColor: null,
  refreshedAt: null, refreshResult: null,
});
```

Insert a relevant gathering row, delete the gathering, and assert foreign-key cascade removes the relevance row.

- [ ] **Step 2: Add a failing legacy migration test**

In `database.test.js`, follow the existing legacy temporary-database fixture. Start with `individuals`/`church_settings` lacking every new field and no relevance table. Reopen through production initialization and assert:

- all new fields/table/index exist;
- defaults are off/admin/null;
- existing individuals and settings values are preserved.

- [ ] **Step 3: Run schema tests and confirm red**

```bash
cd server
node --test config/medicalNotesSchema.dbintegration.test.js config/database.test.js
```

Expected: FAIL because the new column/settings/table do not exist.

- [ ] **Step 4: Add the base schema**

Add to `individuals`:

```sql
pco_has_medical_notes INTEGER NOT NULL DEFAULT 0,
```

Add to `church_settings`:

```sql
planning_center_medical_notes_enabled INTEGER NOT NULL DEFAULT 0,
planning_center_medical_notes_minimum_role TEXT NOT NULL DEFAULT 'admin',
planning_center_medical_notes_badge_icon TEXT,
planning_center_medical_notes_badge_color TEXT,
planning_center_medical_notes_last_refreshed_at TEXT,
planning_center_medical_notes_last_refresh_result TEXT,
```

After `gathering_types`, add:

```sql
CREATE TABLE IF NOT EXISTS planning_center_medical_note_gatherings (
  church_id TEXT NOT NULL,
  gathering_type_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (church_id, gathering_type_id),
  FOREIGN KEY (gathering_type_id) REFERENCES gathering_types(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pco_medical_gatherings_church
  ON planning_center_medical_note_gatherings(church_id);
```

- [ ] **Step 5: Add explicit migrations**

Extend the existing `individualsCols`/`settingsCols` checks in `database.js` with one `ALTER TABLE` per missing column. Add the exact table and index SQL from Step 4 unconditionally after prerequisite tables exist.

Do not use a generic loop that obscures differing SQL defaults/nullability.

- [ ] **Step 6: Run schema tests and confirm green**

```bash
cd server
node --test config/medicalNotesSchema.dbintegration.test.js config/database.test.js
```

Expected: PASS, zero failures.

- [ ] **Step 7: Commit**

```bash
git add server/config/schema.js server/config/database.js server/config/database.test.js server/config/medicalNotesSchema.dbintegration.test.js
git commit -m "feat(pco): add medical indicator schema"
```

---

### Task 2: Implement policy, appearance discovery, and transactional adoption

**Files:**
- Create: `server/services/planningCenter/medicalNotesPolicy.js`
- Create: `server/services/planningCenter/medicalNotesPolicy.test.js`
- Create: `server/services/planningCenter/medicalNotesPolicy.dbintegration.test.js`

**Interfaces:**
- Produces:
  - `MEDICAL_NOTE_ICONS: ReadonlySet<string>` with `person, star, heart, sparkles, fire, sun, moon, bolt, music, flag, trophy, book`.
  - `roleCanViewMedicalNotes(minimumRole, userRole): boolean`.
  - `normalizeMedicalNoteColor(value): string` returning lowercase `#rrggbb` or throwing `MEDICAL_NOTES_COLOR_INVALID`.
  - `getMedicalNotesSettings(churchId): Promise<MedicalSettings>`.
  - `listAdoptableBadgeAppearances(churchId): Promise<Array<{icon,color,count}>>`.
  - `saveMedicalNotesSettings(churchId, actor, input): Promise<{settings, adoptedCount}>`.
  - `disableMedicalNotesWithConnection(conn, churchId): Promise<void>`.
  - `isMedicalNotesRefreshEnabled(churchId): Promise<boolean>`.
  - `isUnattendedMedicalNotesRefreshEnabled(churchId): Promise<boolean>`.
  - `getMedicalNotesVisibility(churchId, userRole): Promise<{enabled, authorized, indicator, gatheringTypeIds}>`.
- Consumes: Task 1 schema and `Database.transactionForChurch`.

`MedicalSettings` is:

```js
{
  enabled: boolean,
  minimumRole: 'admin' | 'coordinator' | 'attendance_taker',
  gatheringTypeIds: number[],
  badgeIcon: string | null,
  badgeColor: string | null,
  lastRefreshedAt: string | null,
  lastRefreshResult: object | null,
}
```

`input` is the complete object:

```js
{
  enabled,
  minimumRole,
  gatheringTypeIds,
  badgeIcon,
  badgeColor,
  adoptExistingAppearance,
}
```

- [ ] **Step 1: Write failing pure validation tests**

Test the complete role matrix and invalid inputs:

```js
assert.equal(roleCanViewMedicalNotes('admin', 'admin'), true);
assert.equal(roleCanViewMedicalNotes('admin', 'coordinator'), false);
assert.equal(roleCanViewMedicalNotes('coordinator', 'admin'), true);
assert.equal(roleCanViewMedicalNotes('coordinator', 'attendance_taker'), false);
assert.equal(roleCanViewMedicalNotes('attendance_taker', 'attendance_taker'), true);
assert.equal(roleCanViewMedicalNotes('unknown', 'admin'), false);

assert.equal(normalizeMedicalNoteColor('#FACC15'), '#facc15');
assert.throws(() => normalizeMedicalNoteColor('yellow'), /MEDICAL_NOTES_COLOR_INVALID/);
assert.throws(() => normalizeMedicalNoteColor('#fff'), /MEDICAL_NOTES_COLOR_INVALID/);
```

Validate icons only against the explicit set. Normalize gathering IDs to sorted unique positive safe integers. Reject enabled settings without at least one gathering, icon, or colour.

- [ ] **Step 2: Write failing discovery tests**

Seed, in two churches:

- active `heart/#FACC15`, blank text;
- archived `heart/#facc15`, null text;
- text-bearing `heart/#facc15`;
- blank icon;
- invalid colour;
- different icon/colour.

Assert discovery returns only valid icon-only styles, groups colour case-insensitively, includes active + archived count `2`, sorts by count descending then icon/colour, and excludes the other church.

- [ ] **Step 3: Write failing save/adoption tests**

Cover:

- active standard same-church gatherings accepted; inactive/headcount/cross-church rejected;
- `adoptExistingAppearance:false` changes no individual badges even if appearance matches;
- `adoptExistingAppearance:true` recounts in-transaction and clears `badge_icon`/`badge_color` from all exact active + archived icon-only matches;
- text-bearing, different icon/colour, and cross-church badges remain;
- settings/gathering rows and audit commit with the authoritative count;
- audit `new_values` is exactly `{icon,color,affectedCount}` and contains no request-body spread/person names;
- injected failure after badge cleanup rolls back cleanup/settings/audit;
- a later role/gathering save with adoption false does not clear newly created matching manual badges;
- disable clears medical booleans but preserves role/gatherings/icon/colour.

- [ ] **Step 4: Run policy tests and confirm red**

```bash
cd server
node --test services/planningCenter/medicalNotesPolicy.test.js services/planningCenter/medicalNotesPolicy.dbintegration.test.js
```

Expected: FAIL because the policy module does not exist.

- [ ] **Step 5: Implement validation and role hierarchy**

Use:

```js
const ALLOWED_BY_MINIMUM = Object.freeze({
  admin: new Set(['admin']),
  coordinator: new Set(['admin', 'coordinator']),
  attendance_taker: new Set(['admin', 'coordinator', 'attendance_taker']),
});
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
```

Return bounded errors with `code` and `status=400`; do not include full inputs in messages.

- [ ] **Step 6: Implement discovery**

Use this church-scoped grouped query:

```sql
SELECT badge_icon AS icon, LOWER(badge_color) AS color, COUNT(*) AS count
FROM individuals
WHERE church_id = ?
  AND TRIM(COALESCE(badge_icon, '')) <> ''
  AND badge_color IS NOT NULL
  AND (badge_text IS NULL OR TRIM(badge_text) = '')
GROUP BY badge_icon, LOWER(badge_color)
```

Filter query results through the same icon/colour validators before returning them.

- [ ] **Step 7: Implement one transactional save/adoption**

Inside `Database.transactionForChurch`:

1. validate every gathering using `church_id`, `is_active=1`, `attendance_type='standard'`;
2. if adoption is true, recount exact matches using `badge_icon = ?`, `LOWER(badge_color) = ?`, and null/blank text;
3. clear only `badge_icon` and `badge_color` for the exact predicate;
4. update church settings;
5. replace that church's relevance rows;
6. insert `audit_log` action `ADOPT_PCO_MEDICAL_BADGE`, `entity_type='church_settings'`, and allowlisted JSON.

Use `actor = {userId, ipAddress, userAgent}`. Do not modify `individuals.updated_at` during cleanup.

- [ ] **Step 8: Implement read/disable/visibility helpers**

`isUnattendedMedicalNotesRefreshEnabled` must query both `planning_center_medical_notes_enabled=1` and `planning_center_sync_enabled=1`. `getMedicalNotesVisibility` returns `indicator:null` unless feature enabled, role authorized, and stored icon/colour validate.

- [ ] **Step 9: Run policy tests and confirm green**

```bash
cd server
node --test services/planningCenter/medicalNotesPolicy.test.js services/planningCenter/medicalNotesPolicy.dbintegration.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/services/planningCenter/medicalNotesPolicy.js server/services/planningCenter/medicalNotesPolicy.test.js server/services/planningCenter/medicalNotesPolicy.dbintegration.test.js
git commit -m "feat(pco): configure medical indicator policy"
```

---

### Task 3: Synchronize boolean medical-note presence safely

**Files:**
- Create: `server/services/planningCenter/medicalNotesSync.js`
- Create: `server/services/planningCenter/medicalNotesSync.test.js`
- Create: `server/services/planningCenter/medicalNotesSync.dbintegration.test.js`

**Interfaces:**
- Produces:
  - `projectMedicalNotePerson(resource): {id:string, hasMedicalNotes:boolean}`.
  - `fetchMedicalNoteSnapshot(options): Promise<{fetchedAt, complete:true, people:Array<{id,hasMedicalNotes}>}>`.
  - `applyMedicalNoteSnapshot(churchId, snapshot): Promise<{fetchedAt,updated,present,absent,clearedStale}>`.
  - `refreshMedicalNoteStatuses(churchId, overrides?): Promise<RefreshResult>`.
  - `invalidateMedicalNoteStatusCache(churchId?): void`.
- Consumes: Task 2 refresh-enabled helper, `createPcoReadClient`, `withPlanningCenterSourceToken`, and `accountCoordinator`.

- [ ] **Step 1: Write failing projection/fetch tests**

Use `MEDICAL_SENTINEL_DO_NOT_PERSIST_8F3A` and assert missing/null/non-string/blank/whitespace map false, sentinel maps true, and:

```js
const projected = projectMedicalNotePerson(rawPerson(MEDICAL_SENTINEL));
assert.deepEqual(projected, { id: 'p1', hasMedicalNotes: true });
assert.equal(JSON.stringify(projected).includes(MEDICAL_SENTINEL), false);
```

Mock two pages. Assert every initial request uses `fields[Person]=medical_notes`, no `include`, all pages complete, malformed type/ID rejects, and raw resources never enter the normalized array.

- [ ] **Step 2: Write failing refresh/coalescing tests**

Following `backgroundCheckSync.test.js`, cover:

- disabled skips credential and provider reads;
- concurrent same-church calls share one fetch/apply;
- successful boolean snapshot caches for 60 seconds and re-applies without another provider read;
- church caches are isolated;
- cache invalidation during a fetch prevents stale application and permits one fresh-credential retry;
- incomplete/malformed fetch never calls apply.

- [ ] **Step 3: Write failing database-application tests**

Seed active linked, absent-from-provider, inactive, unlinked, and other-church people. Assert a complete snapshot:

- writes only `0`/`1` to active linked people;
- sets absent linked people false;
- clears stale inactive/unlinked flags;
- preserves `updated_at`;
- updates only the target church;
- stores only safe counts/timestamp in settings;
- leaves the sentinel absent from every table returned by `sqlite_master`.

Assert `{complete:false}` changes no flags or success metadata.

- [ ] **Step 4: Run sync tests and confirm red**

```bash
cd server
node --test services/planningCenter/medicalNotesSync.test.js services/planningCenter/medicalNotesSync.dbintegration.test.js
```

Expected: FAIL because the sync module does not exist.

- [ ] **Step 5: Implement immediate projection and sparse complete fetch**

Use the exact projection:

```js
function projectMedicalNotePerson(resource) {
  const id = resource?.id == null ? '' : String(resource.id).trim();
  if (resource?.type !== 'Person' || !id) {
    throw new PcoSourceError('Planning Center People contains a malformed Person resource', 'SYNC_SOURCE_INCOMPLETE', {});
  }
  const value = resource.attributes?.medical_notes;
  return { id, hasMedicalNotes: typeof value === 'string' && value.trim().length > 0 };
}
```

Call `getAll` with `${API}/people?per_page=100&fields%5BPerson%5D=medical_notes` and project inside the page callback so each raw page can be discarded.

- [ ] **Step 6: Implement complete transactional application**

Reject before transaction unless `complete === true` and every normalized row has a nonblank ID/boolean. In `transactionForChurch`, clear stale inactive/unlinked flags, load active linked rows, update exact `(id,church_id,planning_center_id)` records, and write safe counts/timestamp. Do not update person `updated_at`.

- [ ] **Step 7: Implement coalescing and credential epochs**

Mirror the proven `backgroundCheckSync.js` structure with separate maps:

```js
const SUCCESS_CACHE_TTL_MS = 60_000;
const MAX_STALE_CREDENTIAL_RETRIES = 1;
```

Check the feature toggle before token acquisition. Cache only the normalized boolean snapshot. Sanitize logs to safe codes/counts.

- [ ] **Step 8: Run sync tests and confirm green**

```bash
cd server
node --test services/planningCenter/medicalNotesSync.test.js services/planningCenter/medicalNotesSync.dbintegration.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/services/planningCenter/medicalNotesSync.js server/services/planningCenter/medicalNotesSync.test.js server/services/planningCenter/medicalNotesSync.dbintegration.test.js
git commit -m "feat(pco): refresh medical note indicators"
```

---

### Task 4: Add settings endpoints, refresh triggers, and disconnect clearing

**Files:**
- Modify: `server/routes/settings.js`
- Modify: `server/routes/settings.integrations.dbintegration.test.js`
- Modify: `server/services/peopleSync/pcoCredentialMigration.js`
- Modify: `server/services/peopleSync/pcoCredentialMigration.dbintegration.test.js`
- Modify: `server/services/peopleSync/orchestrator.js`
- Modify: `server/services/peopleSync/orchestrator.test.js`
- Modify: `server/services/peopleSync/scheduler.js`
- Modify: `server/services/peopleSync/scheduler.test.js`

**Interfaces:**
- Produces:
  - admin-only nested `planningCenterMedicalNotes` on `GET /api/settings/integrations`;
  - admin-only `GET /api/settings/integrations/planning-center/medical-notes/badge-appearances`;
  - complete-object settings save through existing `PUT /api/settings/integrations`;
  - admin-only `POST /api/settings/integrations/planning-center/medical-notes/refresh`;
  - post-PCO-apply and once-daily refresh triggers;
  - atomic disconnect disable/clear.
- Consumes: Tasks 2–3 and `pcoCredentialMigration.getOrMigrateCredentials`.

- [ ] **Step 1: Expand the settings route harness and write failing endpoint tests**

Add GET/PUT/POST support and admin/coordinator tokens. Assert:

- admin GET receives complete settings; coordinator GET omits medical settings;
- appearance endpoint returns only `{icon,color,count}` from Task 2;
- PUT accepts only a complete nested object and passes actor metadata explicitly;
- enabling requires an existing/migratable PCO connection;
- invalid icon/colour/role/gatherings map to bounded 400 codes;
- explicit adoption returns authoritative `adoptedCount`;
- enabling persists settings then invokes initial refresh;
- initial refresh failure keeps settings enabled and returns sanitized 502 `MEDICAL_NOTES_PROVIDER_UNAVAILABLE`;
- disabling clears flags;
- manual refresh is admin-only, uses Task 3, and returns safe counts only.

- [ ] **Step 2: Write failing disconnect tests**

Seed a connection, enabled feature, true flags, saved icon/colour/role/gatherings, and previously adopted badge state. After disconnect, assert connection absent, feature off, flags false, configuration retained, and cleared manual badges not restored. Inject transaction failure and assert all disconnect/medical state rolls back.

- [ ] **Step 3: Write failing post-sync and scheduler tests**

In orchestrator tests, inject `refreshMedicalNoteStatuses` and assert:

- successful PCO apply invokes it independently of background-check refresh;
- Elvanto does not invoke it;
- its failure is sanitized/best-effort and cannot fail an already-applied sync;
- background-check and medical refresh failures do not suppress each other.

In scheduler tests, inject `isUnattendedMedicalNotesRefreshEnabled` and `refreshMedicalNoteStatuses`. Assert exactly once per church per daily run, even with zero/multiple due batches or Elvanto authority; skip under either toggle; isolate failure between churches.

- [ ] **Step 4: Run focused tests and confirm red**

```bash
cd server
node --test routes/settings.integrations.dbintegration.test.js services/peopleSync/pcoCredentialMigration.dbintegration.test.js services/peopleSync/orchestrator.test.js services/peopleSync/scheduler.test.js
```

Expected: FAIL on missing endpoints/triggers/clearing.

- [ ] **Step 5: Implement the settings routes**

For the nested update accept exactly:

```js
planningCenterMedicalNotes: {
  enabled,
  minimumRole,
  gatheringTypeIds,
  badgeIcon,
  badgeColor,
  adoptExistingAppearance,
}
```

When enabling, verify `getOrMigrateCredentials(churchId)` returns credentials before Task 2 save. Save first, then refresh outside the transaction. Do not pass the whole request body into audit; Task 2 receives `{userId,ipAddress,userAgent}`.

- [ ] **Step 6: Extend atomic PCO disconnect**

Inside `pcoCredentialMigration.disconnectConnection`'s existing credential transaction, after authority checks and before return:

```js
await medicalNotesPolicy.disableMedicalNotesWithConnection(conn, churchId);
```

After successful commit, invalidate Task 3's medical snapshot cache. Never invalidate within a transaction that may roll back.

- [ ] **Step 7: Add best-effort post-apply refresh**

Extend `safeSyncProviderExtras` so Planning Center background-check and medical refreshes execute in separate try/catch blocks. Keep medical booleans/text out of plan/run payloads; safe refresh counts already live in church settings.

- [ ] **Step 8: Add independent daily refresh**

At the beginning of `scheduler.runChurch`'s church context, before people-sync authority loading, call the medical refresh once if `isUnattendedMedicalNotesRefreshEnabled(churchId)` is true. This prevents authority-read failure or Elvanto authority from suppressing it. Log only a bounded safe code on failure.

- [ ] **Step 9: Run focused tests and confirm green**

```bash
cd server
node --test routes/settings.integrations.dbintegration.test.js services/peopleSync/pcoCredentialMigration.dbintegration.test.js services/peopleSync/orchestrator.test.js services/peopleSync/scheduler.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/routes/settings.js server/routes/settings.integrations.dbintegration.test.js server/services/peopleSync/pcoCredentialMigration.js server/services/peopleSync/pcoCredentialMigration.dbintegration.test.js server/services/peopleSync/orchestrator.js server/services/peopleSync/orchestrator.test.js server/services/peopleSync/scheduler.js server/services/peopleSync/scheduler.test.js
git commit -m "feat(pco): wire medical indicator settings"
```

---

### Task 5: Gate People and attendance DTOs

**Files:**
- Modify: `server/routes/individuals.js`
- Modify: `server/routes/families.dbintegration.test.js`
- Modify: `server/routes/attendance.js`
- Create: `server/routes/attendance.medicalNotes.dbintegration.test.js`

**Interfaces:**
- Produces: `hasMedicalNotes?: boolean` on eligible rows and root `medicalNotesIndicator?: {icon,color}` on authorized eligible responses.
- Consumes: Task 2 `getMedicalNotesVisibility` and Task 1 fields/table.

- [ ] **Step 1: Write failing People DTO tests**

Extend the individuals route test harness with role tokens and relevant/unrelated gathering assignments. Assert:

- admin/coordinator receive root appearance only when threshold authorizes them;
- eligible people in the union receive true/false booleans;
- below-threshold users receive neither root appearance nor own-property `hasMedicalNotes`;
- unlinked, inactive, and people outside relevant gatherings omit the field;
- response JSON contains neither `medical_notes` nor sentinel text;
- existing normal badge and background-check fields remain unchanged.

- [ ] **Step 2: Write failing attendance DTO tests**

Against `GET /api/attendance/:gatheringTypeId/:date/full`, assert:

- exact configured gathering + authorized role returns root appearance and booleans on currently assigned regular/visitor rows;
- false remains false for eligible rows;
- unconfigured gathering or below-threshold role omits root/row fields;
- **All People** unassigned rows omit the field;
- kiosk/leader routes and responses contain no medical field/appearance;
- no response contains sentinel text.

- [ ] **Step 3: Run route tests and confirm red**

```bash
cd server
node --test routes/families.dbintegration.test.js routes/attendance.medicalNotes.dbintegration.test.js
```

Expected: FAIL because DTO gating is absent.

- [ ] **Step 4: Implement People union gating**

Load Task 2 visibility once. Only for enabled/authorized settings add a computed `EXISTS` over `gathering_lists` joined to `planning_center_medical_note_gatherings` by both gathering and church. Map `hasMedicalNotes` only for eligible active linked rows. Add root `medicalNotesIndicator` once.

- [ ] **Step 5: Implement exact attendance gating**

At request start, compute whether the exact gathering is configured and viewer is authorized. Only then select/map `i.pco_has_medical_notes` in queries already constrained to current gathering assignment. Add root appearance once. Explicitly omit it from `allChurchPeople` and all excluded routes.

- [ ] **Step 6: Run route tests and confirm green**

```bash
cd server
node --test routes/families.dbintegration.test.js routes/attendance.medicalNotes.dbintegration.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/routes/individuals.js server/routes/families.dbintegration.test.js server/routes/attendance.js server/routes/attendance.medicalNotes.dbintegration.test.js
git commit -m "feat(pco): expose scoped medical indicators"
```

---

### Task 6: Build the integration settings UI and adoption warning

**Files:**
- Modify: `client/src/services/api.ts`
- Modify: `client/src/services/api.test.ts`
- Create: `client/src/components/integrations/PlanningCenterMedicalNotesSettings.tsx`
- Create: `client/src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx`

**Interfaces:**
- Produces:
  - `MedicalNotesMinimumRole`.
  - `PlanningCenterMedicalNotesSettingsDto`.
  - `MedicalBadgeAppearance {icon: BadgeIconType, color:string, count:number}`.
  - typed GET/update/discovery/manual-refresh methods.
  - standalone settings component mounted in the connected PCO panel.
- Consumes: Task 4 endpoints, `gatheringsAPI.getAll`, `BADGE_ICON_OPTIONS`, `BadgeIcon`, and existing colour inputs/styles.

- [ ] **Step 1: Write failing API contract tests**

Assert methods use:

```ts
GET  /settings/integrations
PUT  /settings/integrations
GET  /settings/integrations/planning-center/medical-notes/badge-appearances
POST /settings/integrations/planning-center/medical-notes/refresh
```

The PUT sends the complete nested object and never person IDs/names or medical text.

- [ ] **Step 2: Write failing standalone component tests**

Mock settings, active standard/inactive/headcount gatherings, and appearances. Cover:

- default off/admin values;
- only active standard gatherings selectable;
- icon options come from `BADGE_ICON_OPTIONS` and colour normalizes to six-digit hex;
- enable validation requires gathering/icon/colour;
- existing choices show icon, colour, and `2 people` including archived scope copy;
- text-bearing styles are absent because server did not return them;
- selecting existing style and clicking Save opens warning with exact preview count;
- Cancel sends no mutation;
- Confirm sends `adoptExistingAppearance:true` and displays authoritative returned count;
- create-new save sends `adoptExistingAppearance:false` and opens no destructive warning;
- later role/gathering save keeps adoption false;
- initial refresh failure leaves enabled state and shows safe retry;
- manual refresh prevents duplicate clicks and reloads last-success metadata;
- privacy copy says LMPG stores only presence and details remain in Planning Center.

- [ ] **Step 3: Write failing panel mount tests**

Assert connected PCO panel includes **Medical-note indicators**, disconnected panel does not expose editable controls, and existing sync/background-check controls remain unaffected.

- [ ] **Step 4: Run client settings tests and confirm red**

```bash
cd client
npm test -- src/services/api.test.ts src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx
```

Expected: FAIL because types/methods/component are absent.

- [ ] **Step 5: Add exact client types and API methods**

```ts
export type MedicalNotesMinimumRole = 'admin' | 'coordinator' | 'attendance_taker';
export interface PlanningCenterMedicalNotesSettingsDto {
  enabled: boolean;
  minimumRole: MedicalNotesMinimumRole;
  gatheringTypeIds: number[];
  badgeIcon: BadgeIconType | null;
  badgeColor: string | null;
  lastRefreshedAt: string | null;
  lastRefreshResult: { updated:number; present:number; absent:number; clearedStale:number } | null;
}
```

`MedicalBadgeAppearance` contains only icon/colour/count.

- [ ] **Step 6: Implement the standalone settings component**

Load settings, gatherings, and adoptable appearances concurrently with a generation ref to ignore late responses. Track selection mode `'existing'|'new'`. Reuse `BADGE_ICON_OPTIONS`, `BadgeIcon`, an `<input type="color">`, and validated hex text input patterns from `BadgeEditor`/`SettingsPage` without adding badge text.

Keep the destructive confirmation local until confirmed. Render the exact fixed preview label `Medical note recorded` and approved warning copy with active + archived scope.

- [ ] **Step 7: Mount it in the connected integration panel**

Place it among church-wide PCO settings, outside batch editors. Its mutation/loading state is independent from batch/source controls.

- [ ] **Step 8: Run client settings tests and confirm green**

```bash
cd client
npm test -- src/services/api.test.ts src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx src/components/integrations/PlanningCenterIntegrationPanel.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add client/src/services/api.ts client/src/services/api.test.ts client/src/components/integrations/PlanningCenterMedicalNotesSettings.tsx client/src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.tsx client/src/components/integrations/PlanningCenterIntegrationPanel.test.tsx
git commit -m "feat(pco): configure medical indicator appearance"
```

---

### Task 7: Render the computed indicator in People and Take Attendance

**Files:**
- Create: `client/src/components/icons/MedicalNoteIndicator.tsx`
- Create: `client/src/components/icons/MedicalNoteIndicator.test.tsx`
- Modify: `client/src/services/api.ts`
- Modify: `client/src/components/people/PersonCard.tsx`
- Create: `client/src/components/people/PersonCard.medicalNotes.test.tsx`
- Modify: `client/src/pages/PeoplePage.tsx`
- Modify: `client/src/pages/PeoplePage.externalSource.test.tsx`
- Modify: `client/src/pages/AttendancePage.tsx`
- Create: `client/src/pages/AttendancePage.medicalNotes.test.tsx`

**Interfaces:**
- Produces: `MedicalNoteIndicator({icon,color,className?})`, `hasMedicalNotes?:boolean`, and response-level `medicalNotesIndicator?:{icon,color}` types.
- Consumes: Task 5 DTOs and existing `BadgeIcon`/`getChildBadgeStyles`.

- [ ] **Step 1: Write failing indicator tests**

Assert:

- valid heart/yellow renders `BadgeIcon` with styles from `getChildBadgeStyles`;
- wrapper has `title` and `aria-label` exactly `Medical note recorded`;
- no button/link/modal exists;
- click/pointer events do not propagate to a parent row handler;
- invalid/missing appearance returns null rather than falling back to a different icon.

- [ ] **Step 2: Write failing PersonCard/People tests**

Render one person with ordinary star/red badge plus `hasMedicalNotes:true` and root heart/yellow appearance. Assert both distinct icons render. Assert false/omitted booleans do not render medical indicator and card selection is not triggered by indicator interaction.

At PeoplePage level, mock response root appearance plus eligible/ineligible rows and assert only true eligible rows render it across grouped and individual views.

- [ ] **Step 3: Write failing attendance/offline-cache tests**

Mock the full attendance response. Assert:

- true regular and eligible visitor rows render indicator;
- false/omitted rows and **All People** do not;
- indicator interaction does not toggle attendance/add person;
- response root appearance is saved with existing `attendance_cached_data` and restored with cached booleans;
- no cache/state/network fixture contains `medical_notes`, `medicalNotes`, or sentinel text;
- switching to an unauthorized/unconfigured response clears prior appearance state.

- [ ] **Step 4: Run rendering tests and confirm red**

```bash
cd client
npm test -- src/components/icons/MedicalNoteIndicator.test.tsx src/components/people/PersonCard.medicalNotes.test.tsx src/pages/PeoplePage.externalSource.test.tsx src/pages/AttendancePage.medicalNotes.test.tsx
```

Expected: FAIL because indicator integration is absent.

- [ ] **Step 5: Implement the non-interactive indicator**

Use a non-button wrapper:

```tsx
<span
  aria-label="Medical note recorded"
  title="Medical note recorded"
  onClick={(event) => event.stopPropagation()}
  onPointerDown={(event) => event.stopPropagation()}
  style={getChildBadgeStyles(color)}
  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
>
  <BadgeIcon type={icon} className="h-4 w-4" />
</span>
```

Validate the icon against `BADGE_ICON_OPTIONS` and colour against `^#[0-9a-fA-F]{6}$` before rendering.

- [ ] **Step 6: Integrate PersonCard and PeoplePage**

Add optional appearance prop to `PersonCard`; render the medical indicator beside the name separately from the existing floating ordinary badge. `PeoplePage` reads `response.data.medicalNotesIndicator`, stores it in page memory, and passes it through every `AuthorityPersonCard` site. A missing root appearance sets state to null.

- [ ] **Step 7: Integrate AttendancePage and cache**

Add `medicalNotesIndicator` state. Fresh response always replaces it, including null. Add it to `attendance_cached_data` beside lists/timestamp and restore it only from the relevant gathering/date cache. Render only in main assigned regular/visitor name paths; never **All People**, headcount, kiosk, or leader components.

- [ ] **Step 8: Run rendering tests and confirm green**

```bash
cd client
npm test -- src/components/icons/MedicalNoteIndicator.test.tsx src/components/people/PersonCard.medicalNotes.test.tsx src/pages/PeoplePage.externalSource.test.tsx src/pages/AttendancePage.medicalNotes.test.tsx src/pages/AttendancePage.groupByFamily.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add client/src/components/icons/MedicalNoteIndicator.tsx client/src/components/icons/MedicalNoteIndicator.test.tsx client/src/services/api.ts client/src/components/people/PersonCard.tsx client/src/components/people/PersonCard.medicalNotes.test.tsx client/src/pages/PeoplePage.tsx client/src/pages/PeoplePage.externalSource.test.tsx client/src/pages/AttendancePage.tsx client/src/pages/AttendancePage.medicalNotes.test.tsx
git commit -m "feat(pco): render medical note indicators"
```

---

### Task 8: Verify privacy, regressions, and production build

**Files:**
- Verification only; no planned file changes.

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: fresh evidence for privacy invariants, focused behavior, and build correctness.

- [ ] **Step 1: Scan sensitive-field boundaries**

```bash
rg -n "medical_notes|medicalNotes|pco_has_medical_notes|hasMedicalNotes|medicalNotesIndicator" server client/src
rg -n "localStorage|sessionStorage|indexedDB|caches\.|emit\(|audit_log|new_values" server/services/planningCenter/medicalNotesSync.js server/services/planningCenter/medicalNotesPolicy.js client/src
```

Expected:

- raw `medical_notes` appears only in Task 3 projection/fetch/tests and PCO documentation comments;
- no medical text property appears in API DTOs/client state;
- only boolean/root appearance enters the permitted attendance cache;
- excluded routes/exports/WebSockets/offline queues contain no medical fields;
- adoption audit uses allowlisted icon/colour/count only.

- [ ] **Step 2: Run the focused server suite**

```bash
cd server
node --test \
  config/medicalNotesSchema.dbintegration.test.js \
  config/database.test.js \
  services/planningCenter/medicalNotesPolicy.test.js \
  services/planningCenter/medicalNotesPolicy.dbintegration.test.js \
  services/planningCenter/medicalNotesSync.test.js \
  services/planningCenter/medicalNotesSync.dbintegration.test.js \
  services/peopleSync/pcoCredentialMigration.dbintegration.test.js \
  services/peopleSync/orchestrator.test.js \
  services/peopleSync/scheduler.test.js \
  routes/settings.integrations.dbintegration.test.js \
  routes/families.dbintegration.test.js \
  routes/attendance.medicalNotes.dbintegration.test.js
```

Expected: exit 0, zero failed tests.

- [ ] **Step 3: Run the focused client suite**

```bash
cd client
npm test -- \
  src/services/api.test.ts \
  src/components/integrations/PlanningCenterMedicalNotesSettings.test.tsx \
  src/components/integrations/PlanningCenterIntegrationPanel.test.tsx \
  src/components/icons/MedicalNoteIndicator.test.tsx \
  src/components/people/PersonCard.medicalNotes.test.tsx \
  src/pages/PeoplePage.externalSource.test.tsx \
  src/pages/AttendancePage.medicalNotes.test.tsx \
  src/pages/AttendancePage.groupByFamily.test.ts
```

Expected: exit 0, zero failed tests.

- [ ] **Step 4: Run the production build**

```bash
cd client
npm run build
```

Expected: service-worker generation and Vite build exit 0. Confirm no medical-note detail endpoint exists in generated assets/service-worker routes.

- [ ] **Step 5: Perform manual adoption and sentinel verification**

Using the approved spec's ten-step manual verification:

1. seed active + archived heart/yellow icon-only badges plus text/different-colour controls;
2. confirm discovery count and text-badge exclusion;
3. cancel adoption and confirm no mutation;
4. confirm adoption and exact cleanup/audit count;
5. refresh with `MEDICAL_SENTINEL_DO_NOT_PERSIST_8F3A` in PCO;
6. inspect SQLite, logs, audit, network responses, sync artifacts, and browser storage/state for the sentinel;
7. verify all role/gathering combinations in People/Take Attendance;
8. verify ordinary badge and computed medical indicator coexist;
9. verify excluded surfaces/queues contain no medical fields;
10. disable/disconnect and confirm booleans clear without badge restoration.

Expected: sentinel appears nowhere in LMPG-controlled persistence, responses, logs, or client state.

- [ ] **Step 6: Review final change scope**

```bash
git diff --check
git status --short
git diff --stat f755228..HEAD
git log --oneline --decorate -10
```

Confirm no unrelated refactor, dependency, generated build artifact, data file, or credential is included.

- [ ] **Step 7: Stop on any failure**

If a verification step fails, do not claim completion. Return to the task owning the failing file, add/tighten its focused regression test, make the smallest correction, rerun that task's command, then repeat Task 8 from Step 1. Do not create an empty verification commit.

---

## Completion Checklist

- [ ] Default-off additive schema verified for new and migrated churches.
- [ ] Complete PCO snapshots persist booleans only; incomplete snapshots do not mutate state.
- [ ] Every active linked person is covered independently of batch membership.
- [ ] Role hierarchy and relevant gatherings are enforced server-side.
- [ ] Existing-style discovery includes active/archived icon-only badges and excludes text/cross-church/invalid styles.
- [ ] Confirmed adoption recounts, clears exact matches, saves settings, and audits atomically.
- [ ] Creating a new appearance and ordinary later settings edits clear no person badges.
- [ ] Disconnect/disable clears booleans but preserves appearance/role/gatherings and does not restore badges.
- [ ] People and Take Attendance return only optional booleans plus one root appearance.
- [ ] Computed indicator coexists with ordinary badges and is non-interactive/accessibly labelled.
- [ ] Excluded surfaces contain no medical fields.
- [ ] Sentinel is absent from persistence, logs, audits, sync artifacts, API responses, and client storage/state.
- [ ] Focused server/client tests and production build pass.
