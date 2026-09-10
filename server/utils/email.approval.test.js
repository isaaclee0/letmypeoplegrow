const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

for (const [label, env, expected] of [
  ['default private admin address', {}, 'http://192.168.193.190:7777'],
  ['configured admin address', { ADMIN_PANEL_URL: 'https://admin.example.com' }, 'https://admin.example.com'],
]) {
  test(`approval notification uses ${label} in HTML and plain text`, async () => {
    const sent = [];
    const context = { module: { exports: {} }, process: { env }, console,
      require(name) {
        assert.equal(name, '@getbrevo/brevo');
        return { BrevoClient: class { transactionalEmails = { sendTransacEmail: async (payload) => { sent.push(payload); return { messageId: 'test' }; } }; } };
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'email.js'), 'utf8'), context);
    await context.module.exports.sendNewChurchApprovalEmail('Test Church', 'test_abc', 'Test Admin', 'test@example.com');
    assert.equal(sent.length, 1);
    assert.ok(sent[0].htmlContent.includes(`href="${expected}"`));
    assert.ok(sent[0].textContent.includes(expected));
    assert.equal(sent[0].htmlContent.includes('localhost:7777'), false);
  });
}
