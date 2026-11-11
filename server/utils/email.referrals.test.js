const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('referral email contains the signup link in HTML and text and escapes referrer details', async () => {
  const sent = [];
  const context = { module: { exports: {} }, process: { env: {} }, console,
    require(name) {
      if (name !== '@getbrevo/brevo') return require(name);
      return { BrevoClient: class { transactionalEmails = { sendTransacEmail: async payload => { sent.push(payload); return { messageId: 'test' }; } }; } };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'email.js'), 'utf8'), context);
  const url = 'https://letmypeoplegrow.app/signup?email=new%2Bchurch%40example.com';
  await context.module.exports.sendReferralEmail('new+church@example.com', url, {
    name: '<img src=x onerror=alert(1)>', churchName: 'Grace & Hope',
  });
  const payload = sent[0];
  assert.equal(payload.to[0].email, 'new+church@example.com');
  assert.ok(payload.htmlContent.includes(`href="${url}"`));
  assert.ok(payload.textContent.includes(url));
  assert.ok(payload.htmlContent.includes('&lt;img'));
  assert.ok(payload.htmlContent.includes('Grace &amp; Hope'));
  assert.equal(payload.htmlContent.includes('<img'), false);
  assert.match(payload.textContent, /verify your email with a one-time code/);
  assert.match(payload.textContent, /own organisation/);
});
