const { test } = require('node:test');
const assert = require('node:assert');
const { localDateInTz } = require('./checkinsImport');

test('localDateInTz returns YYYY-MM-DD in the church timezone', () => {
  // 2025-02-09T09:30:00Z is Sunday morning in Sydney (+11 in Feb, DST)
  assert.strictEqual(localDateInTz('2025-02-09T09:30:00Z', 'Australia/Sydney'), '2025-02-09');
});

test('localDateInTz keeps an evening check-in on the same local day', () => {
  // 2025-02-09T12:00:00Z = 2025-02-09 23:00 in Sydney (still the 9th)
  assert.strictEqual(localDateInTz('2025-02-09T12:00:00Z', 'Australia/Sydney'), '2025-02-09');
});

test('localDateInTz rolls over correctly past local midnight', () => {
  // 2025-02-09T13:30:00Z = 2025-02-10 00:30 in Sydney (the 10th)
  assert.strictEqual(localDateInTz('2025-02-09T13:30:00Z', 'Australia/Sydney'), '2025-02-10');
});

const { normalizeCheckIns } = require('./checkinsImport');

function rawPayload() {
  // The attendance date comes from the check-in's EventPeriod.starts_at, not the
  // check_in's created_at (which can be entered days/weeks later). created_at here
  // is deliberately offset to prove it is ignored.
  return {
    data: [
      { id: 'c1', attributes: { created_at: '2025-02-20T01:00:00Z' },
        relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } }, event_period: { data: { id: 'ep1' } } } },
      // same person, same event, same day -> deduped
      { id: 'c2', attributes: { created_at: '2025-02-21T01:00:00Z' },
        relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } }, event_period: { data: { id: 'ep1' } } } },
      { id: 'c3', attributes: { created_at: '2025-02-25T01:00:00Z' },
        relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } }, event_period: { data: { id: 'ep2' } } } },
      { id: 'c4', attributes: { created_at: '2025-02-20T01:00:00Z' },
        relationships: { event: { data: { id: 'e2' } }, person: { data: { id: 'p2' } }, event_period: { data: { id: 'ep3' } } } },
    ],
    included: [
      { type: 'Event', id: 'e1', attributes: { name: 'Sunday Gathering' } },
      { type: 'Event', id: 'e2', attributes: { name: 'Kids Church' } },
      { type: 'Person', id: 'p1', attributes: { first_name: 'Sarah', last_name: 'Wierenga' } },
      { type: 'Person', id: 'p2', attributes: { first_name: 'Tim', last_name: 'Brown' } },
      { type: 'EventPeriod', id: 'ep1', attributes: { starts_at: '2025-02-09T09:30:00Z' } },
      { type: 'EventPeriod', id: 'ep2', attributes: { starts_at: '2025-02-16T09:30:00Z' } },
      { type: 'EventPeriod', id: 'ep3', attributes: { starts_at: '2025-02-09T09:30:00Z' } },
    ],
  };
}

test('normalizeCheckIns flattens, names, and dedupes person-per-event-per-date', () => {
  const out = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  assert.strictEqual(out.length, 3); // c1 & c2 collapse
  const sunday = out.find((r) => r.pcoEventId === 'e1' && r.date === '2025-02-09');
  assert.deepStrictEqual(sunday, {
    pcoEventId: 'e1', eventName: 'Sunday Gathering',
    pcoPersonId: 'p1', firstName: 'Sarah', lastName: 'Wierenga', date: '2025-02-09',
  });
});

test('normalizeCheckIns skips check-ins missing event or person', () => {
  const payload = { data: [
    { id: 'x', attributes: {},
      relationships: { event: { data: null }, person: { data: { id: 'p1' } }, event_period: { data: { id: 'ep1' } } } },
  ], included: [
    { type: 'EventPeriod', id: 'ep1', attributes: { starts_at: '2025-02-09T09:30:00Z' } },
  ] };
  assert.strictEqual(normalizeCheckIns(payload, 'Australia/Sydney').length, 0);
});

test('normalizeCheckIns skips a check-in with no event_period (no service date)', () => {
  const payload = { data: [
    { id: 'x', attributes: { created_at: '2025-02-09T09:30:00Z' },
      relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } } } },
  ], included: [] };
  assert.strictEqual(normalizeCheckIns(payload, 'Australia/Sydney').length, 0);
});

test('normalizeCheckIns skips a check-in with an unparseable starts_at', () => {
  const payload = { data: [
    { id: 'x', attributes: {},
      relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } }, event_period: { data: { id: 'ep1' } } } },
  ], included: [
    { type: 'EventPeriod', id: 'ep1', attributes: { starts_at: 'not-a-date' } },
  ] };
  assert.strictEqual(normalizeCheckIns(payload, 'Australia/Sydney').length, 0);
});

test('normalizeCheckIns dates by event_period.starts_at, not created_at', () => {
  // created_at is a week after the service; the row must be dated to the service.
  const out = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  assert.ok(out.every((r) => r.date === '2025-02-09' || r.date === '2025-02-16'));
});

test('normalizeCheckIns filters out rows whose service date is outside the range', () => {
  const out = normalizeCheckIns(rawPayload(), 'Australia/Sydney', { startDate: '2025-02-01', endDate: '2025-02-10' });
  // 2025-02-16 row is excluded; only the two 2025-02-09 rows remain.
  assert.strictEqual(out.length, 2);
  assert.ok(out.every((r) => r.date === '2025-02-09'));
});

const { suggestGatheringId } = require('./checkinsImport');

test('suggestGatheringId matches by normalized name, exact preferred over contains', () => {
  const gatherings = [
    { id: 1, name: 'Sunday Services' },
    { id: 2, name: 'Sunday AM Kids Ministries' },
  ];
  assert.strictEqual(suggestGatheringId('Sunday AM Kids Ministries!', gatherings), 2); // exact (normalized)
  assert.strictEqual(suggestGatheringId('Gems', gatherings), null); // no match
  assert.strictEqual(suggestGatheringId('Sunday', [{ id: 9, name: 'Sunday' }]), 9);
});

test('suggestGatheringId maps split slots to AM/PM gatherings by time of day', () => {
  const gatherings = [
    { id: 10, name: 'AM Sunday Gathering' },
    { id: 11, name: 'PM Sunday Gathering' },
  ];
  // Names don't directly match "Sunday Services"; time-of-day + shared word "sunday" decides.
  assert.strictEqual(suggestGatheringId('Sunday Services — 10:00', gatherings, '10:00'), 10);
  assert.strictEqual(suggestGatheringId('Sunday Services — 16:30', gatherings, '16:30'), 11);
});

// A multi-time event splits; a single-time event does not.
function splitPayload() {
  return {
    data: [
      { id: 'a1', relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p1' } }, event_period: { data: { id: 'ep1' } }, event_times: { data: [{ id: 'tAM' }] } } },
      { id: 'a2', relationships: { event: { data: { id: 'e1' } }, person: { data: { id: 'p2' } }, event_period: { data: { id: 'ep1' } }, event_times: { data: [{ id: 'tPM' }] } } },
      { id: 'b1', relationships: { event: { data: { id: 'e2' } }, person: { data: { id: 'p1' } }, event_period: { data: { id: 'ep2' } }, event_times: { data: [{ id: 'tMid' }] } } },
    ],
    included: [
      { type: 'Event', id: 'e1', attributes: { name: 'Sunday Services' } },
      { type: 'Event', id: 'e2', attributes: { name: 'Cadets' } },
      { type: 'Person', id: 'p1', attributes: { first_name: 'A', last_name: 'A' } },
      { type: 'Person', id: 'p2', attributes: { first_name: 'B', last_name: 'B' } },
      { type: 'EventPeriod', id: 'ep1', attributes: { starts_at: '2026-05-03T00:00:00Z' } },
      { type: 'EventPeriod', id: 'ep2', attributes: { starts_at: '2026-05-06T08:00:00Z' } },
      { type: 'EventTime', id: 'tAM', attributes: { hour: 10, minute: 0 } },
      { type: 'EventTime', id: 'tPM', attributes: { hour: 16, minute: 30 } },
      { type: 'EventTime', id: 'tMid', attributes: { hour: 19, minute: 0 } },
    ],
  };
}

test('normalizeCheckIns splits a 2+-time event by service time, leaves single-time events whole', () => {
  const out = normalizeCheckIns(splitPayload(), 'Australia/Sydney');
  const e1 = out.filter((r) => r.pcoEventId.startsWith('e1'));
  assert.deepStrictEqual(new Set(e1.map((r) => r.pcoEventId)), new Set(['e1@10:00', 'e1@16:30']));
  assert.ok(e1.every((r) => /Sunday Services — \d\d:\d\d/.test(r.eventName)));
  // Cadets has a single time -> not split, no composite key, no serviceTime field.
  const e2 = out.filter((r) => r.pcoEventId === 'e2');
  assert.strictEqual(e2.length, 1);
  assert.strictEqual(e2[0].eventName, 'Cadets');
  assert.strictEqual(e2[0].serviceTime, undefined);
});

const { summarizeEvents } = require('./checkinsImport');

test('summarizeEvents groups by event with counts and date span', () => {
  const normalized = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  const events = summarizeEvents(normalized);
  const e1 = events.find((e) => e.pcoEventId === 'e1');
  assert.deepStrictEqual(e1, {
    pcoEventId: 'e1', eventName: 'Sunday Gathering',
    checkinCount: 2, sessionCount: 2, firstDate: '2025-02-09', lastDate: '2025-02-16',
    suggestedSchedule: { dayOfWeek: 'Sunday', startTime: null, frequency: 'weekly', irregular: false },
  });
  const e2 = events.find((e) => e.pcoEventId === 'e2');
  assert.strictEqual(e2.checkinCount, 1);
  assert.strictEqual(e2.firstDate, '2025-02-09');
});

const { resolvePeople } = require('./checkinsImport');

test('resolvePeople matches existing (active or archived) and lists the rest to create', () => {
  const normalized = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  const existingByPcoId = new Map([
    ['p1', { id: 11, isActive: 1 }],
    // p2 not present -> must be created inactive
  ]);
  const r = resolvePeople(normalized, existingByPcoId);

  assert.deepStrictEqual(r.matched, [{ pcoPersonId: 'p1', individualId: 11 }]);
  assert.deepStrictEqual(r.toCreate, [
    { pcoPersonId: 'p2', firstName: 'Tim', lastName: 'Brown' },
  ]);
});

test('resolvePeople gives a placeholder last name when PCO name is blank', () => {
  const normalized = [{ pcoEventId: 'e', eventName: 'E', pcoPersonId: 'p9', firstName: '', lastName: '', date: '2025-01-05' }];
  const r = resolvePeople(normalized, new Map());
  assert.deepStrictEqual(r.toCreate, [{ pcoPersonId: 'p9', firstName: 'Unknown', lastName: 'Attendee' }]);
});

const { buildRecordWrites } = require('./checkinsImport');

test('buildRecordWrites maps events to gatherings and resolves individuals', () => {
  const normalized = normalizeCheckIns(rawPayload(), 'Australia/Sydney');
  const personToIndividual = new Map([['p1', 11], ['p2', 22]]);
  const eventToGathering = new Map([['e1', 100]]); // e2 NOT mapped -> skipped

  const writes = buildRecordWrites(normalized, personToIndividual, eventToGathering);

  assert.deepStrictEqual(writes.sort((a, b) => a.date.localeCompare(b.date)), [
    { gatheringTypeId: 100, date: '2025-02-09', individualId: 11 },
    { gatheringTypeId: 100, date: '2025-02-16', individualId: 11 },
  ]);
});

test('buildRecordWrites dedupes identical gathering/date/individual', () => {
  const normalized = [
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-03-02', eventName: 'S', firstName: 'A', lastName: 'B' },
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-03-02', eventName: 'S', firstName: 'A', lastName: 'B' },
  ];
  const writes = buildRecordWrites(normalized, new Map([['p1', 5]]), new Map([['e1', 9]]));
  assert.strictEqual(writes.length, 1);
});

const { buildGatheringListAdds } = require('./checkinsImport');

test('buildGatheringListAdds adds active people who attended a mapped event within the recency window', () => {
  const normalized = [
    // p1 attended recently -> include
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-05-25', eventName: 'S', firstName: 'A', lastName: 'B' },
    // p1 also long ago (still included once, via the recent row)
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2020-01-05', eventName: 'S', firstName: 'A', lastName: 'B' },
    // p2 only attended long ago -> excluded by recency
    { pcoEventId: 'e1', pcoPersonId: 'p2', date: '2020-01-05', eventName: 'S', firstName: 'C', lastName: 'D' },
    // p3 attended recently but is inactive -> excluded
    { pcoEventId: 'e1', pcoPersonId: 'p3', date: '2025-05-25', eventName: 'S', firstName: 'E', lastName: 'F' },
    // p1 recent on an UNMAPPED event -> excluded
    { pcoEventId: 'e9', pcoPersonId: 'p1', date: '2025-05-25', eventName: 'X', firstName: 'A', lastName: 'B' },
  ];
  const personToIndividual = new Map([['p1', 11], ['p2', 22], ['p3', 33]]);
  const eventToGathering = new Map([['e1', 100]]); // e9 unmapped
  const activeIndividualIds = new Set([11, 22]); // 33 inactive
  const adds = buildGatheringListAdds(
    normalized, activeIndividualIds, personToIndividual, eventToGathering, 8, '2025-06-04'
  );
  assert.deepStrictEqual(adds, [{ gatheringTypeId: 100, individualId: 11 }]);
});

test('buildGatheringListAdds dedupes multiple recent check-ins for the same person/gathering', () => {
  const normalized = [
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-05-25', eventName: 'S', firstName: 'A', lastName: 'B' },
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-06-01', eventName: 'S', firstName: 'A', lastName: 'B' },
  ];
  const adds = buildGatheringListAdds(
    normalized, new Set([11]), new Map([['p1', 11]]), new Map([['e1', 100]]), 8, '2025-06-04'
  );
  assert.strictEqual(adds.length, 1);
});

test('buildGatheringListAdds includes a check-in exactly on the cutoff date', () => {
  // recencyWeeks 8 -> 56 days before 2025-06-04 is 2025-04-09
  const normalized = [
    { pcoEventId: 'e1', pcoPersonId: 'p1', date: '2025-04-09', eventName: 'S', firstName: 'A', lastName: 'B' },
  ];
  const adds = buildGatheringListAdds(
    normalized, new Set([11]), new Map([['p1', 11]]), new Map([['e1', 100]]), 8, '2025-06-04'
  );
  assert.deepStrictEqual(adds, [{ gatheringTypeId: 100, individualId: 11 }]);
});

test('buildGatheringListAdds skips check-ins whose person did not resolve to an individual', () => {
  const normalized = [
    { pcoEventId: 'e1', pcoPersonId: 'pX', date: '2025-05-25', eventName: 'S', firstName: 'A', lastName: 'B' },
  ];
  const adds = buildGatheringListAdds(
    normalized, new Set([11]), new Map(), new Map([['e1', 100]]), 8, '2025-06-04'
  );
  assert.deepStrictEqual(adds, []);
});

test('buildGatheringListAdds returns empty for empty input', () => {
  assert.deepStrictEqual(
    buildGatheringListAdds([], new Set(), new Map(), new Map(), 8, '2025-06-04'),
    []
  );
});

// ── Task 1: deriveSchedule ────────────────────────────────────────────────────

const { deriveSchedule } = require('./checkinsImport');

// Helper: build N consecutive weekly Sundays starting 2025-01-05 (a Sunday).
function weeklySundays(n) {
  const out = [];
  const d = new Date('2025-01-05T00:00:00Z');
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

test('deriveSchedule detects a weekly Sunday service', () => {
  const s = deriveSchedule(weeklySundays(6), '10:00');
  assert.deepStrictEqual(s, { dayOfWeek: 'Sunday', startTime: '10:00', frequency: 'weekly', irregular: false });
});

test('deriveSchedule detects biweekly', () => {
  const dates = ['2025-01-05', '2025-01-19', '2025-02-02', '2025-02-16'];
  const s = deriveSchedule(dates, null);
  assert.strictEqual(s.frequency, 'biweekly');
  assert.strictEqual(s.dayOfWeek, 'Sunday');
  assert.strictEqual(s.irregular, false);
});

test('deriveSchedule detects monthly', () => {
  const dates = ['2025-01-05', '2025-02-02', '2025-03-02', '2025-03-30'];
  const s = deriveSchedule(dates, null);
  assert.strictEqual(s.frequency, 'monthly');
  assert.strictEqual(s.irregular, false);
});

test('deriveSchedule flags annual/irregular (Good Friday-style) as irregular with blank schedule', () => {
  const dates = ['2023-04-07', '2024-03-29', '2025-04-18'];
  const s = deriveSchedule(dates, null);
  assert.strictEqual(s.irregular, true);
  assert.strictEqual(s.dayOfWeek, null);
  assert.strictEqual(s.frequency, null);
});

test('deriveSchedule flags a single occurrence as irregular but keeps startTime', () => {
  const s = deriveSchedule(['2025-06-01'], '09:30');
  assert.deepStrictEqual(s, { dayOfWeek: null, startTime: '09:30', frequency: null, irregular: true });
});

test('deriveSchedule flags inconsistent weekday as irregular', () => {
  const dates = ['2025-01-06', '2025-01-14', '2025-01-20', '2025-01-29']; // Mon, Tue, Mon, Wed
  const s = deriveSchedule(dates, null);
  assert.strictEqual(s.irregular, true);
});

// ── Task 2: summarizeEvents attaches suggestedSchedule ────────────────────────

test('summarizeEvents attaches a suggestedSchedule per event', () => {
  const normalized = [
    { pcoEventId: 'e1', eventName: 'Sunday', pcoPersonId: 'p1', firstName: 'A', lastName: 'B', date: '2025-01-05' },
    { pcoEventId: 'e1', eventName: 'Sunday', pcoPersonId: 'p2', firstName: 'C', lastName: 'D', date: '2025-01-12' },
    { pcoEventId: 'e1', eventName: 'Sunday', pcoPersonId: 'p1', firstName: 'A', lastName: 'B', date: '2025-01-19' },
  ];
  const [e] = summarizeEvents(normalized);
  assert.deepStrictEqual(e.suggestedSchedule, {
    dayOfWeek: 'Sunday', startTime: null, frequency: 'weekly', irregular: false,
  });
});

// ── Task 3: mergeCheckinImportState ───────────────────────────────────────────

const { mergeCheckinImportState } = require('./checkinsImport');

test('mergeCheckinImportState merges into null prev', () => {
  const next = mergeCheckinImportState(null, {
    lastRange: { startDate: '2025-01-01', endDate: '2025-02-01' },
    mappings: { e1: { target: 'new', newGatheringName: 'Sunday' } },
    imported: { e1: { lastImportedDate: '2025-01-26', gatheringTypeId: 7 } },
  });
  assert.deepStrictEqual(next, {
    lastRange: { startDate: '2025-01-01', endDate: '2025-02-01' },
    mappings: { e1: { target: 'new', newGatheringName: 'Sunday' } },
    imported: { e1: { lastImportedDate: '2025-01-26', gatheringTypeId: 7 } },
  });
});

test('mergeCheckinImportState preserves prior events and overlays new ones', () => {
  const prev = {
    lastRange: { startDate: '2024-01-01', endDate: '2024-06-01' },
    mappings: { e1: { target: 'existing', gatheringTypeId: 1 } },
    imported: { e1: { lastImportedDate: '2024-05-26', gatheringTypeId: 1 } },
  };
  const next = mergeCheckinImportState(prev, {
    lastRange: { startDate: '2025-01-01', endDate: '2025-02-01' },
    mappings: { e2: { target: 'new', newGatheringName: 'Friday' } },
    imported: { e2: { lastImportedDate: '2025-01-31', gatheringTypeId: 9 } },
  });
  assert.strictEqual(next.lastRange.startDate, '2025-01-01');
  assert.ok(next.mappings.e1, 'keeps e1 mapping');
  assert.ok(next.mappings.e2, 'adds e2 mapping');
  assert.strictEqual(next.imported.e1.lastImportedDate, '2024-05-26');
  assert.strictEqual(next.imported.e2.gatheringTypeId, 9);
});
