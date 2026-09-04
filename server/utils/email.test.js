const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEmailData } = require('./email');

test('transactional email accepts a no-reply sender override and preserves reply-to', () => {
  const previousFrom = process.env.EMAIL_FROM;
  delete process.env.EMAIL_FROM;
  try {
    const email = createEmailData(
      'recipient@example.test',
      'Subject',
      '<p>Hello</p>',
      'Hello',
      {
        fromEmail: 'no-reply@letmypeoplegrow.app',
        replyTo: 'main-admin@example.test',
      },
    );

    assert.equal(email.sender.email, 'no-reply@letmypeoplegrow.app');
    assert.deepEqual(email.replyTo, { email: 'main-admin@example.test' });
  } finally {
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});
