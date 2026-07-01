import { describe, it, expect } from 'vitest';
import { buildAttendanceHistoryCsv, filterHistoryByGathering, AttendanceHistoryEntry } from './attendanceHistoryCsv';

describe('filterHistoryByGathering', () => {
  const history: AttendanceHistoryEntry[] = [
    { date: '2026-03-22', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: true },
    { date: '2026-03-15', gatheringId: 2, gatheringName: 'Kids Church', present: false }
  ];

  it('returns all rows when gatheringId is null', () => {
    expect(filterHistoryByGathering(history, null)).toHaveLength(2);
  });

  it('returns only rows matching the given gatheringId', () => {
    const result = filterHistoryByGathering(history, 2);
    expect(result).toHaveLength(1);
    expect(result[0].gatheringName).toBe('Kids Church');
  });

  it('returns an empty array when no rows match', () => {
    expect(filterHistoryByGathering(history, 99)).toHaveLength(0);
  });
});

describe('buildAttendanceHistoryCsv', () => {
  it('produces a header row plus one row per entry', () => {
    const csv = buildAttendanceHistoryCsv([
      { date: '2026-03-22', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: true },
      { date: '2026-03-15', gatheringId: 1, gatheringName: 'Sunday Morning Service', present: false }
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Date,Gathering,Status');
    expect(lines[1]).toBe('2026-03-22,Sunday Morning Service,Present');
    expect(lines[2]).toBe('2026-03-15,Sunday Morning Service,Absent');
  });

  it('quotes gathering names containing a comma', () => {
    const csv = buildAttendanceHistoryCsv([
      { date: '2026-03-22', gatheringId: 1, gatheringName: 'Youth, Group', present: true }
    ]);
    expect(csv.split('\n')[1]).toBe('2026-03-22,"Youth, Group",Present');
  });

  it('returns just the header for an empty list', () => {
    expect(buildAttendanceHistoryCsv([])).toBe('Date,Gathering,Status');
  });
});
