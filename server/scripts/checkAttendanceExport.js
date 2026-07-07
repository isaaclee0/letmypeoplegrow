// Assertion checks for utils/attendanceExport.js.
// Run inside the server container: node scripts/checkAttendanceExport.js
const assert = require('assert');
const { buildExportTable, toCsv, toTsv, toXlsx } = require('../utils/attendanceExport');

const sessions = [
  { session_date: '2026-06-07', gathering_type_id: 1, gathering_name: 'Sunday AM' },
  { session_date: '2026-06-07', gathering_type_id: 2, gathering_name: 'Youth' },
  { session_date: '2026-06-14', gathering_type_id: 1, gathering_name: 'Sunday AM' },
];
const people = [
  { id: 5, first_name: 'Jo', last_name: 'Smith, Jr', family_name: 'Smith', people_type: 'Regular Attender', is_child: 0 },
  { id: 6, first_name: 'Amy', last_name: 'Quote"Name', family_name: '', people_type: 'Local Visitor', is_child: 1 },
];
const attendanceMap = new Map([
  ['5_2026-06-07_1', true],
  ['5_2026-06-14_1', true],
  ['6_2026-06-07_2', true],
]);

// Multi-gathering: gathering name in date headers, counts before date columns.
// Present/Absent Count are period-based here (periods default to weekly since
// these fixture sessions carry no gathering_frequency): Jo attended a
// gathering every week (Sunday AM both weeks) so Absent Count is 0, even
// though the raw Youth column is FALSE (never attended Youth, not counted
// since no attendance record exists for Jo at Youth at all).
const table = buildExportTable({ sessions, people, attendanceMap, includeGatheringInHeaders: true });
assert.deepStrictEqual(table.headers, [
  'First Name', 'Last Name', 'Family Name', 'People Type', 'Adult/Child',
  'Present Count', 'Absent Count',
  '2026-06-07 – Sunday AM', '2026-06-07 – Youth', '2026-06-14 – Sunday AM',
]);
assert.deepStrictEqual(table.rows[0], [
  'Jo', 'Smith, Jr', 'Smith', 'Regular Attender', 'Adult',
  2, 0, 'TRUE', 'FALSE', 'TRUE',
]);
assert.deepStrictEqual(table.rows[1].slice(4), ['Child', 1, 0, 'FALSE', 'TRUE', 'FALSE']);

// Single gathering: plain date headers, no gathering name anywhere
const single = buildExportTable({
  sessions: sessions.filter(s => s.gathering_type_id === 1),
  people,
  attendanceMap,
  includeGatheringInHeaders: false,
});
assert.deepStrictEqual(single.headers.slice(7), ['2026-06-07', '2026-06-14']);
assert.ok(!single.headers.some(h => h.includes('Sunday AM')));

// CSV: comma separator with RFC-4180 quoting
const csv = toCsv(table);
const csvLines = csv.split('\n');
assert.ok(csvLines[1].includes('"Smith, Jr"'), 'field with comma must be quoted');
assert.ok(csvLines[2].includes('"Quote""Name"'), 'embedded quotes must be doubled');
assert.strictEqual(csvLines[0].split(',').length, table.headers.length);

// TSV: tab separator, control characters sanitized
const tsv = toTsv(table);
tsv.split('\n').forEach(line => assert.strictEqual(line.split('\t').length, table.headers.length));

// Regression check: a person who attends every week, but always at only one
// of two selected weekly gatherings, must show Absent Count 0 — not one FALSE
// per missed gathering per week (the bug this period-based logic fixes).
const weeklySessions = [
  { session_date: '2026-06-07', gathering_type_id: 1, gathering_name: 'Sunday AM', gathering_frequency: 'weekly' },
  { session_date: '2026-06-07', gathering_type_id: 2, gathering_name: 'Sunday PM', gathering_frequency: 'weekly' },
  { session_date: '2026-06-14', gathering_type_id: 1, gathering_name: 'Sunday AM', gathering_frequency: 'weekly' },
  { session_date: '2026-06-14', gathering_type_id: 2, gathering_name: 'Sunday PM', gathering_frequency: 'weekly' },
  { session_date: '2026-06-21', gathering_type_id: 1, gathering_name: 'Sunday AM', gathering_frequency: 'weekly' },
  { session_date: '2026-06-21', gathering_type_id: 2, gathering_name: 'Sunday PM', gathering_frequency: 'weekly' },
];
const weeklyPeople = [{ id: 7, first_name: 'Sam', last_name: 'Regular', family_name: '', people_type: 'Regular Attender', is_child: 0 }];
const weeklyAttendanceMap = new Map([
  ['7_2026-06-07_1', true], ['7_2026-06-07_2', false],
  ['7_2026-06-14_1', true], ['7_2026-06-14_2', false],
  ['7_2026-06-21_1', true], ['7_2026-06-21_2', false],
]);
const weeklyTable = buildExportTable({
  sessions: weeklySessions,
  people: weeklyPeople,
  attendanceMap: weeklyAttendanceMap,
  includeGatheringInHeaders: true,
});
assert.deepStrictEqual(weeklyTable.rows[0].slice(5), [
  3, 0, 'TRUE', 'FALSE', 'TRUE', 'FALSE', 'TRUE', 'FALSE',
]);

// XLSX: produces a non-empty buffer with the xlsx magic bytes (PK zip header)
toXlsx(table).then(buffer => {
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
  assert.strictEqual(buffer.slice(0, 2).toString(), 'PK');
  console.log('ALL CHECKS PASSED');
}).catch(err => { console.error(err); process.exit(1); });
