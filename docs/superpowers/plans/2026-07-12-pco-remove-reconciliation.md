# Remove PCO "Check for people who left" (reconciliation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the PCO "Check for people who left" (reconciliation) feature end-to-end — routes, service functions, scheduler wiring, settings fields, and UI — because it does not do what its name promises and its unattended auto-archive path is a real risk.

**Architecture:** This is a subtractive change: delete the reconciliation-specific code paths while leaving `diffEngine.js`'s `archiveExtras`/`unmatchedVisitors` buckets in place (they're a harmless byproduct of every batch's own `computePlan`, and batch review already omits them from its response — see `server/routes/integrations.js:2372`). Leave the five `planning_center_reconciliation_*` `church_settings` columns in `schema.js` untouched per this repo's additive-only migration convention (existing precedent: several already-unused legacy PCO columns are kept for the same reason).

**Tech Stack:** Node/Express + `better-sqlite3` backend, React/TypeScript frontend, Node's built-in `node:test` runner for server tests, Vitest for client tests.

---

## Why this is being removed (context for the engineer)

`archiveExtras` (surfaced in the UI as "Check for people who left") only fires for an **unlinked** LMPG individual whose name matches **zero** PCO people at all, active or inactive (`matchIndividuals` in `server/services/planningCenter/matcher.js` doesn't consult PCO status). Since PCO essentially never deletes a person — going inactive is the norm — this bucket rarely reflects "this person left"; it's closer to "duplicate/orphaned local record with no PCO counterpart by name," which is a much weaker and more false-positive-prone signal (nicknames, married names, typos).

The actual "this person left" signal — a **linked** individual whose PCO status flips to `inactive` — is already handled automatically by every batch's own `archive` bucket (`server/services/planningCenter/diffEngine.js:127`), applied without any separate review step as part of ordinary batch syncing. Reconciliation adds nothing for that case.

Worse, `runReconciliationSync` (`server/services/planningCenterSync.js:438`) auto-applies its archive list with **zero review** when run on schedule — an unattended, false-positive-prone path archiving real members. `docs/PCO_INTEGRATION_ANALYSIS.md` already flags blind-apply paths as higher-risk than "Review & sync."

---

## Task 1: Remove reconciliation routes from `integrations.js`

**Files:**
- Modify: `server/routes/integrations.js:2484-2549`

- [ ] **Step 1: Delete the two reconciliation routes**

Delete this exact block from `server/routes/integrations.js` (lines 2484-2550: the `// Dry-run: whole-roster reconciliation` comment through the POST handler's closing `});`), leaving the blank line and the following `// Membership distribution...` route untouched:

```javascript
// Dry-run: whole-roster reconciliation (people no longer found in PCO at all).
router.get('/planning-center/reconciliation/plan', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });
    const force = req.query.refresh === '1' || req.query.force === '1';
    const plan = await pcoSync.computeReconciliationForChurch(churchId, accessToken, { force });
    res.json({
      success: true,
      summary: { archiveExtras: plan.archiveExtras.length, unmatchedVisitors: plan.unmatchedVisitors.length },
      plan,
    });
  } catch (error) {
    logger.error('PCO reconciliation plan error:', error);
    res.status(500).json({ error: 'Failed to compute reconciliation plan.' });
  }
});

// Apply: archive the selected archiveExtras. unmatchedVisitors is informational only.
router.post('/planning-center/reconciliation/apply', async (req, res) => {
  try {
    const churchId = req.user.church_id;
    const accessToken = await pcoSync.getAccessTokenForChurch(churchId);
    if (!accessToken) return res.status(400).json({ error: 'Planning Center not connected.' });

    const plan = await pcoSync.computeReconciliationForChurch(churchId, accessToken);
    const rawSel = (req.body && req.body.selections) || {};
    const extraIds = new Set(plan.archiveExtras.map((x) => Number(x.individualId)));

    const { people: cachedPcoPeople } = await pcoSync.getCachedPcoPeople(churchId, accessToken);
    const validPcoIds = new Set(cachedPcoPeople.map((p) => p.id));
    const linkedRows = await Database.query(
      `SELECT planning_center_id FROM individuals WHERE church_id = ? AND planning_center_id IS NOT NULL`,
      [churchId]
    );
    const claimedPcoIds = new Set(linkedRows.map((r) => r.planning_center_id));

    const manualLinkCandidates = Object.entries(rawSel.manualLinks || {}).map(([individualId, pcoId]) => ({
      individualId: Number(individualId), pcoId,
    }));
    const acceptedManualLinks = resolveManualLinks(manualLinkCandidates, {
      validPcoIds, claimedPcoIds, allowedIndividualIds: extraIds,
    });
    const manualLinks = {};
    for (const m of acceptedManualLinks) manualLinks[m.individualId] = m.pcoId;

    const linkedIndividualIds = new Set(Object.keys(manualLinks).map(Number));
    const skipArchiveExtraIds = (Array.isArray(rawSel.skipArchiveExtraIds) ? rawSel.skipArchiveExtraIds : [])
      .map(Number)
      .filter((id) => extraIds.has(id) && !linkedIndividualIds.has(id));

    const result = await pcoSync.applyReconciliation(churchId, plan, { skipArchiveExtraIds, manualLinks });
    const summary = { at: new Date().toISOString(), archived: result.archived, linked: result.linked, errors: result.errors.length };
    await Database.query(
      `UPDATE church_settings
          SET planning_center_reconciliation_last_run_at = datetime('now'),
              planning_center_reconciliation_last_result = ?
        WHERE church_id = ?`,
      [JSON.stringify(summary), churchId]
    );
    res.json({ success: true, result, summary });
  } catch (error) {
    logger.error('PCO reconciliation apply error:', error);
    res.status(500).json({ error: 'Failed to apply reconciliation.' });
  }
});
```

Note: `resolveManualLinks` (imported at the top of the file from `../services/planningCenter/selectionValidation`) is also used elsewhere in this file (the batch ambiguous-resolution route, around line 2429) — do **not** remove that import, only this route's usage of it goes away.

- [ ] **Step 2: Confirm no other route references `computeReconciliationForChurch` / `applyReconciliation`**

Run: `grep -n "Reconciliation\|reconciliation" server/routes/integrations.js`
Expected: only the leftover comment at line ~2372 (`// Batch plans omit the whole-roster buckets — those live under /reconciliation.`) — update that comment in Task 2's file since it now refers to a route that no longer exists.

---

## Task 2: Update the stale comment left behind in `integrations.js`

**Files:**
- Modify: `server/routes/integrations.js` (the batch-plan route, ~line 2372)

- [ ] **Step 1: Fix the comment that pointed at the now-deleted reconciliation route**

```javascript
// old_string
    // Batch plans omit the whole-roster buckets — those live under /reconciliation.
```

```javascript
// new_string
    // Batch plans omit the whole-roster buckets (archiveExtras/unmatchedVisitors) —
    // no endpoint surfaces those on their own anymore; computePlan still returns
    // them because diffEngine.js is shared with every batch's own plan.
```

- [ ] **Step 2: Verify with grep**

Run: `grep -n "reconciliation" server/routes/integrations.js`
Expected: no output.

---

## Task 3: Remove reconciliation functions and scheduler wiring from `planningCenterSync.js`

**Files:**
- Modify: `server/services/planningCenterSync.js`

- [ ] **Step 1: Remove `NEUTRAL_FILTER_CONFIG`, `computeReconciliationForChurch`, and `applyReconciliation`**

```javascript
// old_string
// archiveExtras/unmatchedVisitors never consult filterConfig (they're name-matched
// against PCO's full unfiltered people export — see diffEngine.js), so any
// filterConfig works here; a neutral empty one keeps intent clear.
const NEUTRAL_FILTER_CONFIG = { membershipFilterEnabled: false, membershipAllowlist: [], fieldFilterEnabled: false, fieldFilters: [] };

async function computeReconciliationForChurch(churchId, accessToken, opts) {
  const plan = await computePlanForChurch(churchId, accessToken, NEUTRAL_FILTER_CONFIG, opts);
  return { archiveExtras: plan.archiveExtras, unmatchedVisitors: plan.unmatchedVisitors, pcoFetchedAt: plan.pcoFetchedAt };
}

async function applyReconciliation(churchId, plan, selections = {}) {
  return applyArchiveExtras(churchId, plan.archiveExtras, {
    skipArchiveExtraIds: selections.skipArchiveExtraIds || [],
    manualLinks: selections.manualLinks || {},
  });
}

// Apply a plan for a church (current church context must be set by caller).
```

```javascript
// new_string
// Apply a plan for a church (current church context must be set by caller).
```

- [ ] **Step 2: Remove the `applyArchiveExtras` import (now unused in this file)**

```javascript
// old_string
const { applyPlan, applyArchiveExtras } = require('./planningCenter/apply');
```

```javascript
// new_string
const { applyPlan } = require('./planningCenter/apply');
```

- [ ] **Step 3: Remove `runReconciliationSync`**

```javascript
// old_string
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

// ─── Review-needed notifications ─────────────────────────────────────────────
```

```javascript
// new_string
// ─── Review-needed notifications ─────────────────────────────────────────────
```

- [ ] **Step 4: Strip reconciliation scheduling out of `syncChurch()`**

```javascript
// old_string
      const settings = await Database.query(
        `SELECT planning_center_sync_enabled AS enabled,
                planning_center_reconciliation_schedule_enabled AS reconciliationScheduleEnabled,
                planning_center_reconciliation_frequency AS reconciliationFrequency,
                planning_center_reconciliation_day AS reconciliationDay,
                (SELECT user_id FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens' LIMIT 1) AS token_user
           FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId, churchId]
      );
      if (!settings.length || !settings[0].enabled) return;
      const userId = settings[0].token_user || null;

      const batches = await listBatches(churchId);
      const dueBatches = batches.filter((batch) => {
        if (!batch.scheduleEnabled) return false;
        return skipScheduleCheck || isDueToday(batch.scheduleFrequency, batch.scheduleDay);
      });
      const reconciliationDue = !!(settings[0].reconciliationScheduleEnabled &&
        (skipScheduleCheck || isDueToday(settings[0].reconciliationFrequency, settings[0].reconciliationDay)));

      if (!dueBatches.length && !reconciliationDue) return;

      const accessToken = await getAccessTokenForChurch(churchId);
      if (!accessToken) { logger.warn(`PCO sync: no valid token for church ${churchId}`); return; }

      // Warm the PCO people cache once for this whole run — each due batch and
      // reconciliation below reuse it (force: false) rather than each re-fetching.
      await getCachedPcoPeople(churchId, accessToken, { force: true });

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
```

```javascript
// new_string
      const settings = await Database.query(
        `SELECT planning_center_sync_enabled AS enabled,
                (SELECT user_id FROM user_preferences WHERE church_id = ? AND preference_key = 'planning_center_tokens' LIMIT 1) AS token_user
           FROM church_settings WHERE church_id = ? LIMIT 1`,
        [churchId, churchId]
      );
      if (!settings.length || !settings[0].enabled) return;
      const userId = settings[0].token_user || null;

      const batches = await listBatches(churchId);
      const dueBatches = batches.filter((batch) => {
        if (!batch.scheduleEnabled) return false;
        return skipScheduleCheck || isDueToday(batch.scheduleFrequency, batch.scheduleDay);
      });

      if (!dueBatches.length) return;

      const accessToken = await getAccessTokenForChurch(churchId);
      if (!accessToken) { logger.warn(`PCO sync: no valid token for church ${churchId}`); return; }

      // Warm the PCO people cache once for this whole run — every due batch below
      // reuses it (force: false) rather than each re-fetching.
      await getCachedPcoPeople(churchId, accessToken, { force: true });

      const totals = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 };
      for (const batch of dueBatches) {
        const summary = await runBatchSync(churchId, accessToken, batch, userId);
        if (summary) {
          totals.ambiguous += summary.ambiguous;
          totals.visitorMatches += summary.visitorMatches;
          totals.familyNameUpdatesPending += summary.familyNameUpdatesPending;
        }
      }

      await maybeNotifyPcoReviewNeeded(churchId, totals);
```

- [ ] **Step 5: Remove the two reconciliation exports**

```javascript
// old_string
  listBatches, getBatch, batchFilterConfig, computePlanForBatch,
  computeReconciliationForChurch, applyReconciliation,
  getPlanningCenterTokens, savePlanningCenterTokens, ensureValidPlanningCenterTokens,
```

```javascript
// new_string
  listBatches, getBatch, batchFilterConfig, computePlanForBatch,
  getPlanningCenterTokens, savePlanningCenterTokens, ensureValidPlanningCenterTokens,
```

- [ ] **Step 6: Run the existing unit tests for this file to confirm nothing else broke**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenterSync.test.js`
Expected: all `isDueToday` tests still PASS (they don't touch reconciliation).

- [ ] **Step 7: Commit**

```bash
git add server/routes/integrations.js server/services/planningCenterSync.js
git commit -m "fix(pco): remove reconciliation routes and scheduler wiring"
```

---

## Task 4: Remove `applyArchiveExtras` from `apply.js`

**Files:**
- Modify: `server/services/planningCenter/apply.js`
- Modify: `server/services/planningCenter/apply.test.js`

- [ ] **Step 1: Delete `applyArchiveExtras` and its export**

```javascript
// old_string
// Archives active 'regular' individuals whose name matched no one in PCO's full
// people export (plan.archiveExtras from computePlan) — OR, if the reviewer found
// the right PCO person via manual search, links them instead of archiving (link
// always wins over archive/skip for that individual). Used only by the
// reconciliation endpoints — never called as part of a batch's own apply.
async function applyArchiveExtras(churchId, archiveExtras, { skipArchiveExtraIds = [], manualLinks = {} } = {}) {
  const skip = new Set(skipArchiveExtraIds.map(Number));
  const result = { archived: 0, linked: 0, errors: [] };
  for (const x of archiveExtras) {
    const id = Number(x.individualId);
    const linkPcoId = manualLinks[id];
    if (linkPcoId) {
      try {
        await Database.query(
          `UPDATE individuals SET planning_center_id = ?, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
          [linkPcoId, id, churchId]
        );
        result.linked++;
      } catch (e) { result.errors.push({ type: 'manualLink', id, error: e.message }); }
      continue;
    }
    if (skip.has(id)) continue;
    try {
      await Database.query(
        `UPDATE individuals SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND church_id = ?`,
        [id, churchId]
      );
      result.archived++;
    } catch (e) { result.errors.push({ type: 'archiveExtra', id, error: e.message }); }
  }
  return result;
}

module.exports = { applyPlan, groupAdds, applyArchiveExtras, computeGatheringRemovals };
```

```javascript
// new_string
module.exports = { applyPlan, groupAdds, computeGatheringRemovals };
```

- [ ] **Step 2: Remove the corresponding test**

```javascript
// old_string
const { groupAdds, applyArchiveExtras, computeGatheringRemovals } = require('./apply');
```

```javascript
// new_string
const { groupAdds, computeGatheringRemovals } = require('./apply');
```

Then find and delete this test block:

```javascript
test('applyArchiveExtras is exported as a function', () => {
  assert.strictEqual(typeof applyArchiveExtras, 'function');
});
```

(Read `server/services/planningCenter/apply.test.js` first — the snippet above is the anchor to search for; delete only that one `test(...)` block, leave everything else.)

- [ ] **Step 3: Run the tests**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/apply.test.js`
Expected: all remaining tests PASS.

Also check for a DB-integration test file that may cover `applyArchiveExtras` directly:

Run: `grep -n "applyArchiveExtras" server/services/planningCenter/apply.dbintegration.test.js`
Expected (per earlier investigation): no output. If this now prints a match, delete that test case too before moving on — it would mean a DB-integration test exists that this plan's investigation missed, and it must be removed the same way as Step 2 above (find the anchor, read the file, delete only that test).

- [ ] **Step 4: Commit**

```bash
git add server/services/planningCenter/apply.js server/services/planningCenter/apply.test.js
git commit -m "fix(pco): remove applyArchiveExtras (reconciliation-only apply path)"
```

---

## Task 5: Remove `reconciliationArchived` from review-notification logic

**Files:**
- Modify: `server/services/planningCenter/reviewNotification.js`
- Modify: `server/services/planningCenter/reviewNotification.test.js`

- [ ] **Step 1: Update `reviewNotificationDecision` and `buildPcoReviewMessage`**

```javascript
// old_string
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
```

```javascript
// new_string
// totals/prev shape: { ambiguous, visitorMatches, familyNameUpdatesPending }
// prev is null if there is no prior notification on record.
// Returns { notify, clear }:
//   - notify: create a new notification now
//   - clear: reset the stored "last notified" snapshot to null (everything is
//     resolved, so a future reappearance notifies fresh instead of being
//     compared against a stale, no-longer-relevant snapshot)
function reviewNotificationDecision(prev, totals) {
  const allZero = !totals.ambiguous && !totals.visitorMatches && !totals.familyNameUpdatesPending;
  if (allZero) {
    return { notify: false, clear: !!prev };
  }
  const unchanged = !!prev &&
    prev.ambiguous === totals.ambiguous &&
    prev.visitorMatches === totals.visitorMatches &&
    prev.familyNameUpdatesPending === totals.familyNameUpdatesPending;
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

  if (!parts.length) return '';
  return `${parts.join(', ')} need review in Review & Sync.`;
}
```

- [ ] **Step 2: Update the test file's totals fixtures to drop `reconciliationArchived`, and remove the two reconciliation-specific tests**

```javascript
// old_string
const ZERO = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0, reconciliationArchived: 0 };
```

```javascript
// new_string
const ZERO = { ambiguous: 0, visitorMatches: 0, familyNameUpdatesPending: 0 };
```

Read `server/services/planningCenter/reviewNotification.test.js` in full and:
- Remove `reconciliationArchived: 0` (and nonzero variants) from every other totals/prev object literal in the file (each occurrence found by `grep -n reconciliationArchived` earlier).
- Delete the test `'reviewNotificationDecision: only reconciliationArchived changing still notifies'` entirely.
- Delete the tests `'buildPcoReviewMessage: reconciliation-only archives with nothing else pending'` and its 1-person-singular variant, and update the test that currently expects `'2 ambiguous matches need review in Review & Sync. Reconciliation also archived 3 people you may want to double-check.'` to expect `'2 ambiguous matches need review in Review & Sync.'` instead (drop the `reconciliationArchived: 3` from that test's totals).

- [ ] **Step 3: Run the tests**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test services/planningCenter/reviewNotification.test.js`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add server/services/planningCenter/reviewNotification.js server/services/planningCenter/reviewNotification.test.js
git commit -m "fix(pco): drop reconciliationArchived from review-notification totals"
```

---

## Task 6: Remove reconciliation fields from `settings.js`

**Files:**
- Modify: `server/routes/settings.js:503-589`

- [ ] **Step 1: Trim the GET `/integrations` handler**

```javascript
// old_string
router.get('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const rows = await Database.query(
      `SELECT planning_center_sync_indicator, planning_center_sync_enabled,
              planning_center_reconciliation_schedule_enabled, planning_center_reconciliation_frequency,
              planning_center_reconciliation_day, planning_center_reconciliation_last_run_at,
              planning_center_reconciliation_last_result
       FROM church_settings WHERE church_id = ? LIMIT 1`,
      [req.user.church_id]
    );
    const row = rows[0] || {};
    let reconciliationLastResult = null;
    if (row.planning_center_reconciliation_last_result) {
      try { reconciliationLastResult = JSON.parse(row.planning_center_reconciliation_last_result); } catch (_) {}
    }
    res.json({
      planningCenterSyncIndicator: !!(row.planning_center_sync_indicator),
      planningCenterSyncEnabled: !!(row.planning_center_sync_enabled),
      planningCenterReconciliationScheduleEnabled: !!(row.planning_center_reconciliation_schedule_enabled),
      planningCenterReconciliationFrequency: row.planning_center_reconciliation_frequency || 'weekly',
      planningCenterReconciliationDay: typeof row.planning_center_reconciliation_day === 'number' ? row.planning_center_reconciliation_day : 1,
      planningCenterReconciliationLastRunAt: row.planning_center_reconciliation_last_run_at || null,
      planningCenterReconciliationLastResult: reconciliationLastResult,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve integration settings.' });
  }
});

const PCO_RECONCILIATION_FREQUENCIES = ['daily', 'weekly', 'monthly'];

router.put('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const {
      planningCenterSyncIndicator, planningCenterSyncEnabled,
      planningCenterReconciliationScheduleEnabled, planningCenterReconciliationFrequency,
      planningCenterReconciliationDay,
    } = req.body;
    const updates = [];
    const params = [];
    if (typeof planningCenterSyncIndicator === 'boolean') {
      updates.push('planning_center_sync_indicator = ?');
      params.push(planningCenterSyncIndicator ? 1 : 0);
    }
    if (typeof planningCenterSyncEnabled === 'boolean') {
      updates.push('planning_center_sync_enabled = ?');
      params.push(planningCenterSyncEnabled ? 1 : 0);
    }
    if (typeof planningCenterReconciliationScheduleEnabled === 'boolean') {
      updates.push('planning_center_reconciliation_schedule_enabled = ?');
      params.push(planningCenterReconciliationScheduleEnabled ? 1 : 0);
    }
    if (planningCenterReconciliationFrequency !== undefined) {
      if (!PCO_RECONCILIATION_FREQUENCIES.includes(planningCenterReconciliationFrequency)) {
        return res.status(400).json({ error: 'planningCenterReconciliationFrequency must be one of daily, weekly, monthly.' });
      }
      updates.push('planning_center_reconciliation_frequency = ?');
      params.push(planningCenterReconciliationFrequency);
    }
    if (planningCenterReconciliationDay !== undefined) {
      if (!Number.isInteger(planningCenterReconciliationDay)) {
        return res.status(400).json({ error: 'planningCenterReconciliationDay must be an integer.' });
      }
      // planningCenterReconciliationFrequency and planningCenterReconciliationDay are
      // independent optional fields on this PATCH-style endpoint, so when frequency
      // isn't present in this same request we fall back to the permissive union range
      // (0-31) rather than guessing. The client always sends both together.
      const minDay = planningCenterReconciliationFrequency === 'monthly' ? 1 : 0;
      const maxDay = planningCenterReconciliationFrequency === 'weekly' ? 6 : 31;
      if (planningCenterReconciliationDay < minDay || planningCenterReconciliationDay > maxDay) {
        return res.status(400).json({ error: `planningCenterReconciliationDay must be an integer between ${minDay} and ${maxDay}.` });
      }
      updates.push('planning_center_reconciliation_day = ?');
      params.push(planningCenterReconciliationDay);
    }
    if (updates.length) {
      params.push(req.user.church_id);
      await Database.query(
        `UPDATE church_settings SET ${updates.join(', ')} WHERE church_id = ?`,
        params
      );
    }
    res.json({ message: 'Integration settings updated.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update integration settings.' });
  }
});
```

```javascript
// new_string
router.get('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const rows = await Database.query(
      `SELECT planning_center_sync_indicator, planning_center_sync_enabled
       FROM church_settings WHERE church_id = ? LIMIT 1`,
      [req.user.church_id]
    );
    const row = rows[0] || {};
    res.json({
      planningCenterSyncIndicator: !!(row.planning_center_sync_indicator),
      planningCenterSyncEnabled: !!(row.planning_center_sync_enabled),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve integration settings.' });
  }
});

router.put('/integrations', requireRole(['admin']), async (req, res) => {
  try {
    const { planningCenterSyncIndicator, planningCenterSyncEnabled } = req.body;
    const updates = [];
    const params = [];
    if (typeof planningCenterSyncIndicator === 'boolean') {
      updates.push('planning_center_sync_indicator = ?');
      params.push(planningCenterSyncIndicator ? 1 : 0);
    }
    if (typeof planningCenterSyncEnabled === 'boolean') {
      updates.push('planning_center_sync_enabled = ?');
      params.push(planningCenterSyncEnabled ? 1 : 0);
    }
    if (updates.length) {
      params.push(req.user.church_id);
      await Database.query(
        `UPDATE church_settings SET ${updates.join(', ')} WHERE church_id = ?`,
        params
      );
    }
    res.json({ message: 'Integration settings updated.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update integration settings.' });
  }
});
```

- [ ] **Step 2: Verify**

Run: `grep -n -i reconcil server/routes/settings.js`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add server/routes/settings.js
git commit -m "fix(pco): drop reconciliation fields from integration settings endpoint"
```

---

## Task 7: Remove reconciliation UI from the client

**Files:**
- Delete: `client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx`
- Modify: `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx`
- Modify: `client/src/components/planningCenter/syncSelections.ts`
- Modify: `client/src/components/planningCenter/syncSelections.test.ts`
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Delete the reconciliation review component**

```bash
rm "client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx"
```

- [ ] **Step 2: Remove the reconciliation state, effect wiring, save function, and import from `PlanningCenterIntegrationPanel.tsx`**

```typescript
// old_string
import PlanningCenterSyncReview from '../planningCenter/PlanningCenterSyncReview';
import PlanningCenterReconciliationReview from '../planningCenter/PlanningCenterReconciliationReview';
import PlanningCenterBatchEditor from '../planningCenter/PlanningCenterBatchEditor';
```

```typescript
// new_string
import PlanningCenterSyncReview from '../planningCenter/PlanningCenterSyncReview';
import PlanningCenterBatchEditor from '../planningCenter/PlanningCenterBatchEditor';
```

```typescript
// old_string
import { ordinalDay } from '../../utils/pcoSchedule';
```

```typescript
// new_string
```

(Delete that whole import line — `ordinalDay` becomes unused once the reconciliation section, its only caller, is removed in Step 4.)

```typescript
// old_string
  const [editingBatch, setEditingBatch] = useState<SyncBatch | 'new' | null>(null);
  const [reviewingBatchId, setReviewingBatchId] = useState<number | null>(null);
  const [reconciliationScheduleEnabled, setReconciliationScheduleEnabled] = useState(false);
  const [reconciliationFrequency, setReconciliationFrequency] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [reconciliationDay, setReconciliationDay] = useState(1);
  const [reconciliationLastResult, setReconciliationLastResult] = useState<any>(null);
  const [reconciliationDirty, setReconciliationDirty] = useState(false);
  const [reconciliationSaving, setReconciliationSaving] = useState(false);
  const [showReconciliationReview, setShowReconciliationReview] = useState(false);
  const [showImport, setShowImport] = useState(false);
```

```typescript
// new_string
  const [editingBatch, setEditingBatch] = useState<SyncBatch | 'new' | null>(null);
  const [reviewingBatchId, setReviewingBatchId] = useState<number | null>(null);
  const [showImport, setShowImport] = useState(false);
```

```typescript
// old_string
  const saveReconciliationConfig = async () => {
    setReconciliationSaving(true);
    try {
      await settingsAPI.updateIntegrationSettings({
        planningCenterReconciliationScheduleEnabled: reconciliationScheduleEnabled,
        planningCenterReconciliationFrequency: reconciliationFrequency,
        planningCenterReconciliationDay: reconciliationDay,
      });
      setReconciliationDirty(false);
    } catch (e: any) {
      setPlanningCenterError(e.response?.data?.error || 'Failed to save reconciliation schedule.');
    } finally {
      setReconciliationSaving(false);
    }
  };

  // Handle Planning Center connect (OAuth flow)
```

```typescript
// new_string
  // Handle Planning Center connect (OAuth flow)
```

```typescript
// old_string
  // Load batches, sync indicator, master switch, and reconciliation config when connected
  useEffect(() => {
    if (status.connected) {
      loadBatches();
      settingsAPI.getIntegrationSettings().then(r => {
        setPcSyncIndicator(!!r.data.planningCenterSyncIndicator);
        setPcSyncEnabled(!!r.data.planningCenterSyncEnabled);
        setReconciliationScheduleEnabled(!!r.data.planningCenterReconciliationScheduleEnabled);
        setReconciliationFrequency(r.data.planningCenterReconciliationFrequency || 'weekly');
        setReconciliationDay(typeof r.data.planningCenterReconciliationDay === 'number' ? r.data.planningCenterReconciliationDay : 1);
        setReconciliationLastResult(r.data.planningCenterReconciliationLastResult || null);
      }).catch(() => {});
```

```typescript
// new_string
  // Load batches, sync indicator, and master switch when connected
  useEffect(() => {
    if (status.connected) {
      loadBatches();
      settingsAPI.getIntegrationSettings().then(r => {
        setPcSyncIndicator(!!r.data.planningCenterSyncIndicator);
        setPcSyncEnabled(!!r.data.planningCenterSyncEnabled);
      }).catch(() => {});
```

- [ ] **Step 3: Remove the "Check for people who left" JSX section**

Read `client/src/components/integrations/PlanningCenterIntegrationPanel.tsx` and delete the entire block from the `{/* Reconciliation: people no longer in PCO at all */}` comment through its closing `</div>` (originally lines 412-493 — the block containing the "Check for people who left" heading, the schedule toggle/frequency/day selects, the "Check now" button, and the `<PlanningCenterReconciliationReview />` render). Leave the sibling "Check-in attendance import" section (originally starting at the `{/* Check-in attendance import */}` comment) untouched — it is a separate section right after this one.

- [ ] **Step 4: Remove `buildReconciliationSelections` and `ReconciliationSelections` from `syncSelections.ts`**

```typescript
// old_string
export interface ManualLinkPick { pcoId: string; firstName: string; lastName: string; }

export interface ReconciliationSelections {
  skipArchiveExtraIds: number[];
  manualLinks: Record<string, string>;
}

// skipArchiveExtraIds: archiveExtras individualIds the reviewer deselected
//   (i.e. these LMPG individuals will NOT be archived this run).
// manualLinks: archiveExtras individualId -> a manually-picked PCO person (or null
//   if not linked) — converted here to a pcoId-only map for the apply payload.
export function buildReconciliationSelections(
  skipArchiveExtraIds: Set<number>,
  manualLinks: Record<number, ManualLinkPick | null> = {},
): ReconciliationSelections {
  const links: Record<string, string> = {};
  for (const [individualId, pick] of Object.entries(manualLinks)) {
    if (pick) links[individualId] = pick.pcoId;
  }
  return { skipArchiveExtraIds: [...skipArchiveExtraIds], manualLinks: links };
}
```

```typescript
// new_string
export interface ManualLinkPick { pcoId: string; firstName: string; lastName: string; }
```

Note: `ManualLinkPick` is kept — verify with `grep -rn "ManualLinkPick" client/src/` whether anything besides the deleted reconciliation code used it. If nothing else references it, delete that interface too instead of keeping it.

- [ ] **Step 5: Remove the reconciliation tests from `syncSelections.test.ts`**

```typescript
// old_string
import { describe, it, expect } from 'vitest';
import { buildSelections, buildReconciliationSelections, VisitorChoice } from './syncSelections';
```

```typescript
// new_string
import { describe, it, expect } from 'vitest';
import { buildSelections, VisitorChoice } from './syncSelections';
```

Then delete the entire trailing block:

```typescript
describe('buildReconciliationSelections', () => {
  it('converts skipArchiveExtraIds set into the apply payload', () => {
    const skipArchiveExtraIds = new Set([56, 78]);
    expect(buildReconciliationSelections(skipArchiveExtraIds)).toEqual({
      skipArchiveExtraIds: [56, 78],
      manualLinks: {},
    });
  });

  it('converts manualLinks picks into a pcoId-only map', () => {
    const result = buildReconciliationSelections(new Set(), {
      10: { pcoId: 'p1', firstName: 'A', lastName: 'B' },
      11: null,
    });
    expect(result.manualLinks).toEqual({ 10: 'p1' });
  });
});
```

- [ ] **Step 6: Remove the reconciliation API client functions from `api.ts`**

```typescript
// old_string
  applyPlanningCenterBatch: (id: number, data: { selections?: { ambiguous?: Record<string, string>; skipAddPcoIds?: string[]; visitorChoices?: Record<string, string>; archiveAmbiguousIds?: number[] } }) =>
    api.post(`/integrations/planning-center/sync-batches/${id}/apply`, data, { timeout: 120000 }),
  getPlanningCenterReconciliationPlan: (opts?: { force?: boolean }) =>
    api.get('/integrations/planning-center/reconciliation/plan', {
      params: opts?.force ? { refresh: 1 } : undefined,
      timeout: 120000,
    }),
  applyPlanningCenterReconciliation: (data: { selections?: { skipArchiveExtraIds?: number[] } }) =>
    api.post('/integrations/planning-center/reconciliation/apply', data, { timeout: 120000 }),
  // Check-in attendance import (events discovery + preview + execute)
```

```typescript
// new_string
  applyPlanningCenterBatch: (id: number, data: { selections?: { ambiguous?: Record<string, string>; skipAddPcoIds?: string[]; visitorChoices?: Record<string, string>; archiveAmbiguousIds?: number[] } }) =>
    api.post(`/integrations/planning-center/sync-batches/${id}/apply`, data, { timeout: 120000 }),
  // Check-in attendance import (events discovery + preview + execute)
```

- [ ] **Step 7: Also remove `updateIntegrationSettings`'s reconciliation-typed params if declared explicitly**

Run: `grep -n "planningCenterReconciliation" client/src/services/api.ts`
Expected: no output. If any `updateIntegrationSettings` type signature still lists `planningCenterReconciliation*` fields, remove them from that type too.

- [ ] **Step 8: Rebuild the client container and check for TypeScript/build errors**

Per this repo's convention, do not run `tsc`/`vite build` on the host — rebuild via Docker and read the logs:

Run: `docker-compose -f docker-compose.dev.yml build client`
Expected: build succeeds with no TypeScript errors (in particular, no "unused variable" / "cannot find name" errors for anything reconciliation-related, and no dangling references to the deleted component/file).

- [ ] **Step 9: Run the client test suite**

Run: `docker-compose -f docker-compose.dev.yml run --rm client npm test -- --run syncSelections`
Expected: `buildSelections` tests PASS; no `buildReconciliationSelections` tests remain.

- [ ] **Step 10: Commit**

```bash
git add client/src/components/planningCenter/PlanningCenterReconciliationReview.tsx \
        client/src/components/integrations/PlanningCenterIntegrationPanel.tsx \
        client/src/components/planningCenter/syncSelections.ts \
        client/src/components/planningCenter/syncSelections.test.ts \
        client/src/services/api.ts
git commit -m "fix(pco): remove 'Check for people who left' UI"
```

---

## Task 8: Update living docs

**Files:**
- Modify: `CLAUDE.md` (repo root)
- Modify: `docs/PCO_INTEGRATION_ANALYSIS.md`

- [ ] **Step 1: Update `CLAUDE.md`'s PCO section**

```markdown
// old_string
- **Reconciliation**: a separate, whole-roster check (not tied to any batch) for active LMPG individuals who no longer match anyone in PCO — surfaced for archive/manual-link/skip, on its own schedule.
```

```markdown
// new_string
```

(Delete that bullet entirely — the feature no longer exists. Also search `CLAUDE.md` for any other "reconciliation" mentions with `grep -n -i reconcil CLAUDE.md` and remove them.)

- [ ] **Step 2: Annotate `docs/PCO_INTEGRATION_ANALYSIS.md` as historical where it describes reconciliation**

This file is a point-in-time architecture analysis, not a spec that drives current behavior — don't rewrite it wholesale. Add a short note near the top of its "2. Reconciliation" section (around line 94) marking it removed, e.g.:

```markdown
### 2. Reconciliation ("Check for people who left") — **removed 2026-07-12**

> This feature was removed: PCO rarely deletes people (it marks them inactive
> instead), so "no name-match anywhere in PCO" was a weak, false-positive-prone
> proxy for "this person left" — and the real signal (a *linked* individual's
> PCO status going inactive) was already handled automatically by every batch's
> own `archive` bucket. See `docs/superpowers/plans/2026-07-12-pco-remove-reconciliation.md`.
```

Leave the rest of that section's historical detail below the note intact (it's an accurate record of what existed).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/PCO_INTEGRATION_ANALYSIS.md
git commit -m "docs(pco): note reconciliation removal"
```

---

## Task 9: Full regression pass

- [ ] **Step 1: Run the full server test suite**

Run: `docker-compose -f docker-compose.dev.yml exec server node --test $(find services -name '*.test.js')`

(Adjust the glob/command to however this repo's CI actually discovers server tests if different — check for a `test` script or CI workflow first with `grep -rn "node --test" .github 2>/dev/null` and `cat server/package.json`; use that exact invocation if one exists instead of the ad hoc glob above.)

Expected: all tests PASS, zero references to reconciliation remain.

- [ ] **Step 2: Run the full client test suite**

Run: `docker-compose -f docker-compose.dev.yml run --rm client npm test -- --run`
Expected: all tests PASS.

- [ ] **Step 3: Grep the whole repo for any remaining reconciliation reference outside historical docs**

Run: `grep -rln -i "reconcil" server client --include="*.js" --include="*.ts" --include="*.tsx" | grep -v node_modules`
Expected: no output.

- [ ] **Step 4: Manual smoke test in the browser**

Start the dev stack (`docker-compose -f docker-compose.dev.yml up -d`), log in as an admin of a church with Planning Center connected, open Settings → Integrations → Planning Center, and confirm:
- The "Check for people who left" section is gone.
- The batch list and "Check-in attendance import" sections still render and work as before.
- No console errors on load.
