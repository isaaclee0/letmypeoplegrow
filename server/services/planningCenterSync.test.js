const { test } = require('node:test');
const assert = require('node:assert');
const { isDueToday } = require('./planningCenterSync');

test('isDueToday: daily is always due', () => {
  const monday = new Date('2026-07-06T02:00:00'); // a Monday
  const wednesday = new Date('2026-07-08T02:00:00');
  assert.strictEqual(isDueToday('daily', 1, monday), true);
  assert.strictEqual(isDueToday('daily', 1, wednesday), true);
});

test('isDueToday: weekly matches only the configured day', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('weekly', 1, monday), true); // 1 = Monday
  assert.strictEqual(isDueToday('weekly', 1, tuesday), false);
  assert.strictEqual(isDueToday('weekly', 2, tuesday), true); // 2 = Tuesday
});

test('isDueToday: weekly defaults to Monday when day is not a number', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('weekly', null, monday), true);
  assert.strictEqual(isDueToday('weekly', undefined, tuesday), false);
});

test('isDueToday: monthly matches only the 1st', () => {
  const first = new Date('2026-07-01T02:00:00');
  const second = new Date('2026-07-02T02:00:00');
  assert.strictEqual(isDueToday('monthly', 1, first), true);
  assert.strictEqual(isDueToday('monthly', 1, second), false);
});

test('isDueToday: unknown frequency falls back to weekly behavior', () => {
  const monday = new Date('2026-07-06T02:00:00');
  const tuesday = new Date('2026-07-07T02:00:00');
  assert.strictEqual(isDueToday('bogus', 1, monday), true);
  assert.strictEqual(isDueToday('bogus', 1, tuesday), false);
});
