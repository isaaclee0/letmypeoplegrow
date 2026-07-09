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

test('isDueToday: monthly matches an exact mid-month day', () => {
  const the14th = new Date('2026-07-14T02:00:00');
  const the15th = new Date('2026-07-15T02:00:00');
  const the16th = new Date('2026-07-16T02:00:00');
  assert.strictEqual(isDueToday('monthly', 15, the14th), false);
  assert.strictEqual(isDueToday('monthly', 15, the15th), true);
  assert.strictEqual(isDueToday('monthly', 15, the16th), false);
});

test('isDueToday: monthly day 31 clamps to the last day of a 30-day month', () => {
  const april29 = new Date('2026-04-29T02:00:00');
  const april30 = new Date('2026-04-30T02:00:00'); // April has 30 days
  assert.strictEqual(isDueToday('monthly', 31, april29), false);
  assert.strictEqual(isDueToday('monthly', 31, april30), true);
});

test('isDueToday: monthly day 29 clamps to the 28th in a non-leap February', () => {
  const feb27 = new Date('2026-02-27T02:00:00');
  const feb28 = new Date('2026-02-28T02:00:00'); // 2026 is not a leap year
  assert.strictEqual(isDueToday('monthly', 29, feb27), false);
  assert.strictEqual(isDueToday('monthly', 29, feb28), true);
});

test('isDueToday: monthly day 29 matches exactly in a leap February', () => {
  const feb28 = new Date('2028-02-28T02:00:00');
  const feb29 = new Date('2028-02-29T02:00:00'); // 2028 is a leap year
  assert.strictEqual(isDueToday('monthly', 29, feb28), false);
  assert.strictEqual(isDueToday('monthly', 29, feb29), true);
});
