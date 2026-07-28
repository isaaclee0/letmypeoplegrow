// Real-DB integration tests for the orchestrator (Task 15). Uses a real,
// disposable per-church SQLite database (withTestChurchDb) and every real
// collaborator module (connectionStore, batchRepository, runRepository,
// linkRepository, authority, matcher, plan, apply, planDigest) EXCEPT the
// actual network-calling adapter, which is a fake registered under the
// real 'elvanto' provider name via providerRegistry.registerProvider — the
// only name/shape providerRegistry accepts (see providerRegistry.js; it
// does not support arbitrary third-party provider names). Its behaviour is
// driven by the mutable `scenario` object below, reassigned by each test
// before calling an orchestrator function, so a single module-scoped
// registration (registerProvider throws on a second registration for the
// same name) can still serve many different fetch scenarios.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../../config/database');
const { withTestChurchDb } = require('../../test-helpers/testChurchDb');
const providerRegistry = require('./providerRegistry');
const connectionStore = require('./connectionStore');
const batchRepository = require('./batchRepository');
const runRepository = require('./runRepository');
const authority = require('./authority');
const { COUNT_KEYS } = require('./runRepository');

process.env.SYNC_REVIEW_SECRET = process.env.SYNC_REVIEW_SECRET || 'test-secret-for-orchestrator-dbintegration';
process.env.INTEGRATION_CREDENTIALS_KEY = process.env.INTEGRATION_CREDENTIALS_KEY || Buffer.alloc(32, 5).toString('base64');

let scenario = { people: [], families: [] };
let snapshotFetchCount = 0;

providerRegistry.registerProvider('elvanto', {
  provider: 'elvanto',
  async validateConnection() {
    return { ok: true, metadata: {} };
  },
  async fetchSnapshot({ mode }) {
    snapshotFetchCount += 1;
    return {
      provider: 'elvanto',
      mode: mode === 'incremental' ? 'incremental' : 'full',
      complete: true,
      fetchedAt: new Date().toISOString(),
      watermark: null,
      people: scenario.people,
      families: scenario.families,
    };
  },
  async fetchMetadata() {
    return {};
  },
  validateFilter: () => ({ ok: true, value: {}, errors: [] }),
  isEligible: () => true,
  toFilterFacts(person) {
    return { externalPersonId: String(person.id), dimensions: {} };
  },
  buildFilterDimensions() {
    return [];
  },
  isInFilterPopulation() {
    return true;
  },
});

// Requiring orchestrator.js AFTER registerProvider is not required (getProvider
// resolves lazily at call time), but is done here anyway for readability.
const orchestrator = require('./orchestrator');
const crypto = require('node:crypto');

function personFixture(overrides = {}) {
  return { id: 'ext-1', firstName: 'Ada', lastName: 'Lovelace', state: 'active', child: false, familyId: null, ...overrides };
}

async function seedConnection(churchId, provider = 'elvanto') {
  return connectionStore.upsertConnection({
    churchId, provider, authType: 'api_key', credentials: { apiKey: 'test-key' }, connectedBy: null, metadata: {},
  });
}

async function seedBatch(churchId, provider = 'elvanto', overrides = {}) {
  return batchRepository.createBatch({ churchId, provider, name: 'Members', ...overrides });
}

async function seedIndividual(churchId, overrides = {}) {
  const result = await Database.query(
    `INSERT INTO individuals (church_id, first_name, last_name, is_child, is_active, people_type)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      churchId, overrides.firstName || 'Ada', overrides.lastName || 'Lovelace',
      overrides.isChild ? 1 : 0, overrides.isActive === false ? 0 : 1, overrides.peopleType || 'regular',
    ]
  );
  return Number(result.insertId);
}

async function individualsCount(churchId) {
  const [row] = await Database.query('SELECT COUNT(*) AS n FROM individuals WHERE church_id = ?', [churchId]);
  return Number(row.n);
}

async function missingCount(churchId, provider = 'elvanto') {
  const [row] = await Database.query(
    `SELECT missing_full_sync_count FROM external_person_links WHERE church_id = ? AND provider = ?`,
    [churchId, provider]
  );
  return row ? Number(row.missing_full_sync_count) : null;
}

async function isActive(churchId, individualId) {
  const [row] = await Database.query('SELECT is_active FROM individuals WHERE id = ? AND church_id = ?', [individualId, churchId]);
  return !!Number(row.is_active);
}

test('a discarded initial schema-2 sentinel is blocked before run creation or provider fetch, while reviewed empty is runnable', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    const initial = await batchRepository.createBatch({
      churchId, provider: 'elvanto', name: 'Initial',
      initialDraftFilterConfig: { branches: [], exclusions: [] },
    });
    await Database.query(`UPDATE people_sync_batches SET draft_filter_schema_version = NULL, draft_filter_config = NULL,
      draft_filter_base_revision = NULL, draft_filter_updated_at = NULL WHERE id = ? AND church_id = ?`, [initial.id, churchId]);
    const fetchesBeforeBlock = snapshotFetchCount;
    await assert.rejects(
      orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: initial.id }),
      (error) => error?.code === 'SYNC_FILTER_INITIAL_REVIEW_REQUIRED'
    );
    assert.equal(snapshotFetchCount, fetchesBeforeBlock);
    assert.equal((await runRepository.listRecentRuns(churchId, 'elvanto')).length, 0);
    await batchRepository.deleteBatch(churchId, 'elvanto', initial.id);

    const reviewed = await batchRepository.createBatch({
      churchId, provider: 'elvanto', name: 'Reviewed empty',
      initialDraftFilterConfig: { branches: [], exclusions: [] },
    });
    const digest = crypto.createHash('sha256').update(JSON.stringify({ branches: [], exclusions: [] })).digest('hex');
    await batchRepository.promoteFilterDraftWithConnection(Database.getChurchDb(churchId), {
      churchId, provider: 'elvanto', batchId: reviewed.id, expectedBaseRevision: 1, expectedDraftDigest: digest,
    });
    scenario = { people: [], families: [] };
    const result = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: reviewed.id });
    assert.equal(result.status, 'applied');
    assert.equal(snapshotFetchCount, fetchesBeforeBlock + 1);
  });
});

test('a manual review with no authority chosen yet builds a full preview, never mutates anything, and never proposes brand-new regulars', async () => {
  // Matches plan.js's own tested contract (see plan.test.js's "an inactive
  // provider cannot update authority-owned fields or create regulars" and
  // "manual re-import with no active authority..." cases): a plain manual
  // review while authority_provider is still 'none' may link/update
  // already-linked people, but must never bulk-create new regulars from a
  // provider nobody has chosen as source of truth yet — see the
  // 'create_regular_non_authoritative' skip below. The substantive
  // "actually import my whole roster" flow is previewAuthoritySwitch,
  // covered separately.
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    scenario = { people: [personFixture()], families: [] };

    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });

    assert.equal(typeof review.runId, 'number');
    assert.equal(typeof review.reviewToken, 'string');
    assert.equal(review.summary.addPeople, 0, 'no authority is chosen yet, so a manual review must not create brand-new regulars');
    assert.ok(review.plan.skipped.some((item) => item.reason === 'create_regular_non_authoritative'));
    assert.equal(review.snapshot.mode, 'full');
    assert.equal(await individualsCount(churchId), 0, 'a pure preview must never create anyone');

    const runs = await runRepository.listRecentRuns(churchId, 'elvanto');
    assert.equal(runs[0].status, 'review_required');
    assert.equal(runs[0].trigger, 'manual');
  });
});

test('a manual review once this provider IS the authority proposes new regulars for review', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    scenario = { people: [personFixture()], families: [] };

    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });
    assert.equal(review.summary.addPeople, 1);
    assert.equal(await individualsCount(churchId), 0, 'buildReview is still only a preview, even when authoritative');
  });
});

test('a stale plan (data changed after preview) returns a typed 409 and never applies', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    scenario = { people: [personFixture()], families: [] };
    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });

    // The upstream roster changes before the admin applies the review.
    scenario = { people: [personFixture(), personFixture({ id: 'ext-2', firstName: 'Grace', lastName: 'Hopper' })], families: [] };

    await assert.rejects(
      orchestrator.applyReviewed({ churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken }),
      (err) => err.code === 'SYNC_PLAN_STALE' && err.status === 409
    );
    assert.equal(await individualsCount(churchId), 0);

    const runs = await runRepository.listRecentRuns(churchId, 'elvanto');
    assert.equal(runs[0].status, 'failed');
    assert.equal(runs[0].errorCode, 'SYNC_PLAN_STALE');
  });
});

test('a changed active filter revision invalidates a reviewed draft before people writes and retains the draft', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const draft = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] };
    const batch = await seedBatch(churchId, 'elvanto', {
      filterSchemaVersion: 2,
      initialDraftFilterConfig: draft,
    });
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    scenario = { people: [personFixture()], families: [] };
    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });

    await Database.query(
      `UPDATE people_sync_batches SET filter_revision = filter_revision + 1 WHERE id = ? AND church_id = ? AND provider = ?`,
      [batch.id, churchId, 'elvanto']
    );
    await assert.rejects(
      orchestrator.applyReviewed({ churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken }),
      (err) => err.code === 'SYNC_PLAN_STALE' && err.status === 409
    );
    assert.equal(await individualsCount(churchId), 0);
    assert.deepEqual((await batchRepository.getBatch(churchId, 'elvanto', batch.id)).draftFilterConfig, draft);
  });
});

test('tampered review selections fail before reviewed-draft promotion and retain the draft', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const draft = { branches: [{ groups: [{ dimensionId: 'status', mode: 'any', values: ['active'] }] }], exclusions: [] };
    const batch = await seedBatch(churchId, 'elvanto', {
      filterSchemaVersion: 2,
      initialDraftFilterConfig: draft,
    });
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    scenario = { people: [personFixture()], families: [] };
    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });

    await assert.rejects(
      orchestrator.applyReviewed({
        churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken,
        selections: { skipExternalPersonIds: ['not-offered'] },
      }),
      (err) => err.code === 'SYNC_SELECTIONS_INVALID'
    );
    assert.equal(await individualsCount(churchId), 0);
    assert.deepEqual((await batchRepository.getBatch(churchId, 'elvanto', batch.id)).draftFilterConfig, draft);
  });
});

test('the first authority reconciliation stays pending until applied, then commits', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await seedBatch(churchId);
    scenario = { people: [personFixture()], families: [] };

    const preview = await orchestrator.previewAuthoritySwitch({ churchId, provider: 'elvanto' });
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'none', pending: 'elvanto' });
    assert.equal(preview.summary.addPeople, 1, 'the plan must be built as-if elvanto were already authoritative');

    const applied = await orchestrator.applyReviewed({
      churchId, provider: 'elvanto', batchId: null, reviewToken: preview.reviewToken,
    });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'elvanto', pending: null });
    assert.equal(await individualsCount(churchId), 1);
  });
});

test('a changed pending authority invalidates the review before reconciliation', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    await seedBatch(churchId);
    scenario = { people: [personFixture()], families: [] };

    const preview = await orchestrator.previewAuthoritySwitch({ churchId, provider: 'elvanto' });
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'none', pending: 'elvanto' });

    await Database.query(
      `UPDATE people_sync_settings SET pending_authority_provider = 'planning_center' WHERE church_id = ?`,
      [churchId]
    );
    await assert.rejects(
      orchestrator.applyReviewed({
        churchId, provider: 'elvanto', batchId: null, reviewToken: preview.reviewToken,
      }),
      /out of date/i
    );

    assert.equal(await individualsCount(churchId), 0, 'a stale authority review must not mutate people');

    const runs = await runRepository.listRecentRuns(churchId, 'elvanto');
    assert.equal(runs[0].status, 'failed');
    assert.deepEqual(await authority.getAuthority(churchId), { active: 'none', pending: 'planning_center' });
  });
});

test('a transient finishRun failure after a successful apply retries once and still reaches a terminal status', async () => {
  // Code-review fix: finishRun is best-effort in the post-apply tail, but
  // must still retry once (mirroring safeFailRun's own two-attempt
  // pattern) so the run row reaches a terminal status rather than staying
  // 'running' forever — there is no reaper/stale-run sweep anywhere in
  // this codebase to clean that up later.
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    scenario = { people: [personFixture()], families: [] };

    let finishCalls = 0;
    const flakyFinishRun = async (input) => {
      finishCalls++;
      if (finishCalls === 1) throw new Error('transient db lock');
      return runRepository.finishRun(input);
    };

    const result = await orchestrator.runUnattended(
      { churchId, provider: 'elvanto', batchId: batch.id, forceFull: true },
      { finishRun: flakyFinishRun }
    );

    assert.equal(result.status, 'applied', 'the import must still be reported as successful');
    assert.equal(finishCalls, 2, 'the first finishRun attempt must fail and the retry must succeed');
    assert.equal(await individualsCount(churchId), 1, 'the person must really have been created');

    const runs = await runRepository.listRecentRuns(churchId, 'elvanto');
    assert.equal(runs[0].status, 'applied', 'the run must reach a terminal status via the retry, not stay running');
    assert.notEqual(runs[0].completedAt, null);
  });
});

test('applyReviewed also retries a transient finishRun failure and still reaches a terminal status', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    // Authority must already be 'elvanto' for BOTH the preview and the
    // apply, so the plan rebuilt inside applyReviewed matches the reviewed
    // digest exactly (see the "no authority chosen" gate on new-regular
    // creation covered elsewhere in this file) — otherwise this would
    // legitimately (and correctly) 409 as SYNC_PLAN_STALE instead of
    // reaching the finishRun-retry path this test exists to cover.
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    scenario = { people: [personFixture()], families: [] };
    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });

    let finishCalls = 0;
    const flakyFinishRun = async (input) => {
      finishCalls++;
      if (finishCalls === 1) throw new Error('transient db lock');
      return runRepository.finishRun(input);
    };

    const applied = await orchestrator.applyReviewed(
      { churchId, provider: 'elvanto', batchId: batch.id, reviewToken: review.reviewToken },
      { finishRun: flakyFinishRun }
    );

    assert.equal(applied.status, 'applied');
    assert.equal(finishCalls, 2);
    assert.equal(await individualsCount(churchId), 1);

    const runs = await runRepository.listRecentRuns(churchId, 'elvanto');
    assert.equal(runs[0].status, 'applied');
    assert.notEqual(runs[0].completedAt, null);
  });
});

test('non-authoritative manual review may link identity but not overwrite authority-owned fields; unattended runs are refused', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'planning_center' WHERE church_id = ?`, [churchId]);
    const individualId = await seedIndividual(churchId, { firstName: 'Ada', lastName: 'Lovelace', isChild: false });
    await Database.query(
      `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source)
       VALUES (?, 'planning_center', 'pco-1', ?, 'matched')`,
      [churchId, individualId]
    );

    // Same name (so the matcher links them), but a conflicting child/adult
    // state — the only kind of "managed field" difference reachable
    // without an existing link, since matching itself requires the names
    // to agree.
    scenario = { people: [personFixture({ child: true })], families: [] };

    const review = await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });
    assert.ok(
      review.plan.skipped.some((item) => item.reason === 'active_authority_owned'),
      'a field change on an authority-owned person must be skipped, not applied'
    );
    assert.equal(review.plan.updateManagedFields.length, 0);
    assert.equal(review.plan.linkPeople.length, 1, 'identity linking itself is authority-agnostic and still proposed');

    await assert.rejects(
      orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id }),
      (err) => err.code === 'SYNC_AUTHORITY_MISMATCH'
    );
  });
});

test('a linked person is archived only after two consecutive full reconciliations confirm absence; previews never advance the counter', async () => {
  // Note: a disappeared, linked person necessarily also has no current
  // external counterpart for matcher.js to match against at all, so
  // matchPeople always places them in unmatchedLocalIds -> plan.js's
  // unmatchedLocalRegulars — which is itself one of runUnattended's
  // held-for-review buckets (see orchestrator.js's HELD_REVIEW_BUCKETS).
  // Both reconciliations below therefore classify as review_required
  // (a human is asked to confirm the disappearance), but that is
  // independent of — and does not gate — the archive itself, which only
  // ever fires through plan.js's own presence-projection/confirmed-missing
  // mechanism and is applied unconditionally by apply.js regardless of the
  // run's overall status. The assertions that matter for this test's own
  // purpose are the missing-counter and is_active checks below.
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    const individualId = await seedIndividual(churchId, { firstName: 'Ada', lastName: 'Lovelace' });
    await Database.query(
      `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source, last_seen_at)
       VALUES (?, 'elvanto', 'ext-1', ?, 'matched', datetime('now'))`,
      [churchId, individualId]
    );

    // The linked person now disappears from every subsequent fetch.
    scenario = { people: [], families: [] };

    // Repeated PREVIEWS (buildReview) must never touch the missing counter,
    // however many times an admin clicks "preview".
    await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });
    await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });
    assert.equal(await missingCount(churchId), 0);
    assert.equal(await isActive(churchId, individualId), true);

    // First real full reconciliation: 0 -> 1, not yet archived.
    const first = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id, forceFull: true });
    assert.equal(first.status, 'review_required', 'the disappearance itself is always surfaced for review — see note above');
    assert.equal(first.counts.unmatchedLocalRegulars, 1);
    assert.equal(await missingCount(churchId), 1);
    assert.equal(await isActive(churchId, individualId), true, 'must not archive on the first confirmed miss');

    // A second PREVIEW between the two real reconciliations still must not advance anything.
    await orchestrator.buildReview({ churchId, provider: 'elvanto', batchId: batch.id, trigger: 'manual' });
    assert.equal(await missingCount(churchId), 1);

    // Second consecutive full reconciliation: 1 -> 2, archive fires (even
    // though the run is still classified review_required for the same
    // structural reason as above).
    const second = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id, forceFull: true });
    assert.equal(second.status, 'review_required');
    assert.equal(second.counts.archive, 1);
    assert.equal(await missingCount(churchId), 2);
    assert.equal(await isActive(churchId, individualId), false, 'must archive once absence is confirmed twice');
  });
});

test('an incremental snapshot never reads or updates the disappearance counter', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    // Give the batch a prior watermark so a non-forced run is eligible for incremental mode.
    await Database.query(
      `UPDATE people_sync_batches SET last_external_watermark = 'watermark-1' WHERE id = ? AND church_id = ?`,
      [batch.id, churchId]
    );
    const individualId = await seedIndividual(churchId, { firstName: 'Ada', lastName: 'Lovelace' });
    await Database.query(
      `INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source, last_seen_at)
       VALUES (?, 'elvanto', 'ext-1', ?, 'matched', datetime('now'))`,
      [churchId, individualId]
    );

    scenario = { people: [], families: [] };
    const result = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id, forceFull: false });

    assert.equal(result.fetchMode, 'incremental');
    assert.equal(await missingCount(churchId), 0, 'an incremental run must never touch the disappearance counter');
    assert.equal(await isActive(churchId, individualId), true);
  });
});

test('finished runs record only sanitized, allowlisted counts', async () => {
  await withTestChurchDb(async (churchId) => {
    await seedConnection(churchId);
    const batch = await seedBatch(churchId);
    await Database.query(`UPDATE people_sync_settings SET authority_provider = 'elvanto' WHERE church_id = ?`, [churchId]);
    scenario = { people: [personFixture()], families: [] };

    const result = await orchestrator.runUnattended({ churchId, provider: 'elvanto', batchId: batch.id, forceFull: true });
    assert.equal(result.status, 'applied');

    const runs = await runRepository.listRecentRuns(churchId, 'elvanto');
    const [latest] = runs;
    assert.equal(latest.status, 'applied');
    for (const [key, value] of Object.entries(latest.counts)) {
      assert.ok(COUNT_KEYS.has(key), `count key "${key}" must be allowlisted`);
      assert.ok(Number.isInteger(value) && value >= 0, `count "${key}" must be a non-negative integer`);
    }
    assert.equal(latest.counts.addPeople, 1);
  });
});
