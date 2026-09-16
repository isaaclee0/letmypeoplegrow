'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');
const email = require('../utils/email');
const sms = require('../utils/sms');
const smsLimits = require('../utils/smsRateLimit');
const logger = require('../config/logger');
logger.exceptions?.unhandle();
logger.rejections?.unhandle();

async function request(router, path, body) {
  const route = router.stack.find(layer => layer.route?.path === path).route;
  const result = { status: 200 };
  const res = {
    status(code) { result.status = code; return this; },
    json(value) { result.body = value; return this; },
    cookie() { return this; },
  };
  await route.stack.at(-1).handle({ body }, res);
  await new Promise(resolve => setImmediate(resolve));
  return result;
}

for (const environment of ['development', 'production', undefined]) {
  for (const contactType of ['email', 'sms']) {
    test(`${environment || 'unset NODE_ENV'} OTP via ${contactType} respects the development-only delivery boundary`, async t => {
      const env = {
        NODE_ENV: environment, AUTH_DEV_BYPASS: 'false', JWT_SECRET: 'dev-otp-test-secret',
        BREVO_API_KEY: 'test', CRAZYTEL_API_KEY: 'test', CRAZYTEL_FROM_NUMBER: '+61412345678',
      };
      const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      t.after(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        delete require.cache[require.resolve('./auth')];
      });
      const emailSend = t.mock.method(email, 'sendOTCEmail', async () => {});
      const approvalSend = t.mock.method(email, 'sendNewChurchApprovalEmail', async () => {});
      const smsSend = t.mock.method(sms, 'sendOTCSMS', async () => {});
      const smsGuard = t.mock.method(smsLimits, 'checkSmsSendAllowed', async () => ({ allowed: true }));
      const smsRecord = t.mock.method(smsLimits, 'recordSmsSend', async () => {});
      delete require.cache[require.resolve('./auth')];
      const router = require('./auth');

      await withTestChurchDb(async churchId => {
        const contact = contactType === 'email' ? 'otp@example.com' : '+61412345678';
        await Database.query(
          `INSERT INTO users (email, mobile_number, primary_contact_method, role, is_active, church_id)
           VALUES (?, ?, ?, 'admin', 1, ?)`,
          ['otp@example.com', '+61412345678', contactType, churchId],
        );
        const response = await request(router, '/request-code', { contact, churchId });
        assert.equal(response.status, 200);
        const [stored] = await Database.query('SELECT * FROM otc_codes');
        assert.equal(stored.contact_identifier, contact);
        assert.equal(stored.church_id, churchId);
        const dev = environment === 'development';
        assert.equal(emailSend.mock.callCount(), !dev && contactType === 'email' ? 1 : 0);
        assert.equal(smsSend.mock.callCount(), !dev && contactType === 'sms' ? 1 : 0);
        assert.equal(smsGuard.mock.callCount(), !dev && contactType === 'sms' ? 1 : 0);
        assert.equal(smsRecord.mock.callCount(), !dev && contactType === 'sms' ? 1 : 0);
        if (dev) {
          assert.equal(stored.code, '000000');
          assert.equal((await request(router, '/verify-code', { contact, churchId, code: '123456' })).status, 401);
          assert.equal((await request(router, '/verify-code', { contact, churchId, code: '000000' })).status, 200);
          assert.equal((await request(router, '/verify-code', { contact, churchId, code: '000000' })).status, 401);
          delete process.env.BREVO_API_KEY;
          delete process.env.CRAZYTEL_API_KEY;
          assert.equal((await request(router, '/request-code', { contact, churchId })).status, 200);
          await Database.query("UPDATE otc_codes SET expires_at = datetime('now', '-1 minute')");
          assert.equal((await request(router, '/verify-code', { contact, churchId, code: '000000' })).status, 401);
        } else {
          assert.match(stored.code, /^[1-9]\d{5}$/);
          assert.equal(response.body.devCode, undefined);
          assert.equal((await request(router, '/verify-code', { contact, churchId, code: '000000' })).status, 401);
        }
        if (contactType === 'email') {
          const generator = require('../utils/churchIdGenerator');
          t.mock.method(generator, 'getOrCreateChurchId', async () => churchId);
          const registered = await request(router, '/register', {
            email: 'new@example.com', firstName: 'New', lastName: 'Admin', churchName: 'Test Church',
          });
          assert.equal(registered.status, 201);
          const [registrationCode] = await Database.query("SELECT code FROM otc_codes WHERE contact_identifier = 'new@example.com'");
          if (dev) assert.equal(registrationCode.code, '000000');
          else assert.match(registrationCode.code, /^[1-9]\d{5}$/);
          assert.equal(emailSend.mock.callCount(), dev ? 0 : 2);
          assert.equal(approvalSend.mock.callCount(), dev ? 0 : 1);
        }
      });
    });
  }
}
