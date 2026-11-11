const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('../config/database');
const organisationReferrals = require('../services/organisationReferrals');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

test('the internal admin endpoint shows referral attribution and the approved organisation', async () => {
  await withTestChurchDb(async churchId => {
    Database.ensureChurch(churchId, 'Sending Church');
    Database.approveChurch(churchId, true);
    const { insertId } = await Database.queryForChurch(churchId,
      "INSERT INTO users (role, is_active, church_id) VALUES ('admin', 1, ?)", [churchId]);
    const referral = organisationReferrals.reserve('new@example.com', {
      church_id: churchId, id: insertId, first_name: 'Test', last_name: 'Admin',
    });
    organisationReferrals.recordDelivery(referral, churchId, true);
    let handler;
    const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const start = source.indexOf("app.get('/api/referrals'");
    const end = source.indexOf('\n});', start) + 4;
    vm.runInNewContext(source.slice(start, end), {
      app: { get(_url, callback) { handler = callback; } }, organisationReferrals,
    });
    let response;
    handler({}, { json(data) { response = data; } });
    assert.equal(response.referrals[0].status, 'pre_approved');
    assert.equal(response.referrals[0].referring_church_name, 'Sending Church');
    assert.equal(response.referrals[0].referrer_name, 'Test Admin');
    const newChurchId = `${churchId}_referred`;
    Database.ensureChurch(newChurchId, 'Referred Church');
    Database.getRegistryDb().transaction(() => organisationReferrals.redeem('new@example.com', newChurchId))();
    handler({}, { json(data) { response = data; } });
    assert.equal(response.referrals[0].status, 'registered');
    assert.equal(response.referrals[0].registered_church_name, 'Referred Church');
    assert.equal(Database.isChurchApproved(newChurchId), true);
  });
});

test('the admin referral table renders states and escapes sender details', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const container = {};
  const context = {
    document: {
      getElementById: () => container,
      createElement: () => ({
        set textContent(value) {
          this.innerHTML = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
      }),
    },
    fetchJSON: async () => ({ referrals: [{
      email: 'new@example.com', referrer_name: '<img src=x>', referring_church_name: 'Grace & Hope',
      status: 'pre_approved', expires_at: '2026-12-11 00:00:00', delivery_failed: 1,
    }] }),
  };
  vm.createContext(context);
  for (const name of ['escapeHtml', 'loadReferrals']) {
    const match = new RegExp(`    (?:async )?function ${name}\\(`).exec(source);
    const end = source.indexOf('\n    }', match.index) + 6;
    vm.runInContext(source.slice(match.index, end), context);
  }
  await context.loadReferrals();
  assert.match(container.innerHTML, /Pre-approved/);
  assert.match(container.innerHTML, /Latest resend failed/);
  assert.match(container.innerHTML, /Grace &amp; Hope/);
  assert.equal(container.innerHTML.includes('<img'), false);
});
