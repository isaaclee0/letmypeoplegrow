const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateConsecutiveAbsenceStreaks } = require('./attendancePeriodStreaks');

const sessions = [
  { id: 1, session_date: '2026-07-26', frequency: 'weekly' },
  { id: 2, session_date: '2026-07-26', frequency: 'weekly' },
  { id: 3, session_date: '2026-07-19', frequency: 'weekly' },
  { id: 4, session_date: '2026-07-19', frequency: 'weekly' },
  { id: 5, session_date: '2026-07-12', frequency: 'weekly' },
  { id: 6, session_date: '2026-07-12', frequency: 'weekly' },
];

function streak(rows, sourceSessions = sessions) {
  return calculateConsecutiveAbsenceStreaks({
    sessions: sourceSessions,
    attendanceRows: rows,
    individualIds: [10],
  }).get(10);
}

test('counts two missed weekly gatherings across three Sundays as three periods', () => {
  const rows = sessions.map((s) => ({ individual_id: 10, session_id: s.id, present: 0 }));
  assert.equal(streak(rows), 3);
});

test('attendance at either gathering in the newest period resets the streak', () => {
  assert.equal(streak([{ individual_id: 10, session_id: 2, present: 1 }]), 0);
});

test('attendance at either gathering in the preceding period stops the streak at one', () => {
  assert.equal(streak([{ individual_id: 10, session_id: 4, present: 1 }]), 1);
});

test('missing attendance rows count as not present', () => {
  assert.equal(streak([]), 3);
});

test('one weekly gathering retains consecutive-session behavior', () => {
  const weekly = [
    { id: 11, session_date: '2026-07-26', frequency: 'weekly' },
    { id: 12, session_date: '2026-07-19', frequency: 'weekly' },
    { id: 13, session_date: '2026-07-12', frequency: 'weekly' },
  ];
  assert.equal(streak([{ individual_id: 10, session_id: 13, present: 1 }], weekly), 2);
});
