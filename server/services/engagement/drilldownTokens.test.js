'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'engagement-drilldown-token-test-secret';

const {
  DrilldownTokenError,
  createDrilldownToken,
  readDrilldownToken,
} = require('./drilldownTokens');

const payload = {
  churchId: 'church_alpha',
  kind: 'people',
  selector: { type: 'primary_status', status: 'irregular' },
  completedWeekEnd: '2026-08-16',
  expiresAt: '2026-08-17T01:00:00.000Z',
};

test('round trips an opaque authenticated drilldown selector', () => {
  const token = createDrilldownToken(payload);

  assert.equal(token.includes('church_alpha'), false);
  assert.equal(token.includes('irregular'), false);
  assert.deepEqual(readDrilldownToken(token, {
    churchId: payload.churchId,
    kind: payload.kind,
    now: '2026-08-17T00:00:00.000Z',
  }), payload);
});

test('rejects tampering without disclosing which encrypted field failed', () => {
  const token = createDrilldownToken(payload);
  const index = Math.floor(token.length / 2);
  const replacement = token[index] === 'A' ? 'B' : 'A';
  const tampered = `${token.slice(0, index)}${replacement}${token.slice(index + 1)}`;

  assert.throws(
    () => readDrilldownToken(tampered, {
      churchId: payload.churchId,
      kind: payload.kind,
      now: '2026-08-17T00:00:00.000Z',
    }),
    (error) => error instanceof DrilldownTokenError
      && error.code === 'INVALID_DRILLDOWN_TOKEN',
  );
});

test('binds tokens to their church and drilldown kind', () => {
  const token = createDrilldownToken(payload);

  for (const expected of [
    { churchId: 'church_beta', kind: 'people' },
    { churchId: 'church_alpha', kind: 'sessions' },
  ]) {
    assert.throws(
      () => readDrilldownToken(token, {
        ...expected,
        now: '2026-08-17T00:00:00.000Z',
      }),
      (error) => error instanceof DrilldownTokenError
        && error.code === 'INVALID_DRILLDOWN_TOKEN',
    );
  }
});

test('rejects an expired token and malformed payloads', () => {
  const token = createDrilldownToken(payload);

  assert.throws(
    () => readDrilldownToken(token, {
      churchId: payload.churchId,
      kind: payload.kind,
      now: payload.expiresAt,
    }),
    (error) => error instanceof DrilldownTokenError
      && error.code === 'INVALID_DRILLDOWN_TOKEN',
  );
  assert.throws(
    () => createDrilldownToken({ ...payload, completedWeekEnd: 'not-a-date' }),
    (error) => error instanceof TypeError,
  );
});
