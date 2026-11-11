const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAppUrl } = require('./appUrl');

const request = (headers, protocol = 'http') => ({ headers, protocol });

test('public links default to letmypeoplegrow.app', () => {
  assert.equal(getAppUrl(undefined, {}), 'https://letmypeoplegrow.app');
});

for (const host of ['letmypeoplegrow.app', 'app.letmypeoplegrow.com.au']) {
  test(`request links preserve ${host} over the configured default`, () => {
    assert.equal(getAppUrl(request({ host }), { CLIENT_URL: 'https://other.example' }), `https://${host}`);
    assert.equal(getAppUrl(request({ 'x-forwarded-host': `${host}, internal:3001`, host: 'internal:3001' }), {}), `https://${host}`);
    assert.equal(getAppUrl(request({ origin: `https://${host}`, host: 'internal:3001' }), {}), `https://${host}`);
  });
}

test('background links respect explicit deployment configuration', () => {
  assert.equal(getAppUrl(undefined, { CLIENT_URL: 'http://localhost:3000/' }), 'http://localhost:3000');
  assert.equal(getAppUrl(undefined, { FRONTEND_URL: 'https://custom.example/' }), 'https://custom.example');
  assert.equal(getAppUrl(undefined, { CLIENT_URL: 'https://primary.example', FRONTEND_URL: 'https://fallback.example' }), 'https://primary.example');
});

test('local request links use the browser frontend origin instead of the API port', () => {
  assert.equal(getAppUrl(request({ origin: 'http://localhost:3000', host: 'localhost:3001' }), { NODE_ENV: 'development' }), 'http://localhost:3000');
  assert.equal(getAppUrl(request({ host: 'localhost:8080' }), { NODE_ENV: 'development' }), 'http://localhost:8080');
  assert.equal(getAppUrl(request({ host: '[::1]:3000' }), { NODE_ENV: 'development' }), 'http://[::1]:3000');
});

test('request headers cannot introduce arbitrary or malformed email link origins', () => {
  for (const host of ['attacker.example', 'letmypeoplegrow.app.attacker.example', 'letmypeoplegrow.app@attacker.example', 'letmypeoplegrow.app/path', 'letmypeoplegrow.app:444', 'localhost:3000']) {
    assert.equal(getAppUrl(request({ host, origin: `https://${host}` }), { NODE_ENV: 'production' }), 'https://letmypeoplegrow.app', host);
  }
  assert.equal(getAppUrl(request({ origin: 'https://attacker.example', host: 'app.letmypeoplegrow.com.au' }), {}), 'https://app.letmypeoplegrow.com.au');
  assert.equal(getAppUrl(request({ host: 'attacker.example' }), { CLIENT_URL: 'https://custom.example' }), 'https://custom.example');
});

test('invalid configured URLs fall back to the public default', () => {
  for (const value of ['not a URL', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/?next=bad']) {
    assert.equal(getAppUrl(undefined, { CLIENT_URL: value }), 'https://letmypeoplegrow.app');
  }
});
