# PCO: Remove Blind Apply, Notify on Review-Needed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the two places Planning Center batch sync applies with zero human review ("Run now" in Settings, and onboarding's first-batch auto-apply), and notify admins/coordinators when a scheduled (unattended) sync run leaves ambiguous matches, visitor-match suggestions, family-name updates, or reconciliation archives that need a look.

**Architecture:** A new pure module (`server/services/planningCenter/reviewNotification.js`) holds the decision logic for whether to notify and what to say — kept separate from DB/network code so it's unit-testable like the rest of `services/planningCenter/`. `planningCenterSync.js`'s existing cron entry point (`syncChurch`) aggregates counts across everything it runs each night and calls into that module, writing to the existing `notifications` table (same mechanism `weeklyReviewScheduler.js` already uses) with a small new `church_settings` column to remember what was last notified (avoids re-notifying every night for an unchanged, still-unresolved situation). Two client-only changes remove the blind-apply UI paths.

**Tech Stack:** Node.js/Express + SQLite (`better-sqlite3`) backend, React/TypeScript frontend, `node:test` + `node:assert` for server unit tests (this codebase's existing convention — no Jest, no DB/HTTP mocking framework in use).

**Spec:** [docs/superpowers/specs/2026-07-09-pco-batch-review-notifications-design.md](../specs/2026-07-09-pco-batch-review-notifications-design.md)

**Task order matters:** Task 2 (schema) must land before Task 4 (which queries the new column) — the task list below is already sequenced correctly; don't reorder if executing task-by-task out of this file.

---

## File Structure

- **Create** `server/services/planningCenter/reviewNotification.js` — pure functions: `reviewNotificationDecision(prev, totals)` and `buildPcoReviewMessage(totals)`. No DB, no network — mirrors the existing `summary.js`/`eligibility.js` pattern in this directory.
- **Create** `server/services/planningCenter/reviewNotification.test.js` — unit tests for the above.
- **Modify** `server/config/schema.js` — add `planning_center_last_notified_review TEXT` to the `church_settings` table.
- **Modify** `server/config/database.js` — additive migration for the same column, for existing church databases.
- **Modify** `server/services/planningCenterSync.js` — `runBatchSync`/`runReconciliationSync` return their summaries instead of discarding them; new `maybeNotifyPcoReviewNeeded(churchId, totals)`; `syncChurch` aggregates and calls it.
- **Modify** `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx` — remove the "Run now" button, `runBatchNow` handler, and `runningBatchId` state.
- **Modify** `client/src/pages/OnboardingPage.tsx` — replace the first batch's blind auto-apply with a new `pco-review` wizard step that shows the existing review screen.
- **Modify** `docs/PCO_INTEGRATION_ANALYSIS.md` — mark items #4, #5, #6, #11 in the "Implementation Gaps" list as fixed/mitigated, once the above lands.

---

### Task 1: Pure review-notification decision logic

**Files:**
- Create: `server/services/planningCenter/reviewNotification.js`
- Test: `server/services/planningCenter/reviewNotification.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/services/planningCenter/reviewNotification.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { reviewNotificationDecision, buildPcoReviewMessage } = require('./reviewNotification');

const ZERO = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 0 };

test('reviewNotificationDecision: all zero with no prior snapshot does not notify or clear', () => {
  const result = reviewNotificationDecision(null, ZERO);
  assert.deepStrictEqual(result, { notify: false, clear: false });
});

test('reviewNotificationDecision: all zero with a prior snapshot clears it without notifying', () => {
  const prev = { ambiguous: 2, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 0 };
  const result = reviewNotificationDecision(prev, ZERO);
  assert.deepStrictEqual(result, { notify: false, clear: true });
});

test('reviewNotificationDecision: nonzero with no prior snapshot notifies', () => {
  const totals = { ambiguous: 3, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 0 };
  const result = reviewNotificationDecision(null, totals);
  assert.deepStrictEqual(result, { notify: true, clear: false });
});

test('reviewNotificationDecision: identical to prior snapshot does not notify again', () => {
  const totals = { ambiguous: 3, visitorMatches: 1, familyNameUpdatesPending: 2, reconciliationArchived: 4 };
  const prev = { ambiguous: 3, visitorMatches: 1, familyNameUpdatesPending: 2, reconciliationArchived: 4 };
  const result = reviewNotificationDecision(prev, totals);
  assert.deepStrictEqual(result, { notify: false, clear: false });
});

test('reviewNotificationDecision: a changed count notifies again', () => {
  const prev = { ambiguous: 3, visitorMatches: 1, familyNameUpdatesPending: 2, reconciliationArchived: 4 };
  const totals = { ambiguous: 5, visitorMatches: 1, familyNameUpdatesPending: 2, reconciliationArchived: 4 };
  const result = reviewNotificationDecision(prev, totals);
  assert.deepStrictEqual(result, { notify: true, clear: false });
});

test('reviewNotificationDecision: only reconciliationArchived changing still notifies', () => {
  const prev = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 4 };
  const totals = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 7 };
  const result = reviewNotificationDecision(prev, totals);
  assert.deepStrictEqual(result, { notify: true, clear: false });
});

test('buildPcoReviewMessage: singular ambiguous match', () => {
  const totals = { ambiguous: 1, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 0 };
  assert.strictEqual(buildPcoReviewMessage(totals), '1 ambiguous match need review in Review & Sync.');
});

test('buildPcoReviewMessage: plural counts across all three review-needed buckets', () => {
  const totals = { ambiguous: 3, visitorMatches: 2, familyNameUpdatesPending: 1, reconciliationArchived: 0 };
  assert.strictEqual(
    buildPcoReviewMessage(totals),
    '3 ambiguous matches, 2 possible visitor matches, 1 family name update need review in Review & Sync.'
  );
});

test('buildPcoReviewMessage: reconciliation-only archives with nothing else pending', () => {
  const totals = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 4 };
  assert.strictEqual(
    buildPcoReviewMessage(totals),
    'Reconciliation also archived 4 people you may want to double-check.'
  );
});

test('buildPcoReviewMessage: singular archived person', () => {
  const totals = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 1 };
  assert.strictEqual(
    buildPcoReviewMessage(totals),
    'Reconciliation also archived 1 person you may want to double-check.'
  );
});

test('buildPcoReviewMessage: combines pending-review sentence and archived sentence', () => {
  const totals = { ambiguous: 2, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 3 };
  assert.strictEqual(
    buildPcoReviewMessage(totals),
    '2 ambiguous matches need review in Review & Sync. Reconciliation also archived 3 people you may want to double-check.'
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (inside the running dev server container — this repo runs entirely in Docker, see `CLAUDE.md`):

```bash
docker compose -f docker-compose.dev.yml up -d server
docker compose -f docker-compose.dev.yml exec server sh -c "node --test services/planningCenter/reviewNotification.test.js"
```

Expected: FAIL — `Cannot find module './reviewNotification'` (the file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `server/services/planningCenter/reviewNotification.js`:

```js
// Pure decision logic for whether a scheduled PCO sync run should notify admins
// that something needs review. Kept separate from planningCenterSync.js (which
// does the DB/network work) so this logic — the part most likely to have a
// subtle comparison bug — can be unit tested without mocking DB or HTTPS
// calls, matching how the rest of services/planningCenter/ is tested.

// totals/prev shape: { ambiguous, visitorMatches, familyNameUpdatesPending, reconciliationArchived }
// prev is null if there is no prior notification on record.
// Returns { notify, clear }:
//   - notify: create a new notification now
//   - clear: reset the stored "last notified" snapshot to null (everything is
//     resolved, so a future reappearance notifies fresh instead of being
//     compared against a stale, no-longer-relevant snapshot)
function reviewNotificationDecision(prev, totals) {
  const allZero = !totals.ambiguous && !totals.visitorMatches &&
    !totals.familyNameUpdatesPending && !totals.reconciliationArchived;
  if (allZero) {
    return { notify: false, clear: !!prev };
  }
  const unchanged = !!prev &&
    prev.ambiguous === totals.ambiguous &&
    prev.visitorMatches === totals.visitorMatches &&
    prev.familyNameUpdatesPending === totals.familyNameUpdatesPending &&
    prev.reconciliationArchived === totals.reconciliationArchived;
  return { notify: !unchanged, clear: false };
}

// Builds the notification body from whichever counts are nonzero. Returns ''
// for all-zero totals (callers should not be notifying in that case anyway).
function buildPcoReviewMessage(totals) {
  const parts = [];
  if (totals.ambiguous) {
    parts.push(`${totals.ambiguous} ambiguous match${totals.ambiguous === 1 ? '' : 'es'}`);
  }
  if (totals.visitorMatches) {
    parts.push(`${totals.visitorMatches} possible visitor match${totals.visitorMatches === 1 ? '' : 'es'}`);
  }
  if (totals.familyNameUpdatesPending) {
    parts.push(`${totals.familyNameUpdatesPending} family name update${totals.familyNameUpdatesPending === 1 ? '' : 's'}`);
  }

  const sentences = [];
  if (parts.length) sentences.push(`${parts.join(', ')} need review in Review & Sync.`);
  if (totals.reconciliationArchived) {
    sentences.push(`Reconciliation also archived ${totals.reconciliationArchived} ${totals.reconciliationArchived === 1 ? 'person' : 'people'} you may want to double-check.`);
  }
  return sentences.join(' ');
}

module.exports = { reviewNotificationDecision, buildPcoReviewMessage };
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
docker compose -f docker-compose.dev.yml exec server sh -c "node --test services/planningCenter/reviewNotification.test.js"
```

Expected: PASS, `# tests 12`, `# pass 12`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/services/planningCenter/reviewNotification.js server/services/planningCenter/reviewNotification.test.js
git commit -m "$(cat <<'EOF'
feat(pco): add pure decision logic for scheduled-run review notifications

Extracted as its own module so the notify/dedup comparison logic is unit
testable without mocking DB or HTTPS, matching the rest of
services/planningCenter/.
EOF
)"
```

---

### Task 2: Schema — `planning_center_last_notified_review` column

**Files:**
- Modify: `server/config/schema.js:128`
- Modify: `server/config/database.js:216` (after the `planning_center_field_definitions_cache` migration block)

- [ ] **Step 1: Add the column to the canonical schema**

In `server/config/schema.js`, replace:

```js
  planning_center_membership_cache TEXT,
  planning_center_field_definitions_cache TEXT,
  created_at TEXT DEFAULT (datetime('now')),
```

with:

```js
  planning_center_membership_cache TEXT,
  planning_center_field_definitions_cache TEXT,
  planning_center_last_notified_review TEXT,
  created_at TEXT DEFAULT (datetime('now')),
```

- [ ] **Step 2: Add the additive migration for existing church databases**

In `server/config/database.js`, replace:

```js
      if (!settingsCols.some(c => c.name === 'planning_center_field_definitions_cache')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_field_definitions_cache TEXT');
      }
```

with:

```js
      if (!settingsCols.some(c => c.name === 'planning_center_field_definitions_cache')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_field_definitions_cache TEXT');
      }
      if (!settingsCols.some(c => c.name === 'planning_center_last_notified_review')) {
        db.exec('ALTER TABLE church_settings ADD COLUMN planning_center_last_notified_review TEXT');
      }
```

- [ ] **Step 3: Restart the server and confirm the migration runs cleanly**

```bash
docker compose -f docker-compose.dev.yml restart server
sleep 3
docker compose -f docker-compose.dev.yml logs --tail=40 server
```

Expected: log shows `🔄 Checking migrations for church ...` for each existing church with no errors, then `✅ Server startup completed successfully`.

- [ ] **Step 4: Confirm the column actually exists on an existing church DB**

There's no `sqlite3` CLI in the server container (only native-module build tools —
see `Dockerfile.server.dev`), so verify via `better-sqlite3` directly:

```bash
docker compose -f docker-compose.dev.yml exec server node -e "
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const dir = 'data/churches';
const file = fs.readdirSync(dir)[0];
const db = new Database(path.join(dir, file), { readonly: true });
const cols = db.prepare('PRAGMA table_info(church_settings)').all();
console.log(cols.some(c => c.name === 'planning_center_last_notified_review') ? 'COLUMN PRESENT' : 'COLUMN MISSING');
"
```

Expected: prints `COLUMN PRESENT` (confirms the `ALTER TABLE` actually ran, not just
that the server started without error).

- [ ] **Step 5: Commit**

```bash
git add server/config/schema.js server/config/database.js
git commit -m "$(cat <<'EOF'
feat(pco): add planning_center_last_notified_review column

Stores the last review-needed totals a church was notified about, so
scheduled runs can avoid re-notifying every night for an unchanged,
still-unresolved situation.
EOF
)"
```

---

### Task 3: Return summaries from the cron sync functions

**Files:**
- Modify: `server/services/planningCenterSync.js:383-431` (`runBatchSync`, `runReconciliationSync`)

- [ ] **Step 1: Modify `runBatchSync` to add a pending-family-name-updates count and return its summary**

In `server/services/planningCenterSync.js`, replace:

```js
async function runBatchSync(churchId, accessToken, batch, userId) {
  try {
    const plan = await computePlanForBatch(churchId, accessToken, batch, { force: false });
    // Family name updates are a reviewable, not automatic, step (per design) — scheduled/
    // unattended runs never have a human to review them, so skip all proposed renames here.
    // computePlan recomputes this bucket fresh every run, so a skipped proposal simply
    // reappears next time someone opens the interactive Sync Review screen.
    const skipFamilyNameUpdateIds = (plan.familyNameUpdates || []).map((f) => f.familyId);
    const result = await applyForChurch(churchId, plan, userId, { skipFamilyNameUpdateIds }, {
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
    });
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      familyNamesUpdated: result.familyNamesUpdated,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      errors: result.errors.length,
    };
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(summary), batch.id]
    );
    logger.info(`PCO batch sync: church ${churchId} batch ${batch.id} (${batch.name}) done — ${JSON.stringify(summary)}`);
  } catch (err) {
    logger.error(`PCO batch sync: error for church ${churchId} batch ${batch.id}: ${err.message}`);
  }
}
```

with:

```js
async function runBatchSync(churchId, accessToken, batch, userId) {
  try {
    const plan = await computePlanForBatch(churchId, accessToken, batch, { force: false });
    // Family name updates are a reviewable, not automatic, step (per design) — scheduled/
    // unattended runs never have a human to review them, so skip all proposed renames here.
    // computePlan recomputes this bucket fresh every run, so a skipped proposal simply
    // reappears next time someone opens the interactive Sync Review screen.
    const skipFamilyNameUpdateIds = (plan.familyNameUpdates || []).map((f) => f.familyId);
    const result = await applyForChurch(churchId, plan, userId, { skipFamilyNameUpdateIds }, {
      defaultPeopleType: batch.defaultPeopleType,
      gatheringTypeId: batch.gatheringTypeId,
    });
    const summary = {
      at: new Date().toISOString(),
      added: result.added, updated: result.updated, archived: result.archived,
      reactivated: result.reactivated, linked: result.linked,
      gatheringAssigned: result.gatheringAssigned,
      familyNamesUpdated: result.familyNamesUpdated,
      ambiguous: plan.ambiguous.length,
      visitorMatches: (plan.visitorMatches || []).length,
      // How many family-name proposals this run *skipped* (as opposed to
      // familyNamesUpdated above, which is how many were actually applied —
      // always 0 here, since they're always skipped on an unattended run).
      familyNameUpdatesPending: skipFamilyNameUpdateIds.length,
      errors: result.errors.length,
    };
    await Database.query(
      `UPDATE planning_center_sync_batches SET last_sync_at = datetime('now'), last_sync_result = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(summary), batch.id]
    );
    logger.info(`PCO batch sync: church ${churchId} batch ${batch.id} (${batch.name}) done — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    logger.error(`PCO batch sync: error for church ${churchId} batch ${batch.id}: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 2: Modify `runReconciliationSync` to return its summary**

Replace:

```js
async function runReconciliationSync(churchId, accessToken, userId) {
  try {
    const plan = await computeReconciliationForChurch(churchId, accessToken, { force: false });
    const result = await applyReconciliation(churchId, plan, {});
    const summary = { at: new Date().toISOString(), archived: result.archived, errors: result.errors.length };
    await Database.query(
      `UPDATE church_settings
          SET planning_center_reconciliation_last_run_at = datetime('now'),
              planning_center_reconciliation_last_result = ?
        WHERE church_id = ?`,
      [JSON.stringify(summary), churchId]
    );
    logger.info(`PCO reconciliation: church ${churchId} done — ${JSON.stringify(summary)}`);
  } catch (err) {
    logger.error(`PCO reconciliation: error for church ${churchId}: ${err.message}`);
  }
}
```

with:

```js
async function runReconciliationSync(churchId, accessToken, userId) {
  try {
    const plan = await computeReconciliationForChurch(churchId, accessToken, { force: false });
    const result = await applyReconciliation(churchId, plan, {});
    const summary = { at: new Date().toISOString(), archived: result.archived, errors: result.errors.length };
    await Database.query(
      `UPDATE church_settings
          SET planning_center_reconciliation_last_run_at = datetime('now'),
              planning_center_reconciliation_last_result = ?
        WHERE church_id = ?`,
      [JSON.stringify(summary), churchId]
    );
    logger.info(`PCO reconciliation: church ${churchId} done — ${JSON.stringify(summary)}`);
    return summary;
  } catch (err) {
    logger.error(`PCO reconciliation: error for church ${churchId}: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 3: Run the full existing PCO test suite to confirm nothing broke**

Neither function has direct unit tests (they're DB/network-coupled, consistent with the rest of this file — see the cross-review addendum in `docs/PCO_INTEGRATION_ANALYSIS.md` for why), so this step is a regression check on everything else, not a test of this change:

```bash
docker compose -f docker-compose.dev.yml exec server sh -c "node --test services/planningCenterSync.test.js services/planningCenter/*.test.js"
```

Expected: PASS, `# fail 0` (should now read `# tests 140`, up from 128 — the 12 new tests from Task 1).

- [ ] **Step 4: Commit**

```bash
git add server/services/planningCenterSync.js
git commit -m "$(cat <<'EOF'
refactor(pco): return sync summaries from runBatchSync/runReconciliationSync

Both previously computed a summary, persisted it, and discarded it. The
caller (syncChurch) needs these to aggregate review-needed counts across
everything a scheduled run touched.
EOF
)"
```

---

### Task 4: Wire up the notification call in `syncChurch`

**Files:**
- Modify: `server/services/planningCenterSync.js:1-7` (top requires)
- Modify: `server/services/planningCenterSync.js` (new function, after `runReconciliationSync`)
- Modify: `server/services/planningCenterSync.js` (`syncChurch` body)

Depends on Task 2 (the `planning_center_last_notified_review` column must already exist) and Task 3 (`runBatchSync`/`runReconciliationSync` must already return summaries).

- [ ] **Step 1: Import the new pure module**

Replace:

```js
const https = require('https');
const cron = require('node-cron');
const Database = require('../config/database');
const logger = require('../config/logger');
const { projectPerson } = require('./planningCenter/projection');
const { computePlan } = require('./planningCenter/diffEngine');
const { applyPlan, applyArchiveExtras } = require('./planningCenter/apply');
```

with:

```js
const https = require('https');
const cron = require('node-cron');
const Database = require('../config/database');
const logger = require('../config/logger');
const { projectPerson } = require('./planningCenter/projection');
const { computePlan } = require('./planningCenter/diffEngine');
const { applyPlan, applyArchiveExtras } = require('./planningCenter/apply');
const { reviewNotificationDecision, buildPcoReviewMessage } = require('./planningCenter/reviewNotification');
```

- [ ] **Step 2: Add `maybeNotifyPcoReviewNeeded`**

Immediately after the `runReconciliationSync` function (i.e. right before `async function syncChurch(church, ...`), add:

```js
// ─── Review-needed notifications ─────────────────────────────────────────────

async function maybeNotifyPcoReviewNeeded(churchId, totals) {
  const rows = await Database.query(
    `SELECT planning_center_last_notified_review AS last FROM church_settings WHERE church_id = ? LIMIT 1`,
    [churchId]
  );
  const prev = rows.length && rows[0].last ? JSON.parse(rows[0].last) : null;
  const decision = reviewNotificationDecision(prev, totals);

  if (decision.clear) {
    await Database.query(
      `UPDATE church_settings SET planning_center_last_notified_review = NULL WHERE church_id = ?`,
      [churchId]
    );
  }
  if (!decision.notify) return;

  const message = buildPcoReviewMessage(totals);
  const admins = await Database.query(
    `SELECT id FROM users WHERE role IN ('admin', 'coordinator') AND is_active = 1 AND church_id = ?`,
    [churchId]
  );
  for (const admin of admins) {
    await Database.query(
      `INSERT INTO notifications (user_id, title, message, notification_type, church_id)
       VALUES (?, ?, ?, 'system', ?)`,
      [admin.id, 'Planning Center sync needs your review', message, churchId]
    );
  }
  await Database.query(
    `UPDATE church_settings SET planning_center_last_notified_review = ? WHERE church_id = ?`,
    [JSON.stringify(totals), churchId]
  );
  logger.info(`PCO review notification: church ${churchId} notified ${admins.length} admin(s) — ${JSON.stringify(totals)}`);
}
```

- [ ] **Step 3: Aggregate counts in `syncChurch` and call it**

Replace:

```js
      for (const batch of dueBatches) {
        await runBatchSync(churchId, accessToken, batch, userId);
      }

      if (reconciliationDue) await runReconciliationSync(churchId, accessToken, userId);
    } catch (err) {
      logger.error(`PCO sync: error for church ${churchId}: ${err.message}`);
    }
  });
}
```

with:

```js
      const totals = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 0 };
      for (const batch of dueBatches) {
        const summary = await runBatchSync(churchId, accessToken, batch, userId);
        if (summary) {
          totals.ambiguous += summary.ambiguous;
          totals.visitorMatches += summary.visitorMatches;
          totals.familyNameUpdatesPending += summary.familyNameUpdatesPending;
        }
      }

      if (reconciliationDue) {
        const reconciliationSummary = await runReconciliationSync(churchId, accessToken, userId);
        if (reconciliationSummary) totals.reconciliationArchived += reconciliationSummary.archived;
      }

      await maybeNotifyPcoReviewNeeded(churchId, totals);
    } catch (err) {
      logger.error(`PCO sync: error for church ${churchId}: ${err.message}`);
    }
  });
}
```

- [ ] **Step 4: Run the full PCO test suite**

```bash
docker compose -f docker-compose.dev.yml exec server sh -c "node --test services/planningCenterSync.test.js services/planningCenter/*.test.js"
```

Expected: PASS, `# fail 0`. (This wiring itself has no direct unit test — `syncChurch` is DB/network-coupled cron orchestration; Task 1's tests cover the decision logic it calls into. Manual verification is in Task 8.)

- [ ] **Step 5: Verify the server still boots clean**

```bash
docker compose -f docker-compose.dev.yml restart server
sleep 3
docker compose -f docker-compose.dev.yml logs --tail=30 server
```

Expected: no stack traces; log ends with `✅ Server startup completed successfully` and `Planning Center sync scheduler initialized`, same as before this change.

- [ ] **Step 6: Commit**

```bash
git add server/services/planningCenterSync.js
git commit -m "$(cat <<'EOF'
feat(pco): notify admins when a scheduled sync leaves review-needed items

After each night's batches + reconciliation run, aggregate ambiguous
matches, visitor-match suggestions, pending family name updates, and
reconciliation archives; notify every admin/coordinator via the existing
in-app notification system when that picture is new or has changed since
the last notification.
EOF
)"
```

---

### Task 5: Remove "Run now" from Settings

**Files:**
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx:44` (state)
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx:102-112` (handler)
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx:404-414` (button)

- [ ] **Step 1: Remove the `runningBatchId` state**

Replace:

```tsx
  const [reviewingBatchId, setReviewingBatchId] = useState<number | null>(null);
  const [runningBatchId, setRunningBatchId] = useState<number | null>(null);
  const [reconciliationScheduleEnabled, setReconciliationScheduleEnabled] = useState(false);
```

with:

```tsx
  const [reviewingBatchId, setReviewingBatchId] = useState<number | null>(null);
  const [reconciliationScheduleEnabled, setReconciliationScheduleEnabled] = useState(false);
```

- [ ] **Step 2: Remove the `runBatchNow` handler**

Replace:

```tsx
  const runBatchNow = async (batchId: number) => {
    setRunningBatchId(batchId);
    try {
      await integrationsAPI.applyPlanningCenterBatch(batchId, {});
      await loadBatches();
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Sync failed.');
    } finally {
      setRunningBatchId(null);
    }
  };

  const deleteBatch = async (batchId: number) => {
```

with:

```tsx
  const deleteBatch = async (batchId: number) => {
```

- [ ] **Step 3: Remove the "Run now" button from the batch list**

Replace:

```tsx
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setEditingBatch(batch)} className="text-sm underline text-gray-600 dark:text-gray-300">Edit</button>
                          <button type="button" onClick={() => runBatchNow(batch.id)} disabled={runningBatchId === batch.id}
                            className="text-sm underline text-gray-600 dark:text-gray-300 disabled:opacity-50">
                            {runningBatchId === batch.id ? 'Syncing…' : 'Run now'}
                          </button>
                          <button type="button" onClick={() => setReviewingBatchId(reviewingBatchId === batch.id ? null : batch.id)}
                            className="text-sm underline text-gray-600 dark:text-gray-300">
                            {reviewingBatchId === batch.id ? 'Hide review' : 'Review & sync'}
                          </button>
                          <button type="button" onClick={() => deleteBatch(batch.id)} className="text-sm underline text-red-600 dark:text-red-400">Delete</button>
                        </div>
```

with:

```tsx
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setEditingBatch(batch)} className="text-sm underline text-gray-600 dark:text-gray-300">Edit</button>
                          <button type="button" onClick={() => setReviewingBatchId(reviewingBatchId === batch.id ? null : batch.id)}
                            className="text-sm underline text-gray-600 dark:text-gray-300">
                            {reviewingBatchId === batch.id ? 'Hide review' : 'Review & sync'}
                          </button>
                          <button type="button" onClick={() => deleteBatch(batch.id)} className="text-sm underline text-red-600 dark:text-red-400">Delete</button>
                        </div>
```

- [ ] **Step 4: Verify the client compiles and the button is gone**

```bash
docker compose -f docker-compose.dev.yml up -d client
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/src/components/integrations/PlanningCenterIntegrationPanel.tsx"
curl -s "http://localhost:3000/src/components/integrations/PlanningCenterIntegrationPanel.tsx" | grep -c "Run now"
```

Expected: first command prints `200` (no compile error); second prints `0` (the string "Run now" no longer appears anywhere in the transformed file).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/integrations/PlanningCenterIntegrationPanel.tsx
git commit -m "$(cat <<'EOF'
feat(pco)!: remove blind "Run now" batch apply

Batches now only run manually through "Review & sync" — a human is
present for manual runs, so there's no reason to skip review the way the
unattended nightly cron sync has to.
EOF
)"
```

---

### Task 6: Onboarding — review step instead of blind auto-apply

**Files:**
- Modify: `client/src/pages/OnboardingPage.tsx:1-9` (imports)
- Modify: `client/src/pages/OnboardingPage.tsx:27` (step union)
- Modify: `client/src/pages/OnboardingPage.tsx:37` (state)
- Modify: `client/src/pages/OnboardingPage.tsx:201-214` (`onFirstBatchSaved`)
- Modify: `client/src/pages/OnboardingPage.tsx:376-390` (render branches)

- [ ] **Step 1: Import `PlanningCenterSyncReview`**

Replace:

```tsx
import PlanningCenterBatchEditor from '../components/planningCenter/PlanningCenterBatchEditor';
import PCOCheckinImport from '../components/PCOCheckinImport';
import { SyncBatch } from '../services/api';
```

with:

```tsx
import PlanningCenterBatchEditor from '../components/planningCenter/PlanningCenterBatchEditor';
import PlanningCenterSyncReview from '../components/planningCenter/PlanningCenterSyncReview';
import PCOCheckinImport from '../components/PCOCheckinImport';
import { SyncBatch } from '../services/api';
```

- [ ] **Step 2: Add `'pco-review'` to the step union**

Replace:

```tsx
  const [step, setStep] = useState<'form' | 'code' | 'choose-path' | 'pco-people' | 'pco-gatherings'>('form');
```

with:

```tsx
  const [step, setStep] = useState<'form' | 'code' | 'choose-path' | 'pco-people' | 'pco-review' | 'pco-gatherings'>('form');
```

- [ ] **Step 3: Replace `importingPeople` with `firstBatchId`**

Replace:

```tsx
  const [importingPeople, setImportingPeople] = useState(false);
```

with:

```tsx
  const [firstBatchId, setFirstBatchId] = useState<number | null>(null);
```

- [ ] **Step 4: Rewrite `onFirstBatchSaved` to stop auto-applying**

Replace:

```tsx
  // The batch is created/saved by PlanningCenterBatchEditor itself; this just
  // runs an immediate, auto-applied import (no manual review — same one-time,
  // no-review behaviour onboarding had before) and advances the wizard.
  const onFirstBatchSaved = async (batch: SyncBatch) => {
    setImportingPeople(true); setError('');
    try {
      await integrationsAPI.applyPlanningCenterBatch(batch.id, {});
      setStep('pco-gatherings');
    } catch (e: any) {
      setError(e.response?.data?.error || 'Failed to import people from Planning Center.');
    } finally {
      setImportingPeople(false);
    }
  };
```

with:

```tsx
  // The batch is created/saved by PlanningCenterBatchEditor itself. Advance to
  // the review step instead of auto-applying blindly — the admin reviews
  // ambiguous matches, visitor promotions, and family name updates in the same
  // screen Settings uses, then explicitly applies (or continues without
  // applying; the batch is saved regardless and can be run later from
  // Settings).
  const onFirstBatchSaved = (batch: SyncBatch) => {
    setFirstBatchId(batch.id);
    setStep('pco-review');
  };
```

- [ ] **Step 5: Update the `pco-people` branch and add the new `pco-review` branch**

Replace:

```tsx
          ) : step === 'pco-people' ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">Choose which Planning Center people to import, and optionally assign them to a gathering.</p>
              {importingPeople ? (
                <p className="text-sm text-gray-700">Importing…</p>
              ) : (
                <PlanningCenterBatchEditor
                  batch={null}
                  onSaved={onFirstBatchSaved}
                  onCancel={() => setStep('pco-gatherings')}
                />
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          ) : step === 'pco-gatherings' ? (
```

with:

```tsx
          ) : step === 'pco-people' ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">Choose which Planning Center people to import, and optionally assign them to a gathering.</p>
              <PlanningCenterBatchEditor
                batch={null}
                onSaved={onFirstBatchSaved}
                onCancel={() => setStep('pco-gatherings')}
              />
              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          ) : step === 'pco-review' ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                Review what Planning Center found before continuing. You can also skip straight ahead — this batch is saved and can be run again later from Settings.
              </p>
              {firstBatchId !== null && (
                <PlanningCenterSyncReview connected={true} batchId={firstBatchId} />
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setStep('pco-gatherings')}
                  className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700"
                >
                  Continue
                </button>
              </div>
            </div>
          ) : step === 'pco-gatherings' ? (
```

- [ ] **Step 6: Verify the client compiles**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/src/pages/OnboardingPage.tsx"
curl -s "http://localhost:3000/src/pages/OnboardingPage.tsx" | grep -o "pco-review" | head -1
```

Expected: `200`, then `pco-review` (confirms the new step name made it into the transformed bundle).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/OnboardingPage.tsx
git commit -m "$(cat <<'EOF'
feat(pco)!: replace onboarding's blind first-batch apply with a review step

Onboarding now shows the same Review & Sync screen Settings uses before
continuing the wizard, instead of silently applying with empty selections.
Continuing doesn't require applying first — the batch is saved regardless
and can be run later from Settings.
EOF
)"
```

---

### Task 7: Update the analysis doc's status

**Files:**
- Modify: `docs/PCO_INTEGRATION_ANALYSIS.md`

- [ ] **Step 1: Mark item 4 (onboarding skips review) as fixed**

Replace:

```markdown
4. **Onboarding skips sync review**
   - Design: batch editor + review flow
   - Implementation: `applyPlanningCenterBatch(batch.id, {})` immediately after first
     batch save (`OnboardingPage.tsx`)
   - Ambiguous matches, visitor promotions, and selective adds are silently skipped on
     first import
```

with:

```markdown
4. **`[fixed 2026-07-09]` Onboarding skips sync review**
   - Was: `applyPlanningCenterBatch(batch.id, {})` immediately after first batch save
     (`OnboardingPage.tsx`), silently skipping ambiguous matches, visitor promotions,
     and selective adds
   - Now: onboarding has a `pco-review` step showing the same `PlanningCenterSyncReview`
     screen Settings uses, with a "Continue" button that doesn't require applying first —
     see `docs/superpowers/specs/2026-07-09-pco-batch-review-notifications-design.md`
```

- [ ] **Step 2: Mark item 5 ("Run now" bypasses review) as fixed**

Replace:

```markdown
5. **"Run now" bypasses review**
   - Same as onboarding — applies with empty selections; ambiguous items stay unlinked
     until someone opens "Review & sync"
   - Not wrong per cron design, but easy to miss that `ambiguous > 0` means incomplete
     linking
```

with:

```markdown
5. **`[fixed 2026-07-09]` "Run now" bypasses review**
   - Was: applied with empty selections; ambiguous items stayed unlinked until someone
     opened "Review & sync" anyway
   - Now: the "Run now" button is removed — batches only run manually through
     "Review & sync"
```

- [ ] **Step 3: Mark item 6 (scheduled reconciliation auto-archives silently) as mitigated**

Replace:

```markdown
6. **Scheduled reconciliation auto-archives without human review**
   - Confirmed in code: `runReconciliationSync()` (`planningCenterSync.js:352`) calls
     `applyReconciliation(churchId, plan, {})` with empty options — no selections, no
     review
   - By design, but consequential — active regulars with no PCO name match get archived
     silently at 2 AM
   - Manual reconciliation has search-and-link; scheduled path does not
```

with:

```markdown
6. **`[mitigated 2026-07-09]` Scheduled reconciliation auto-archives without human review**
   - Still auto-archives on schedule — explicitly kept as-is (archiving is reversible via
     reactivate, and holding it for approval would make an unattended nightly job do
     nothing most nights)
   - No longer silent: admins/coordinators get an in-app notification summarizing what a
     scheduled run left for review (ambiguous matches, visitor-match suggestions, pending
     family name updates) and how many people reconciliation archived — see
     `docs/superpowers/specs/2026-07-09-pco-batch-review-notifications-design.md`
```

- [ ] **Step 4: Mark item 11 (OAuth disconnect is per-user) as fixed**

Confirmed current numbering in the file (re-check with `grep -n "^[0-9]\+\. \*\*" docs/PCO_INTEGRATION_ANALYSIS.md` if this task is executed after the file may have changed): this is item **11**, immediately after item 10 ("Monthly schedule has no day-of-month picker") and before item 12 ("Two independent, unmerged PCO caching layers"). Replace:

```markdown
11. **OAuth disconnect is per-user** — tokens stored in `user_preferences`; disconnect
    removes only the connecting user's tokens; cron uses `LIMIT 1` any user with tokens
```

with:

```markdown
11. **`[fixed 2026-07-09]` OAuth disconnect is per-user** — was: tokens stored in
    `user_preferences`; disconnect removed only the connecting user's tokens; status,
    check-in browse/events/availability, and check-in import were all scoped to the
    viewing admin instead of the church, so only the original connecting admin could see
    "Connected" or run check-in import. Now: `/status`, `/checkins/*`, `/disconnect`, and
    check-in import all resolve tokens church-wide via `getChurchPlanningCenterTokens` /
    a church-scoped `DELETE`, matching how the batch/cron sync paths already worked.
```

- [ ] **Step 5: Update the Summary table**

Replace:

```markdown
| Missing piece | Severity |
|---------------|----------|
| Source-of-truth mode not tied to "being on PCO" (mislabeled toggle, not enabled in onboarding) | **Critical** — defeats the core value prop |
| Token refresh implemented independently in 3 places against the same DB row `[cross-review]` | **High** — can silently break the PCO connection (PCO rotates the refresh token on every use) |
| Users told check-ins "sync" when it's historical import only | **High** — wrong expectations |
| Onboarding / Run now skip review for ambiguous matches | **High** — incomplete initial linking |
| Scheduled reconciliation auto-archives without review | **Medium** — can surprise admins |
| Two different flags named `planningCenterSyncEnabled` in different APIs | **Medium** — maintenance hazard |
| Two unrelated, unmerged PCO caching layers `[cross-review]` | **Low** — works, but an avoidable extra layer of state |
| No ongoing attendance bridge from PCO | **By design** — but churches may expect it |
```

with:

```markdown
| Missing piece | Severity |
|---------------|----------|
| Source-of-truth mode not tied to "being on PCO" (mislabeled toggle, not enabled in onboarding) | **Fixed 2026-07-09** — toggle relabeled + confirmation dialog added |
| Token refresh implemented independently in 3 places against the same DB row `[cross-review]` | **Fixed 2026-07-09** — consolidated to one implementation |
| Users told check-ins "sync" when it's historical import only | **High** — wrong expectations (not yet fixed) |
| Onboarding / Run now skip review for ambiguous matches | **Fixed 2026-07-09** — Run now removed, onboarding shows a review step |
| Scheduled reconciliation auto-archives without review | **Mitigated 2026-07-09** — still auto-archives by design, now notifies admins |
| Two different flags named `planningCenterSyncEnabled` in different APIs | **Medium** — maintenance hazard (not yet fixed) |
| Two unrelated, unmerged PCO caching layers `[cross-review]` | **Low** — works, but an avoidable extra layer of state (not yet fixed) |
| No ongoing attendance bridge from PCO | **By design** — but churches may expect it |
```

- [ ] **Step 6: Commit**

```bash
git add docs/PCO_INTEGRATION_ANALYSIS.md
git commit -m "$(cat <<'EOF'
docs(pco): mark review-bypass and per-admin-token findings as fixed/mitigated

Updates the analysis doc's punch list to reflect the toggle relabel, token
refresh consolidation, church-wide token scoping, blind-apply removal, and
review-needed notifications shipped this session.
EOF
)"
```

---

### Task 8: Full verification pass

**Files:** none (verification only, no commit)

- [ ] **Step 1: Run the complete PCO test suite**

```bash
docker compose -f docker-compose.dev.yml exec server sh -c "node --test services/planningCenterSync.test.js services/planningCenter/*.test.js"
```

Expected: `# fail 0`, `# tests 140` (128 pre-existing + 12 new from Task 1).

- [ ] **Step 2: Restart both containers and confirm clean boot**

```bash
docker compose -f docker-compose.dev.yml restart server client
sleep 4
docker compose -f docker-compose.dev.yml logs --tail=30 server | grep -iE "error|exception"
docker compose -f docker-compose.dev.yml logs --tail=30 client | grep -iE "error|exception"
```

Expected: both commands print nothing (no error/exception lines).

- [ ] **Step 3: Manually exercise a scheduled run against a real church, if PCO test credentials are available**

```bash
docker compose -f docker-compose.dev.yml exec server node -e "
const Database = require('./config/database');
const pcoSync = require('./services/planningCenterSync');
(async () => {
  const churches = Database.listChurches();
  for (const c of churches) await pcoSync.syncChurch(c, { skipScheduleCheck: true });
  console.log('done');
})();
"
```

Then check the `notifications` table for the relevant church and confirm a row appeared for each admin/coordinator, and that running it again immediately does *not* create a duplicate. This requires a church in this dev environment with Planning Center actually connected and at least one ambiguous match or archive candidate — if none exists, rely on Task 1's unit tests plus a manual click-through instead (create a batch, don't resolve an ambiguous match, run this command, confirm the bell icon shows a new notification).

- [ ] **Step 4: Manual click-through in the browser**

- Settings → Integrations → Planning Center: confirm no "Run now" button remains on any batch, only Edit / Review & sync / Delete.
- Onboarding (new church signup, or re-run `pco=connected` flow): confirm after saving the first batch, the wizard shows the review screen with a "Continue" button, and clicking Continue (with or without applying first) advances to the check-in import step.
- Notification bell: after Step 3's manual scheduled-run trigger, confirm the notification appears with sensible text, and that clicking it marks it read.
