import { describe, expect, it } from 'vitest';
import { buildCheckInHistoryTsv } from './checkInHistoryExport';

const detail = {
  date: '2026-08-13',
  individuals: [{
    individualId: 1,
    firstName: 'Ada',
    lastName: 'Lovelace',
    familyName: 'Lovelace',
    checkins: [{ time: '2026-08-13 02:15:00', signerName: 'Grace', userName: 'Admin' }],
    checkouts: [],
  }],
};

describe('buildCheckInHistoryTsv', () => {
  it('formats SQLite UTC timestamps in the church timezone', () => {
    expect(buildCheckInHistoryTsv(detail, 'Australia/Hobart')).toContain('12:15');
  });
});
