#!/usr/bin/env node
'use strict';

// Offline rehearsal using a disposable SQLite database. Run from any directory:
//   node server/scripts/rehearse-sync-reconciliation.cjs
//   node server/scripts/rehearse-sync-reconciliation.cjs --serve
//   node server/scripts/rehearse-sync-reconciliation.cjs --write-fixture
// The synthetic preview is served on 127.0.0.1:4174/rehearsal.html.
// --private instead rehearses a checkpointed local snapshot using the data-only
// backups/reconciliation-private/scenario.json. That mode is CLI only.
// Merge checks in either mode use a short-lived, authenticated loopback server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const Sqlite = require('better-sqlite3');

const root = path.resolve(__dirname, '../..');
const provider = 'planning_center';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const syntheticScenario = {
  churchId: 'demorehearsal', batchId: 10, rosterPersonId: 101, detachedPersonId: 102,
  sharedHouseholdPeople: [103, 104], householdId: 'demo-shared-household', householdName: 'Sample household',
  heldPerson: { id: 'demo-held-person', firstName: 'Casey', lastName: 'Sample' },
  mergePairs: [[201, 202], [203, 204]],
};
const trackedTables = ['individuals', 'families', 'gathering_lists', 'attendance_sessions', 'attendance_records', 'headcount_records', 'external_person_links', 'external_family_links'];

function rows(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
}

function changedRows(before, after) {
  const old = new Map(before.map((row) => [row.id, row]));
  const current = new Map(after.map((row) => [row.id, row]));
  return {
    added: after.filter((row) => !old.has(row.id)).map((row) => row.id),
    removed: before.filter((row) => !current.has(row.id)).map((row) => row.id),
    updated: after.filter((row) => old.has(row.id) && JSON.stringify(old.get(row.id)) !== JSON.stringify(row)).map((row) => row.id),
  };
}

function seedSyntheticChurch(db) {
  const { churchId, batchId, heldPerson } = syntheticScenario;
  // Use the normal schema and real relationships. All identities, list
  // memberships, attendance and engagement history below are invented.
  const insert = (sql, ...params) => db.prepare(sql).run(churchId, ...params);
  db.transaction(() => {
    insert("INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Rehearsal church')");
    db.prepare("UPDATE people_sync_settings SET authority_provider = ?, sync_enabled = 0 WHERE church_id = ?").run(provider, churchId);
    insert("INSERT INTO users (church_id, id, role) VALUES (?, 1, 'admin')");
    for (const [id, name] of [[1, 'Morning gathering'], [2, 'Midweek gathering']]) {
      insert('INSERT INTO gathering_types (church_id, id, name) VALUES (?, ?, ?)', id, name);
    }
    insert(`INSERT INTO people_sync_batches
      (church_id, id, provider, name, gathering_type_id, source_kind, source_external_id, source_name)
      VALUES (?, ?, ?, 'Morning roster', 1, 'planning_center_list', 'demo-morning-list', 'Morning list')`, batchId, provider);
    for (const [id, name] of [[11, 'Alder'], [12, 'Birch'], [13, 'Cedar']]) {
      insert('INSERT INTO families (church_id, id, family_name) VALUES (?, ?, ?)', id, name);
    }
    for (const [id, first, last, familyId, externalId] of [
      [101, 'Quinn', 'Sample', null, 'demo-roster'], [102, 'Taylor', 'Sample', 11, 'demo-detach'],
      [103, 'Lane', 'Sample', 12, 'demo-lane'], [104, 'Robin', 'Sample', 13, 'demo-robin'],
      [201, 'Sam', 'Example', 12, null], [202, 'Sam', 'Example', null, 'demo-sam'],
      [203, 'Alex', 'Example', 13, 'demo-alex'], [204, 'Alexis', 'Example', null, null],
    ]) {
      insert('INSERT INTO individuals (church_id, id, first_name, last_name, family_id, planning_center_id) VALUES (?, ?, ?, ?, ?, ?)', id, first, last, familyId, externalId);
      if (externalId) insert("INSERT INTO external_person_links (church_id, provider, external_person_id, individual_id, link_source) VALUES (?, ?, ?, ?, 'manual')", provider, externalId, id);
    }
    insert("INSERT INTO people_sync_match_holds (church_id, provider, external_person_id, reason) VALUES (?, ?, ?, 'deferred')", provider, heldPerson.id);
    for (const id of [101, 102, 103, 104, 201, 204]) {
      insert('INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id) VALUES (?, 1, ?)', id);
    }
    for (const id of [101, 202, 203]) insert('INSERT INTO gathering_lists (church_id, gathering_type_id, individual_id) VALUES (?, 2, ?)', id);
    for (const [id, date] of [[1, '2025-01-05'], [2, '2025-01-12']]) {
      insert('INSERT INTO attendance_sessions (church_id, id, gathering_type_id, session_date, created_by) VALUES (?, ?, 1, ?, 1)', id, date);
    }
    for (const [session, person, present] of [[1, 101, 1], [1, 102, 0], [1, 201, null], [1, 202, 0], [2, 202, 1], [1, 203, 0], [1, 204, 1], [2, 203, 1]]) {
      insert('INSERT INTO attendance_records (church_id, session_id, individual_id, present) VALUES (?, ?, ?, ?)', session, person, present);
    }
    insert('INSERT INTO headcount_records (church_id, session_id, headcount, updated_by) VALUES (?, 1, 7, 1)');
    for (const [, duplicate] of syntheticScenario.mergePairs) {
      insert(`INSERT INTO engagement_decline_events (church_id, individual_id, from_tier, to_tier, effective_week_end, rules_version)
        VALUES (?, ?, 'core', 'casual', '2025-01-12', 1)`, duplicate);
      insert(`INSERT INTO engagement_tier_transitions (church_id, individual_id, axis, from_tier, to_tier, candidate_started_week_end,
        confirmed_week_end, rules_version, long_term_attended, long_term_opportunities, long_term_rate, confirmation_attended,
        confirmation_opportunities, confirmation_rate) VALUES (?, ?, 'primary', 'core', 'casual', '2025-01-05', '2025-01-12', 1, 1, 2, 0.5, 1, 2, 0.5)`, duplicate);
    }
  })();
}

async function rehearseMerges(Database, db, { churchId, mergePairs }) {
  // Exercise the real authenticated router (including engagement history), not
  // just its lower-level attendance helper. The listener exists only during
  // these two requests and can access only the disposable database.
  const http = require('node:http');
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const previousJwtSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  Database.getRegistryDb().prepare("INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Local rehearsal', 1)").run(churchId);
  const user = db.prepare("SELECT id FROM users WHERE church_id = ? AND role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get(churchId);
  assert.ok(user, 'The restored snapshot must contain an active admin for route authorization');
  const token = jwt.sign({ userId: user.id, churchId }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const app = express();
  app.use(express.json());
  app.use('/api/individuals', require('../routes/individuals'));
  const server = http.createServer(app);
  const evidence = [];
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    for (const [keepId, deleteId] of mergePairs) {
      const peopleBefore = rows(db, 'individuals');
      const survivorBefore = peopleBefore.find((row) => row.id === keepId);
      assert.ok(survivorBefore && peopleBefore.some((row) => row.id === deleteId));
      const attendanceBefore = rows(db, 'attendance_records');
      const sessionsBefore = rows(db, 'attendance_sessions');
      const relevant = attendanceBefore.filter((row) => [keepId, deleteId].includes(row.individual_id));
      const sessionUnion = new Map();
      for (const row of relevant) {
        const previous = sessionUnion.get(row.session_id);
        // Tri-state OR: any present wins; otherwise absent wins over untracked.
        const strength = (value) => value === 1 ? 2 : value === 0 ? 1 : 0;
        sessionUnion.set(row.session_id, previous === undefined || strength(row.present) > strength(previous) ? row.present : previous);
      }
      const providerLinksBefore = db.prepare('SELECT provider, external_person_id FROM external_person_links WHERE church_id = ? AND individual_id IN (?, ?) ORDER BY provider, external_person_id').all(churchId, keepId, deleteId);
      const gatheringUnion = [...new Set(db.prepare('SELECT gathering_type_id FROM gathering_lists WHERE church_id = ? AND individual_id IN (?, ?)').all(churchId, keepId, deleteId).map((row) => row.gathering_type_id))].sort((a, b) => a - b);
      const historyBefore = Object.fromEntries(['engagement_decline_events', 'engagement_tier_transitions'].map((table) => [table, rows(db, table).filter((row) => [keepId, deleteId].includes(row.individual_id))]));
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/individuals/deduplicate`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepId, deleteIds: [deleteId], mergeAssignments: true }), signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, JSON.stringify(await response.json()));
      const after = rows(db, 'attendance_records');
      const survivingAttendance = after.filter((row) => row.individual_id === keepId);
      assert.deepEqual(survivingAttendance.map((row) => [row.session_id, row.present]).sort((a, b) => a[0] - b[0]), [...sessionUnion].sort((a, b) => a[0] - b[0]), 'Every unique session and its strongest present evidence must survive');
      assert.equal(after.some((row) => row.individual_id === deleteId), false);
      assert.deepEqual(after.filter((row) => row.individual_id !== keepId), attendanceBefore.filter((row) => ![keepId, deleteId].includes(row.individual_id)), 'Unrelated attendance must not change');
      assert.deepEqual(rows(db, 'attendance_sessions'), sessionsBefore, 'Session notes and history must not change');
      const peopleAfter = rows(db, 'individuals');
      const survivor = peopleAfter.find((row) => row.id === keepId);
      assert.equal(survivor.family_id, survivorBefore.family_id, 'The selected survivor keeps its family');
      assert.equal(peopleAfter.some((row) => row.id === deleteId), false);
      assert.deepEqual(peopleAfter.filter((row) => row.id !== keepId), peopleBefore.filter((row) => ![keepId, deleteId].includes(row.id)), 'Unrelated people must not change');
      assert.deepEqual(db.prepare('SELECT provider, external_person_id FROM external_person_links WHERE church_id = ? AND individual_id = ? ORDER BY provider, external_person_id').all(churchId, keepId), providerLinksBefore);
      assert.equal(survivor.planning_center_id, providerLinksBefore.find((link) => link.provider === provider).external_person_id);
      assert.deepEqual(db.prepare('SELECT gathering_type_id FROM gathering_lists WHERE church_id = ? AND individual_id = ? ORDER BY gathering_type_id').all(churchId, keepId).map((row) => row.gathering_type_id), gatheringUnion);
      for (const [table, history] of Object.entries(historyBefore)) {
        const current = rows(db, table);
        assert.equal(current.some((row) => row.individual_id === deleteId), false);
        for (const row of history) assert.ok(current.some((candidate) => candidate.individual_id === keepId && candidate.id === row.id), 'Engagement history must survive');
      }
      evidence.push({ familyRetained: true, providerLinkPreserved: true,
        inputAttendanceRows: relevant.length, outputSessionCount: sessionUnion.size,
        overlapRowsConsolidated: relevant.length - sessionUnion.size,
        presentSessions: survivingAttendance.filter((row) => row.present === 1).length,
        everySessionMatchesPresentOR: true, unrelatedAttendanceUnchanged: true,
        engagementHistoryRows: Object.fromEntries(Object.entries(historyBefore).map(([table, history]) => [table, history.length])),
      });
    }
    return evidence;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (previousJwtSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previousJwtSecret;
  }
}

function stageSnapshot(source, copy) {
  if (fs.existsSync(`${source}-wal`) && fs.statSync(`${source}-wal`).size) {
    throw new Error('Supply a checkpointed backup without an active WAL.');
  }
  const originalHash = sha(fs.readFileSync(source));
  fs.copyFileSync(source, copy);
  fs.chmodSync(copy, 0o600);
  const staged = new Sqlite(copy, { fileMustExist: true });
  try {
    // In the copy, remove credentials and disable scheduling before loading
    // application code. The rehearsal supplies the entire provider response.
    staged.exec(`DELETE FROM integration_connections;
      DELETE FROM user_preferences WHERE preference_key LIKE '%token%' OR preference_key LIKE '%credential%';
      UPDATE people_sync_settings SET sync_enabled = 0;
      UPDATE people_sync_batches SET schedule_enabled = 0;
      UPDATE planning_center_sync_batches SET schedule_enabled = 0;
      UPDATE church_settings SET planning_center_sync_enabled = 0, weekly_review_email_enabled = 0, brevo_api_key = NULL;
      UPDATE users SET email_notifications = 0;`);
  } finally {
    staged.close();
  }
  return originalHash;
}

async function rehearse(scenario) {
  const { churchId, batchId, rosterPersonId, detachedPersonId, sharedHouseholdPeople, householdId, householdName, heldPerson } = scenario;
  assert.match(churchId, /^[A-Za-z0-9_-]+$/, 'Expected a simple church ID');
  const ids = new Set([rosterPersonId, detachedPersonId, ...sharedHouseholdPeople]);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmpg-sync-rehearsal-'));
  const previousDataDir = process.env.CHURCH_DATA_DIR;
  const previousSecret = process.env.SYNC_REVIEW_SECRET;
  let Database;
  try {
    const copy = path.join(tempDir, 'churches', `${churchId}.sqlite`);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    const source = scenario.snapshot && path.resolve(root, 'backups', scenario.snapshot);
    const originalHash = source && stageSnapshot(source, copy);
    process.env.CHURCH_DATA_DIR = tempDir;
    process.env.SYNC_REVIEW_SECRET = crypto.randomBytes(32).toString('hex');
    Database = require('../config/database');
    Database.initialize();
    const db = Database.getChurchDb(churchId);
    assert.equal(fs.realpathSync(db.name), fs.realpathSync(copy));
    if (!source) seedSyntheticChurch(db);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    const { loadLocalProjectionState } = require('../services/peopleSync/localProjectionState');
    const { computePeopleSyncPlan, summarizePlan } = require('../services/peopleSync/plan');
    const { matchPeople } = require('../services/peopleSync/matcher');
    const { buildReviewContext, buildReviewDirectory } = require('../services/peopleSync/reviewContext');
    const { digestPlan, createReviewToken, verifyReviewToken } = require('../services/peopleSync/planDigest');
    const { applyPeopleSyncPlan } = require('../services/peopleSync/apply');
    const state = await loadLocalProjectionState(churchId, provider);
    const localPeople = state.individuals.filter((person) => ids.has(person.id));
    assert.equal(localPeople.length, 4);
    assert.ok(state.matchReviewState.holds.some((hold) => hold.externalPersonId === heldPerson.id), 'Expected a held identity');
    const personLinks = state.personLinks.filter((link) => ids.has(link.individualId));
    const externalPeople = localPeople.filter((person) => person.id !== rosterPersonId).map((person) => ({
      id: personLinks.find((link) => link.individualId === person.id).externalPersonId,
      firstName: person.firstName, lastName: person.lastName, child: person.isChild,
      state: 'active', familyId: person.id === detachedPersonId ? null : householdId,
      householdIds: person.id === detachedPersonId ? [] : [householdId],
    }));
    externalPeople.push({ ...heldPerson, child: false, state: 'active', familyId: null, householdIds: [] });
    const externalFamilies = [{ id: householdId, name: householdName, memberExternalIds: externalPeople.filter((person) => person.familyId === householdId).map((person) => person.id) }];
    const { listBatches } = require('../services/peopleSync/batchRepository');
    const batches = await listBatches(churchId, provider);
    // The offline source includes the example people in one batch. Other
    // active sources in this scenario have complete, empty membership sets.
    const memberIdsByBatch = new Map(batches.filter((batch) => batch.enabled && batch.source).map((batch) =>
      [batch.id, new Set(batch.id === batchId ? externalPeople.map((person) => person.id) : [])]));
    const eligibleByBatch = memberIdsByBatch;
    const plan = computePeopleSyncPlan({
      provider, authoritative: true, activeAuthority: provider,
      snapshot: { mode: 'full', complete: true, fetchedAt: '2025-01-13T00:00:00.000Z', watermark: 'offline-rehearsal' },
      externalPeople, externalFamilies, localPeople, localFamilies: state.families,
      personLinks, familyLinks: state.familyLinks,
      gatheringMemberships: state.gatheringMemberships.filter((row) => ids.has(row.individualId)),
      batches, allBatches: batches, eligibleByBatch, memberIdsByBatch,
      matcher: matchPeople({ externalPeople, localPeople, existingLinks: personLinks, heldExternalIds: new Set([heldPerson.id]) }),
    });
    plan.operationKind = 'people_sync';
    plan.reviewContext = buildReviewContext({
      plan, externalPeople, localPeople: state.individuals, localFamilies: state.families,
      basePersonLinks: state.personLinks, projectedPersonLinks: state.personLinks,
      baseExclusions: state.matchReviewState.exclusions, projectedExclusions: state.matchReviewState.exclusions,
      baseHolds: state.matchReviewState.holds, projectedHolds: state.matchReviewState.holds,
      sourceExternalIds: new Set(externalPeople.map((person) => person.id)), batches, eligibleByBatch,
    });
    plan.people = buildReviewDirectory({ externalPeople, externalFamilies, localPeople: state.individuals, localFamilies: state.families, reviewContext: plan.reviewContext });
    const personalFamily = plan.familyConflicts.find((action) => action.resolution?.kind === 'single_person');
    assert.equal(plan.familyConflicts.filter((action) => action.resolution?.kind === 'household').length, 1);
    assert.equal(plan.removeFromGathering.length, 1);
    assert.equal(plan.removeFromGathering[0].individualId, rosterPersonId);
    assert.equal(plan.ambiguousPeople[0].externalPersonId, heldPerson.id);
    const planDigest = digestPlan(plan);
    const reviewToken = createReviewToken({ operationKind: 'people_sync', churchId, provider, batchId, planDigest, expiresInSeconds: 1800 });
    const review = { operationKind: 'people_sync', runId: 1, reviewToken, decisionContractVersion: 2, summary: summarizePlan(plan), plan, snapshot: plan.snapshot };
    const before = Object.fromEntries(trackedTables.map((table) => [table, rows(db, table)]));
    const selections = { decisionContractVersion: 2, identityDecisions: { [heldPerson.id]: { outcome: 'defer' } }, acceptFamilyResolutionIds: plan.familyConflicts.filter((action) => action.resolution).map((action) => action.id), acceptGatheringRemovalIds: [plan.removeFromGathering[0].id] };
    const result = await applyPeopleSyncPlan({ churchId, provider, plan, selections, reviewedApply: { operationKind: 'people_sync', reviewToken, planDigest, batchId, verifyReviewToken } });
    const after = Object.fromEntries(trackedTables.map((table) => [table, rows(db, table)]));
    const changes = Object.fromEntries(trackedTables.map((table) => [table, changedRows(before[table], after[table])]));
    for (const table of ['attendance_sessions', 'attendance_records', 'headcount_records']) assert.deepEqual(after[table], before[table], `${table} must remain byte-for-byte equal as rows`);
    assert.deepEqual(changes.individuals, { added: [], removed: [], updated: [...(personalFamily ? [detachedPersonId] : []), ...sharedHouseholdPeople].sort((a, b) => a - b) });
    const personAfter = (id) => after.individuals.find((row) => row.id === id);
    if (personalFamily) {
      const family = after.families.find((row) => row.id === personAfter(detachedPersonId).family_id);
      assert.equal(family.family_name, personalFamily.resolution.destination.familyName);
      assert.ok(changes.families.added.includes(family.id));
      assert.equal(after.external_family_links.some((link) => link.family_id === family.id), false);
    } else {
      assert.equal(personAfter(detachedPersonId).family_id, before.individuals.find((row) => row.id === detachedPersonId).family_id, 'An existing local singleton keeps its display name and family');
    }
    assert.equal(changes.families.added.length, personalFamily ? 2 : 1);
    const sharedFamilyId = personAfter(sharedHouseholdPeople[0]).family_id;
    assert.ok(changes.families.added.includes(sharedFamilyId));
    for (const id of sharedHouseholdPeople) assert.equal(personAfter(id).family_id, sharedFamilyId);
    assert.deepEqual(changes.families.updated, []);
    assert.deepEqual(changes.families.removed, []);
    const removal = plan.removeFromGathering[0];
    const removedRow = before.gathering_lists.find((row) => row.individual_id === rosterPersonId && row.gathering_type_id === removal.gatheringTypeId);
    assert.deepEqual(changes.gathering_lists, { added: [], removed: [removedRow.id], updated: [] });
    assert.equal(changes.external_family_links.added.length, 1);
    assert.equal(after.individuals.length, before.individuals.length, 'Deferral must not import the held person');
    const duplicateMerges = await rehearseMerges(Database, db, scenario);
    if (source) assert.equal(sha(fs.readFileSync(source)), originalHash, 'Original snapshot must be unchanged');
    const evidence = {
      status: 'passed', mode: source ? 'private' : 'synthetic',
      ...(source ? { sourceSnapshotUnchanged: true } : {}),
      attendance: Object.fromEntries(['attendance_sessions', 'attendance_records', 'headcount_records'].map((table) => [table, { rows: before[table].length, unchanged: true }])),
      appliedCounts: result, duplicateMerges,
      finalAttendanceRowCountAfterDuplicateMerges: rows(db, 'attendance_records').length,
    };
    if (source) return { evidence };
    // The browser only captures selections. Keep signed tokens and server-only
    // verification fields within this process even for synthetic examples.
    review.reviewToken = 'synthetic-review-preview';
    delete review.plan.reviewContext.localIdentityDigest;
    return { review, evidence };
  } finally {
    Database?.closeAll();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.CHURCH_DATA_DIR; else process.env.CHURCH_DATA_DIR = previousDataDir;
    if (previousSecret === undefined) delete process.env.SYNC_REVIEW_SECRET; else process.env.SYNC_REVIEW_SECRET = previousSecret;
  }
}

async function serve(fixture) {
  const client = path.join(root, 'client');
  const { createServer } = await import(pathToFileURL(path.join(client, 'node_modules/vite/dist/node/index.js')).href);
  const vite = await createServer({
    root: client,
    server: { host: '127.0.0.1', port: 4174, strictPort: true, open: false, fs: { strict: true, allow: [client] } },
    plugins: [{
      name: 'local-reconciliation-rehearsal',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/api/')) { res.writeHead(403); res.end('Application APIs are disabled in this offline rehearsal.'); return; }
          if (req.url !== '/__rehearsal/review') return next();
          if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify(fixture));
        });
      },
    }],
  });
  try {
    await vite.listen();
  } catch (error) {
    await vite.close();
    throw error;
  }
  console.log('\nLocal rehearsal: http://127.0.0.1:4174/rehearsal.html\nBrowser Apply is a simulation; the verified disposable SQLite database has already been deleted.');
}

async function main(args) {
  const mode = args[0];
  if (args.length > 1 || (mode && !['--private', '--write-fixture', '--serve'].includes(mode))) {
    throw new Error('Use one rehearsal mode: default, --serve, --write-fixture, or --private (CLI only).');
  }
  let scenario = syntheticScenario;
  if (mode === '--private') {
    scenario = JSON.parse(fs.readFileSync(path.join(root, 'backups/reconciliation-private/scenario.json'), 'utf8'));
    assert.ok(scenario.snapshot, 'A checkpointed snapshot is required in private mode');
  }
  const fixture = await rehearse(scenario);
  console.log(JSON.stringify(fixture.evidence, null, 2));
  if (mode === '--serve') await serve(fixture);
  if (mode === '--write-fixture') {
    const dir = path.join(root, 'client/src/dev/fixtures');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reconciliation.synthetic.json'), JSON.stringify({ review: fixture.review }, null, 2) + '\n');
  }
}
main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
