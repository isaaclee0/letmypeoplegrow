const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getWeeklyReviewWindow } = require('./weeklyReview');

test('weekly review range end date uses the church timezone', () => {
  const window = getWeeklyReviewWindow(new Date('2026-08-13T14:30:00Z'), 'Australia/Hobart');
  assert.deepEqual(window, { startDate: '2026-08-07', endDate: '2026-08-14' });
});
