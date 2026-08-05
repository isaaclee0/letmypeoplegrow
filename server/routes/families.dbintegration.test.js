const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const { consolidateGatheringAssignments } = require('./families');
const individualsRouter = require('./individuals');
const familiesRouter = require('./families');
const settingsRouter = require('./settings');
const { beginAuthoritySwitch, commitAuthoritySwitch, updatePeopleSyncPolicy } = require('../services/peopleSync/authority');

async function seedUser(churchId) {
  const res = await Database.query(
    `INSERT INTO users (email, role, first_name, last_name, is_active, church_id)
     VALUES (?, 'admin', 'Admin', 'User', 1, ?)`,
    [`admin-${Math.random().toString(36).slice(2)}@example.com`, churchId]
  );
  return res.insertId;
}

async function seedIndividual(churchId) {
  const res = await Database.query(
    `INSERT INTO individuals (first_name, last_name, church_id, is_active)
     VALUES ('Test', 'Person', ?, 1)`,
    [churchId]
  );
  return res.insertId;
}

async function seedGatheringType(churchId, name) {
  const res = await Database.query(
    `INSERT INTO gathering_types (name, church_id) VALUES (?, ?)`,
    [name, churchId]
  );
  return res.insertId;
}

async function assignToGathering(churchId, gatheringTypeId, individualId, addedBy) {
  await Database.query(
    `INSERT INTO gathering_lists (gathering_type_id, individual_id, added_by, church_id)
     VALUES (?, ?, ?, ?)`,
    [gatheringTypeId, individualId, addedBy, churchId]
  );
}

async function getAssignments(churchId) {
  return Database.query(
    `SELECT gathering_type_id, individual_id, added_by
     FROM gathering_lists WHERE church_id = ?
     ORDER BY gathering_type_id, individual_id`,
    [churchId]
  );
}

async function startPeopleRouteApp(churchId) {
  const userId = await seedUser(churchId);
  Database.getRegistryDb().prepare(
    `INSERT INTO churches (church_id, church_name, is_approved) VALUES (?, 'Test Church', 1)`
  ).run(churchId);
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'authority-route-test-secret';
  const token = jwt.sign({ userId, churchId }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/individuals', individualsRouter);
  app.use('/api/families', familiesRouter);
  app.use('/api/settings', settingsRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    request: async (path, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
      return { status: response.status, body: await response.json() };
    },
    close: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => server.close(resolve));
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
    },
  };
}

async function withRouteChurchDb(fn) {
  return withTestChurchDb(async () => {
    const churchId = `tst${Math.random().toString(36).slice(2, 12)}`;
    Database.getChurchDb(churchId);
    await Database.queryForChurch(
      churchId,
      `INSERT INTO church_settings (church_id, church_name) VALUES (?, 'Route Test Church')`,
      [churchId]
    );
    return Database.setChurchContext(churchId, () => fn(churchId));
  });
}

async function activateAuthority(churchId, provider) {
  await beginAuthoritySwitch(churchId, provider);
  await commitAuthoritySwitch(churchId, provider);
}

async function seedFamily(churchId, name = 'Example') {
  const result = await Database.query(
    `INSERT INTO families (church_id, family_name) VALUES (?, ?)`,
    [churchId, name]
  );
  return Number(result.insertId);
}

async function linkPerson(churchId, individualId, provider, externalId) {
  await Database.query(
    `INSERT INTO external_person_links
       (church_id, provider, external_person_id, individual_id, link_source)
     VALUES (?, ?, ?, ?, 'matched')`,
    [churchId, provider, externalId, individualId]
  );
}

async function linkFamily(churchId, familyId, provider, externalId) {
  await Database.query(
    `INSERT INTO external_family_links
       (church_id, provider, external_family_id, family_id, link_source)
     VALUES (?, ?, ?, ?, 'matched')`,
    [churchId, provider, externalId, familyId]
  );
}

test('consolidateGatheringAssignments assigns every individual to the union of gathering types held by any of them', async () => {
  await withTestChurchDb(async (churchId) => {
    const admin = await seedUser(churchId);
    const gatheringA = await seedGatheringType(churchId, 'Sunday AM');
    const gatheringB = await seedGatheringType(churchId, 'Youth Group');

    const alice = await seedIndividual(churchId);
    const bob = await seedIndividual(churchId);
    const carol = await seedIndividual(churchId);

    // Alice was only in gathering A, Bob only in gathering B, Carol in neither.
    await assignToGathering(churchId, gatheringA, alice, admin);
    await assignToGathering(churchId, gatheringB, bob, admin);

    await Database.transaction((conn) =>
      consolidateGatheringAssignments(conn, {
        individualIds: [alice, bob, carol],
        churchId,
        addedBy: admin,
      })
    );

    const assignments = await getAssignments(churchId);
    const pairs = assignments.map((a) => `${a.gathering_type_id}:${a.individual_id}`).sort();

    const expected = [
      `${gatheringA}:${alice}`,
      `${gatheringA}:${bob}`,
      `${gatheringA}:${carol}`,
      `${gatheringB}:${alice}`,
      `${gatheringB}:${bob}`,
      `${gatheringB}:${carol}`,
    ].sort();

    assert.deepStrictEqual(pairs, expected);

    // Regression guard: individual_id must always reference one of the merged
    // individuals, never a families-table id (the original bug).
    for (const a of assignments) {
      assert.ok([alice, bob, carol].includes(a.individual_id));
    }
  });
});

test('consolidateGatheringAssignments does not duplicate an existing row, and refreshes added_by via ON CONFLICT', async () => {
  await withTestChurchDb(async (churchId) => {
    const firstAdmin = await seedUser(churchId);
    const secondAdmin = await seedUser(churchId);
    const gatheringA = await seedGatheringType(churchId, 'Sunday AM');

    const alice = await seedIndividual(churchId);
    const bob = await seedIndividual(churchId);

    await assignToGathering(churchId, gatheringA, alice, firstAdmin);

    await Database.transaction((conn) =>
      consolidateGatheringAssignments(conn, {
        individualIds: [alice, bob],
        churchId,
        addedBy: secondAdmin,
      })
    );

    const assignments = await getAssignments(churchId);
    assert.strictEqual(assignments.length, 2);

    const aliceRow = assignments.find((a) => a.individual_id === alice);
    assert.strictEqual(aliceRow.added_by, secondAdmin);
  });
});

test('Elvanto authority blocks regular creation but leaves visitor creation available', async () => {
  await withRouteChurchDb(async (churchId) => {
    await activateAuthority(churchId, 'elvanto');
    const app = await startPeopleRouteApp(churchId);
    try {
      const regular = await app.request('/api/individuals', {
        method: 'POST',
        body: JSON.stringify({ firstName: 'New', lastName: 'Member' }),
      });
      assert.strictEqual(regular.status, 403);
      assert.strictEqual(regular.body.code, 'PEOPLE_SOURCE_LOCKED');
      assert.strictEqual(regular.body.provider, 'elvanto');

      const visitor = await app.request('/api/families/visitor', {
        method: 'POST',
        body: JSON.stringify({
          familyName: 'Visitor Family', peopleType: 'local_visitor',
          people: [{ firstName: 'Local', lastName: 'Visitor' }],
        }),
      });
      assert.strictEqual(visitor.status, 201);

      const disguisedRegular = await app.request('/api/families/visitor', {
        method: 'POST',
        body: JSON.stringify({
          familyName: 'Regular Family', peopleType: 'regular',
          people: [{ firstName: 'Not', lastName: 'Visitor' }],
        }),
      });
      assert.strictEqual(disguisedRegular.status, 403);
      assert.strictEqual(disguisedRegular.body.code, 'PEOPLE_SOURCE_LOCKED');
    } finally {
      await app.close();
    }
  });
});

test('unlocked People-page editing permits local changes while an authority is active', async () => {
  await withRouteChurchDb(async (churchId) => {
    const individualId = await seedIndividual(churchId);
    await linkPerson(churchId, individualId, 'elvanto', 'elvanto-person');
    await activateAuthority(churchId, 'elvanto');
    await updatePeopleSyncPolicy(churchId, { peopleEditingLocked: false });
    const app = await startPeopleRouteApp(churchId);
    try {
      const created = await app.request('/api/individuals', {
        method: 'POST', body: JSON.stringify({ firstName: 'New', lastName: 'Member' }),
      });
      assert.strictEqual(created.status, 201);

      const edited = await app.request(`/api/individuals/${individualId}`, {
        method: 'PUT', body: JSON.stringify({ firstName: 'Changed', lastName: 'Person' }),
      });
      assert.strictEqual(edited.status, 200);
    } finally {
      await app.close();
    }
  });
});

test('only active-authority person links lock managed fields while local badges remain editable', async () => {
  await withRouteChurchDb(async (churchId) => {
    const elvantoManaged = await seedIndividual(churchId);
    const pcoOnly = await seedIndividual(churchId);
    const managedFamily = await seedFamily(churchId, 'Managed Badge Family');
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id = ? AND church_id = ?`,
      [managedFamily, elvantoManaged, churchId]
    );
    await linkPerson(churchId, elvantoManaged, 'elvanto', 'elvanto-managed');
    await linkPerson(churchId, elvantoManaged, 'planning_center', 'pco-also-linked');
    await linkPerson(churchId, pcoOnly, 'planning_center', 'pco-only');
    await activateAuthority(churchId, 'elvanto');
    const app = await startPeopleRouteApp(churchId);
    try {
      const locked = await app.request(`/api/individuals/${elvantoManaged}`, {
        method: 'PUT',
        body: JSON.stringify({ firstName: 'Changed', lastName: 'Name' }),
      });
      assert.strictEqual(locked.status, 403);
      assert.strictEqual(locked.body.provider, 'elvanto');

      const badge = await app.request(`/api/individuals/${elvantoManaged}`, {
        method: 'PUT',
        body: JSON.stringify({ badgeText: 'Local badge' }),
      });
      assert.strictEqual(badge.status, 200);

      const productionShapeBadge = await app.request(`/api/individuals/${elvantoManaged}`, {
        method: 'PUT',
        body: JSON.stringify({
          firstName: 'Test', lastName: 'Person', familyId: managedFamily,
          peopleType: 'regular', isChild: false, badgeText: 'Production payload badge',
        }),
      });
      assert.strictEqual(productionShapeBadge.status, 200);

      const inactiveProvider = await app.request(`/api/individuals/${pcoOnly}`, {
        method: 'PUT',
        body: JSON.stringify({ firstName: 'Locally', lastName: 'Changed' }),
      });
      assert.strictEqual(inactiveProvider.status, 200);

      const rows = await Database.query(
        `SELECT id, first_name, badge_text FROM individuals WHERE id IN (?, ?) AND church_id = ? ORDER BY id`,
        [elvantoManaged, pcoOnly, churchId]
      );
      assert.strictEqual(rows.find((row) => row.id === elvantoManaged).first_name, 'Test');
      assert.strictEqual(rows.find((row) => row.id === elvantoManaged).badge_text, 'Production payload badge');
      assert.strictEqual(rows.find((row) => row.id === pcoOnly).first_name, 'Locally');
    } finally {
      await app.close();
    }
  });
});

test('family managed fields lock for an authority family link or authority-linked member but notes stay local', async () => {
  await withRouteChurchDb(async (churchId) => {
    const linkedFamily = await seedFamily(churchId, 'Externally Linked');
    const memberLinkedFamily = await seedFamily(churchId, 'Member Linked');
    const memberId = await seedIndividual(churchId);
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id = ? AND church_id = ?`,
      [memberLinkedFamily, memberId, churchId]
    );
    await linkFamily(churchId, linkedFamily, 'elvanto', 'elvanto-family');
    await linkPerson(churchId, memberId, 'elvanto', 'elvanto-member');
    await activateAuthority(churchId, 'elvanto');
    const app = await startPeopleRouteApp(churchId);
    try {
      for (const familyId of [linkedFamily, memberLinkedFamily]) {
        const renamed = await app.request(`/api/families/${familyId}`, {
          method: 'PUT',
          body: JSON.stringify({ familyName: 'Changed' }),
        });
        assert.strictEqual(renamed.status, 403);
        assert.strictEqual(renamed.body.provider, 'elvanto');
      }

      const notes = await app.request(`/api/families/${memberLinkedFamily}`, {
        method: 'PUT',
        body: JSON.stringify({ familyNotes: 'Local pastoral note' }),
      });
      assert.strictEqual(notes.status, 200);
      assert.strictEqual((await Database.query(
        `SELECT family_notes FROM families WHERE id = ? AND church_id = ?`,
        [memberLinkedFamily, churchId]
      ))[0].family_notes, 'Local pastoral note');
    } finally {
      await app.close();
    }
  });
});

test('family member moves and lifecycle actions lock for the active authority', async () => {
  await withRouteChurchDb(async (churchId) => {
    const originalFamily = await seedFamily(churchId, 'Original');
    const targetFamily = await seedFamily(churchId, 'Target');
    const individualId = await seedIndividual(churchId);
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id = ? AND church_id = ?`,
      [originalFamily, individualId, churchId]
    );
    await linkPerson(churchId, individualId, 'elvanto', 'elvanto-person');
    await activateAuthority(churchId, 'elvanto');
    const app = await startPeopleRouteApp(churchId);
    try {
      const move = await app.request(`/api/individuals/${individualId}`, {
        method: 'PUT',
        body: JSON.stringify({ familyId: targetFamily }),
      });
      assert.strictEqual(move.status, 403);

      const archive = await app.request(`/api/individuals/${individualId}`, { method: 'DELETE' });
      assert.strictEqual(archive.status, 403);
      assert.strictEqual(archive.body.action, 'archive');
    } finally {
      await app.close();
    }
  });
});

test('member moves also lock when the source or destination family is authority-managed', async () => {
  await withRouteChurchDb(async (churchId) => {
    const memberManagedFamily = await seedFamily(churchId, 'Managed by Member');
    const directlyManagedFamily = await seedFamily(churchId, 'Directly Managed');
    const localFamily = await seedFamily(churchId, 'Local');
    const managedMember = await seedIndividual(churchId);
    const unlinkedMover = await seedIndividual(churchId);
    const unlinkedOutsider = await seedIndividual(churchId);
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id IN (?, ?) AND church_id = ?`,
      [memberManagedFamily, managedMember, unlinkedMover, churchId]
    );
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id = ? AND church_id = ?`,
      [localFamily, unlinkedOutsider, churchId]
    );
    await linkPerson(churchId, managedMember, 'elvanto', 'elvanto-managed-member');
    await linkFamily(churchId, directlyManagedFamily, 'elvanto', 'elvanto-managed-family');
    await activateAuthority(churchId, 'elvanto');
    const app = await startPeopleRouteApp(churchId);
    try {
      const leaveManagedFamily = await app.request(`/api/individuals/${unlinkedMover}`, {
        method: 'PUT', body: JSON.stringify({ familyId: localFamily }),
      });
      assert.strictEqual(leaveManagedFamily.status, 403);

      const enterManagedFamily = await app.request(`/api/individuals/${unlinkedOutsider}`, {
        method: 'PUT', body: JSON.stringify({ familyId: directlyManagedFamily }),
      });
      assert.strictEqual(enterManagedFamily.status, 403);
    } finally {
      await app.close();
    }
  });
});

test('merge-individuals locks an unlinked selection inherited from its source family', async () => {
  await withRouteChurchDb(async (churchId) => {
    const directlyManagedFamily = await seedFamily(churchId, 'Direct Family');
    const siblingManagedFamily = await seedFamily(churchId, 'Sibling Family');
    const directUnlinked = await seedIndividual(churchId);
    const siblingUnlinked = await seedIndividual(churchId);
    const linkedSibling = await seedIndividual(churchId);
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id = ? AND church_id = ?`,
      [directlyManagedFamily, directUnlinked, churchId]
    );
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id IN (?, ?) AND church_id = ?`,
      [siblingManagedFamily, siblingUnlinked, linkedSibling, churchId]
    );
    await linkFamily(churchId, directlyManagedFamily, 'elvanto', 'elvanto-direct-family');
    await linkPerson(churchId, linkedSibling, 'elvanto', 'elvanto-linked-sibling');
    await activateAuthority(churchId, 'elvanto');
    const app = await startPeopleRouteApp(churchId);
    try {
      const directFamily = await app.request('/api/families/merge-individuals', {
        method: 'POST',
        body: JSON.stringify({ individualIds: [directUnlinked], familyName: 'New Direct Family' }),
      });
      assert.strictEqual(directFamily.status, 403);
      assert.strictEqual(directFamily.body.action, 'move-family-member');

      const linkedSiblingFamily = await app.request('/api/families/merge-individuals', {
        method: 'POST',
        body: JSON.stringify({ individualIds: [siblingUnlinked], familyName: 'New Sibling Family' }),
      });
      assert.strictEqual(linkedSiblingFamily.status, 403);
      assert.strictEqual(linkedSiblingFamily.body.action, 'move-family-member');
    } finally {
      await app.close();
    }
  });
});

test('legacy planning_center_id records remain locked while Planning Center is authoritative', async () => {
  await withRouteChurchDb(async (churchId) => {
    const individualId = await Database.query(
      `INSERT INTO individuals (first_name, last_name, planning_center_id, church_id)
       VALUES ('Legacy', 'Linked', 'legacy-pco', ?)`,
      [churchId]
    );
    await activateAuthority(churchId, 'planning_center');
    const app = await startPeopleRouteApp(churchId);
    try {
      const response = await app.request(`/api/individuals/${individualId.insertId}`, {
        method: 'PUT', body: JSON.stringify({ peopleType: 'local_visitor' }),
      });
      assert.strictEqual(response.status, 403);
      assert.strictEqual(response.body.provider, 'planning_center');
    } finally {
      await app.close();
    }
  });
});

test('people and family reads expose external links and the active manager', async () => {
  await withRouteChurchDb(async (churchId) => {
    const familyId = await seedFamily(churchId, 'Linked Family');
    const individualId = await seedIndividual(churchId);
    await Database.query(`UPDATE individuals SET family_id = ? WHERE id = ?`, [familyId, individualId]);
    await linkPerson(churchId, individualId, 'planning_center', 'pco-person');
    await linkPerson(churchId, individualId, 'elvanto', 'elvanto-person');
    await linkFamily(churchId, familyId, 'planning_center', 'pco-family');
    await linkFamily(churchId, familyId, 'elvanto', 'elvanto-family');
    await activateAuthority(churchId, 'elvanto');
    const app = await startPeopleRouteApp(churchId);
    try {
      const people = await app.request('/api/individuals');
      const person = people.body.people.find((candidate) => candidate.id === individualId);
      assert.deepStrictEqual(person.externalLinks, {
        planning_center: 'pco-person', elvanto: 'elvanto-person',
      });
      assert.strictEqual(person.managedBy, 'elvanto');

      const families = await app.request('/api/families');
      const family = families.body.families.find((candidate) => candidate.id === familyId);
      assert.deepStrictEqual(family.externalLinks, {
        planning_center: 'pco-family', elvanto: 'elvanto-family',
      });
      assert.strictEqual(family.managedBy, 'elvanto');
    } finally {
      await app.close();
    }
  });
});

test('family DTO inherits managedBy from a managed member without fabricating family external links', async () => {
  await withRouteChurchDb(async (churchId) => {
    const familyId = await seedFamily(churchId, 'Inherited Manager');
    const individualId = await seedIndividual(churchId);
    await Database.query(
      `UPDATE individuals SET family_id = ? WHERE id = ? AND church_id = ?`,
      [familyId, individualId, churchId]
    );
    await linkPerson(churchId, individualId, 'elvanto', 'elvanto-family-member');
    await activateAuthority(churchId, 'elvanto');
    const app = await startPeopleRouteApp(churchId);
    try {
      const response = await app.request('/api/families');
      const family = response.body.families.find((candidate) => candidate.id === familyId);
      assert.strictEqual(family.managedBy, 'elvanto');
      assert.deepStrictEqual(family.externalLinks, {});
    } finally {
      await app.close();
    }
  });
});

test('integration settings expose authority and provider-neutral Elvanto options alongside legacy PCO fields', async () => {
  await withRouteChurchDb(async (churchId) => {
    await Database.query(
      `UPDATE people_sync_settings
          SET authority_provider = 'elvanto', pending_authority_provider = 'planning_center',
              elvanto_include_contacts = 0, elvanto_align_people_type = 1
        WHERE church_id = ?`,
      [churchId]
    );
    await Database.query(
      `UPDATE church_settings
          SET planning_center_sync_enabled = 1, planning_center_track_background_checks = 1
        WHERE church_id = ?`,
      [churchId]
    );
    const app = await startPeopleRouteApp(churchId);
    try {
      const response = await app.request('/api/settings/integrations');
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(response.body, {
        authorityProvider: 'elvanto',
        pendingAuthorityProvider: 'planning_center',
        elvantoIncludeContacts: false,
        elvantoAlignPeopleType: true,
        planningCenterSyncIndicator: false,
        planningCenterSyncEnabled: true,
        planningCenterTrackBackgroundChecks: true,
      });
    } finally {
      await app.close();
    }
  });
});

test('legacy PCO settings toggle rejects activation and may disable existing PCO authority', async () => {
  await withRouteChurchDb(async (churchId) => {
    const app = await startPeopleRouteApp(churchId);
    try {
      const enabled = await app.request('/api/settings/integrations', {
        method: 'PUT', body: JSON.stringify({ planningCenterSyncIndicator: true }),
      });
      assert.strictEqual(enabled.status, 409);
      assert.strictEqual(enabled.body.code, 'AUTHORITY_REVIEW_REQUIRED');
      assert.deepStrictEqual((await Database.query(
        `SELECT pss.authority_provider, pss.pending_authority_provider, cs.planning_center_sync_indicator
           FROM people_sync_settings pss
           JOIN church_settings cs ON cs.church_id = pss.church_id
          WHERE pss.church_id = ?`,
        [churchId]
      ))[0], {
        authority_provider: 'none',
        pending_authority_provider: null,
        planning_center_sync_indicator: 0,
      });

      await activateAuthority(churchId, 'planning_center');
      await Database.query(
        `UPDATE church_settings SET planning_center_sync_indicator = 1 WHERE church_id = ?`,
        [churchId]
      );

      const disabled = await app.request('/api/settings/integrations', {
        method: 'PUT', body: JSON.stringify({ planningCenterSyncIndicator: false }),
      });
      assert.strictEqual(disabled.status, 200);
      assert.deepStrictEqual((await Database.query(
        `SELECT pss.authority_provider, pss.pending_authority_provider, cs.planning_center_sync_indicator
           FROM people_sync_settings pss
           JOIN church_settings cs ON cs.church_id = pss.church_id
          WHERE pss.church_id = ?`,
        [churchId]
      ))[0], {
        authority_provider: 'none',
        pending_authority_provider: null,
        planning_center_sync_indicator: 0,
      });
    } finally {
      await app.close();
    }
  });
});
