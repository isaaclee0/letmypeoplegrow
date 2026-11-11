'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const Database = require('../config/database');
const logger = require('../config/logger');
const email = require('../utils/email');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

logger.exceptions?.unhandle();
logger.rejections?.unhandle();
process.env.JWT_SECRET = 'referral-test-secret';
email.sendOTCEmail = async () => {};
let approvalNotices = 0;
email.sendNewChurchApprovalEmail = async () => { approvalNotices++; };
const authRouter = require('./auth');

async function withApp(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const request = async (path, { token, body, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
      ...(body && { body: JSON.stringify(body) }),
    });
    const result = { status: response.status, body: await response.json().catch(() => null) };
    await new Promise(resolve => setImmediate(resolve));
    return result;
  };
  try { await run(request); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function admin(churchId, { approved = true, role = 'admin', active = 1 } = {}) {
  Database.ensureChurch(churchId, 'Referring Church');
  Database.approveChurch(churchId, approved);
  const result = await Database.queryForChurch(churchId,
    `INSERT INTO users (email, first_name, last_name, role, is_active, church_id)
     VALUES (?, 'Referring', 'Admin', ?, ?, ?)`, [`${role}${active}@example.com`, role, active, churchId]);
  return jwt.sign({ userId: result.insertId, churchId }, process.env.JWT_SECRET);
}

function register(request, address, extra = {}) {
  return request('/register', { body: {
    email: address, firstName: 'New', lastName: 'Admin', churchName: 'Referred Organisation', ...extra,
  } });
}

test('only active admins of approved churches can send referrals', async () => {
  await withTestChurchDb(churchId => withApp(async request => {
    assert.equal((await request('/referrals', { body: { email: 'new@example.com' } })).status, 401);
    for (const options of [{ role: 'coordinator' }, { role: 'attendance_taker' }, { active: 0 }, { approved: false }]) {
      const token = await admin(churchId, options);
      const result = await request('/referrals', { token, body: { email: 'new@example.com' } });
      assert.equal(result.status, options.active === 0 ? 401 : 403);
    }
  }));
});

test('a delivered referral pre-approves only the matching email and still requires login verification', async t => {
  const deliveries = [];
  t.mock.method(email, 'sendReferralEmail', async (...args) => { deliveries.push(args); });
  await withTestChurchDb(churchId => withApp(async request => {
    const token = await admin(churchId);
    const sent = await request('/referrals', { token, body: { email: '  New@Example.com ', churchId: 'forged' } });
    assert.equal(sent.status, 201);
    assert.equal(deliveries[0][0], 'new@example.com');
    assert.match(deliveries[0][1], /\/signup\?email=new%40example.com$/);
    assert.equal(Database.lookupChurchByEmail('new@example.com'), null);
    const before = await request('/referrals', { token });
    assert.equal(before.body.referrals[0].status, 'pre_approved');

    assert.equal((await register(request, 'other@example.com', { preApproved: true })).status, 201);
    assert.equal(Database.isChurchApproved(Database.lookupChurchByEmail('other@example.com').church_id), false);
    approvalNotices = 0;
    assert.equal((await register(request, 'NEW@example.com')).status, 201);
    const target = Database.lookupChurchByEmail('new@example.com');
    assert.notEqual(target.church_id, churchId);
    assert.equal(Database.isChurchApproved(target.church_id), true);
    assert.equal(approvalNotices, 0);
    const [user] = await Database.queryForChurch(target.church_id, 'SELECT first_login_completed FROM users WHERE church_id = ?', [target.church_id]);
    assert.equal(user.first_login_completed, 0);
    assert.equal((await request('/me')).status, 401);
    assert.equal((await request('/referrals', { token })).body.referrals[0].status, 'registered');
    assert.equal((await register(request, 'new@example.com')).status, 409);

    const otherToken = await admin(`${churchId}_other`);
    assert.deepEqual((await request('/referrals', { token: otherToken })).body.referrals, []);
  }));
});

test('invalid addresses and existing accounts cannot be referred; repeated sends are throttled', async t => {
  t.mock.method(email, 'sendReferralEmail', async () => {});
  await withTestChurchDb(churchId => withApp(async request => {
    const token = await admin(churchId);
    assert.equal((await request('/referrals', { token, body: { email: 'invalid' } })).status, 400);
    await register(request, 'existing@example.com');
    assert.equal((await request('/referrals', { token, body: { email: 'EXISTING@example.com' } })).status, 409);
    assert.equal((await request('/referrals', { token, body: { email: 'new@example.com' } })).status, 201);
    assert.equal((await request('/referrals', { token, body: { email: 'new@example.com' } })).status, 429);
  }));
});

test('mail failure is visible and does not grant approval', async t => {
  t.mock.method(email, 'sendReferralEmail', async () => { throw new Error('Provider unavailable'); });
  await withTestChurchDb(churchId => withApp(async request => {
    const token = await admin(churchId);
    assert.equal((await request('/referrals', { token, body: { email: 'new@example.com' } })).status, 502);
    assert.equal((await request('/referrals', { token })).body.referrals[0].status, 'failed');
    assert.equal((await register(request, 'new@example.com')).status, 201);
    assert.equal(Database.isChurchApproved(Database.lookupChurchByEmail('new@example.com').church_id), false);
  }));
});

test('expired referrals or referrals from a revoked organisation do not approve a signup', async t => {
  t.mock.method(email, 'sendReferralEmail', async () => {});
  for (const reason of ['expired', 'revoked', 'demoted']) {
    await withTestChurchDb(churchId => withApp(async request => {
      const token = await admin(churchId);
      await request('/referrals', { token, body: { email: 'new@example.com' } });
      if (reason === 'expired') Database.getRegistryDb().prepare("UPDATE organisation_referrals SET expires_at = datetime('now', '-1 day')").run();
      if (reason === 'revoked') Database.approveChurch(churchId, false);
      if (reason === 'demoted') await Database.queryForChurch(churchId, "UPDATE users SET role = 'coordinator' WHERE church_id = ?", [churchId]);
      assert.equal((await register(request, 'new@example.com')).status, 201);
      assert.equal(Database.isChurchApproved(Database.lookupChurchByEmail('new@example.com').church_id), false, reason);
    }));
  }
});

test('concurrent requests reserve a recipient before delivery and failed sends can be retried', async t => {
  let finishDelivery;
  let startedDelivery;
  const started = new Promise(resolve => { startedDelivery = resolve; });
  t.mock.method(email, 'sendReferralEmail', () => {
    startedDelivery();
    return new Promise(resolve => { finishDelivery = resolve; });
  });
  await withTestChurchDb(churchId => withApp(async request => {
    const token = await admin(churchId);
    const first = request('/referrals', { token, body: { email: 'new@example.com' } });
    await started;
    const second = await request('/referrals', { token, body: { email: 'NEW@example.com' } });
    finishDelivery();
    assert.equal(second.status, 429);
    assert.equal((await first).status, 201);

    t.mock.method(email, 'sendReferralEmail', async () => { throw new Error('Unavailable'); });
    Database.getRegistryDb().prepare("UPDATE organisation_referrals SET last_attempt_at = datetime('now', '-2 minutes')").run();
    assert.equal((await request('/referrals', { token, body: { email: 'new@example.com' } })).status, 502);
    const listing = await request('/referrals', { token });
    assert.equal(listing.body.referrals.length, 1);
    assert.equal(listing.body.referrals[0].status, 'pre_approved');
    assert.equal(listing.body.referrals[0].delivery_failed, 1);
    await register(request, 'new@example.com');
    assert.equal(Database.isChurchApproved(Database.lookupChurchByEmail('new@example.com').church_id), true);
  }));
});

test('a failed initial send can be retried successfully without duplicate referral rows', async t => {
  t.mock.method(email, 'sendReferralEmail', async () => { throw new Error('Unavailable'); });
  await withTestChurchDb(churchId => withApp(async request => {
    const token = await admin(churchId);
    assert.equal((await request('/referrals', { token, body: { email: 'new@example.com' } })).status, 502);
    Database.getRegistryDb().prepare("UPDATE organisation_referrals SET last_attempt_at = datetime('now', '-2 minutes')").run();
    t.mock.method(email, 'sendReferralEmail', async () => {});
    assert.equal((await request('/referrals', { token, body: { email: 'new@example.com' } })).status, 201);
    const { referrals } = (await request('/referrals', { token })).body;
    assert.equal(referrals.length, 1);
    assert.equal(referrals[0].status, 'pre_approved');
    await register(request, 'new@example.com');
    assert.equal(Database.isChurchApproved(Database.lookupChurchByEmail('new@example.com').church_id), true);
  }));
});

test('the send limit applies across admins of the same church', async t => {
  t.mock.method(email, 'sendReferralEmail', async () => {});
  await withTestChurchDb(churchId => withApp(async request => {
    const token = await admin(churchId);
    for (let i = 0; i < 10; i++) {
      assert.equal((await request('/referrals', { token, body: { email: `person${i}@example.com` } })).status, 201);
    }
    const { insertId } = await Database.queryForChurch(churchId,
      "INSERT INTO users (email, role, is_active, church_id) VALUES ('another@example.com', 'admin', 1, ?)", [churchId]);
    const anotherAdmin = jwt.sign({ userId: insertId, churchId }, process.env.JWT_SECRET);
    assert.equal((await request('/referrals', { token: anotherAdmin, body: { email: 'extra@example.com' } })).status, 429);
  }));
});

test('removing the referring church removes its referral data and cannot approve signups', async t => {
  t.mock.method(email, 'sendReferralEmail', async () => {});
  await withTestChurchDb(churchId => withApp(async request => {
    const token = await admin(churchId);
    await request('/referrals', { token, body: { email: 'new@example.com' } });
    Database.getRegistryDb().prepare('DELETE FROM churches WHERE church_id = ?').run(churchId);
    assert.equal(Database.getRegistryDb().prepare('SELECT COUNT(*) AS count FROM organisation_referrals WHERE church_id = ?').get(churchId).count, 0);
    await register(request, 'new@example.com');
    assert.equal(Database.isChurchApproved(Database.lookupChurchByEmail('new@example.com').church_id), false);
  }));
});
