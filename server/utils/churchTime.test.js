'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTimeZone,
  timeZoneFromCoordinates,
  getZonedParts,
  getChurchDate,
  parseSqliteUtc,
  addDateOnly,
  daysInDateOnlyMonth,
} = require('./churchTime');

test('derives IANA zones from church coordinates', () => {
  assert.equal(timeZoneFromCoordinates(-42.8821, 147.3272), 'Australia/Hobart');
  assert.equal(timeZoneFromCoordinates(40.7128, -74.0060), 'America/New_York');
});

test('falls back to UTC for an invalid stored timezone', () => {
  assert.equal(normalizeTimeZone('Not/A_Zone'), 'UTC');
});

test('uses the church calendar date across UTC midnight', () => {
  assert.equal(getChurchDate('2026-08-13T14:30:00.000Z', 'Australia/Hobart'), '2026-08-14');
  assert.equal(getChurchDate('2026-08-13T02:30:00.000Z', 'America/Los_Angeles'), '2026-08-12');
});

test('returns DST-aware church wall-clock parts', () => {
  assert.deepEqual(getZonedParts('2026-10-03T16:30:00.000Z', 'Australia/Hobart'), {
    year: 2026, month: 10, day: 4, hour: 3, minute: 30, second: 0, weekday: 0,
  });
});

test('parses SQLite timestamps as UTC instants', () => {
  assert.equal(parseSqliteUtc('2026-08-13 02:15:00').toISOString(), '2026-08-13T02:15:00.000Z');
});

test('does date-only arithmetic without host timezone shifts', () => {
  assert.equal(addDateOnly('2026-03-31', { months: -1 }), '2026-02-28');
  assert.equal(addDateOnly('2024-02-28', { days: 1 }), '2024-02-29');
  assert.equal(daysInDateOnlyMonth('2026-02-01'), 28);
});
