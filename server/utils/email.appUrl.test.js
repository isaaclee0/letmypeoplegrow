const { test } = require('node:test');
const assert = require('node:assert/strict');

// Exercise the real email renderers, replacing only the external mail transport.
const sent = [];
const brevoPath = require.resolve('@getbrevo/brevo');
const previousBrevo = require.cache[brevoPath];
require.cache[brevoPath] = { exports: { BrevoClient: class {
  transactionalEmails = { sendTransacEmail: async (payload) => {
    sent.push(payload);
    return { messageId: 'test-only' };
  } };
} } };
const { sendWeeklyReviewEmail, sendWeeklyCaregiverDigestEmail } = require('./email');
if (previousBrevo) require.cache[brevoPath] = previousBrevo;
else delete require.cache[brevoPath];

for (const [label, configuredUrl, expectedUrl] of [
  ['public default', undefined, 'https://letmypeoplegrow.app'],
  ['local development', 'http://localhost:3000', 'http://localhost:3000'],
]) {
  test(`weekly emails use ${label} in HTML and plain text`, async () => {
    const previous = { CLIENT_URL: process.env.CLIENT_URL, FRONTEND_URL: process.env.FRONTEND_URL };
    delete process.env.FRONTEND_URL;
    if (configuredUrl) process.env.CLIENT_URL = configuredUrl;
    else delete process.env.CLIENT_URL;
    sent.length = 0;
    try {
      await sendWeeklyReviewEmail('test@example.test', 'Test', {
        churchName: 'Test Church', gatherings: [],
        followUpPeople: [{ firstName: 'Test', lastName: 'Person', gatherings: ['Sunday'] }],
      }, null, { showGuidanceNudge: true });
      await sendWeeklyCaregiverDigestEmail('test@example.test', 'Test', 'Test Church', []);
      assert.equal(sent.length, 2);
      for (const email of sent) {
        assert.ok(email.htmlContent.includes(`href="${expectedUrl}/app/reports"`));
        assert.ok(email.textContent.includes(`${expectedUrl}/app/reports`));
        assert.ok(!email.htmlContent.includes('https://app.letmypeoplegrow.com.au'));
      }
      assert.ok(sent[0].htmlContent.includes(`href="${expectedUrl}/app/settings"`));
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}
