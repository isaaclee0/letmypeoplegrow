const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getLocalHour, getLocalDayName, getLocalDateString } = require('./weeklyReviewScheduler');

test('weekly review send day and hour use the church timezone', () => {
  const now = new Date('2026-08-13T21:15:00Z'); // Friday 7:15am Hobart
  assert.equal(getLocalHour('Australia/Hobart', now), 7);
  assert.equal(getLocalDayName('Australia/Hobart', now), 'Friday');
  assert.equal(getLocalDateString('Australia/Hobart', now), '2026-08-14');
});
