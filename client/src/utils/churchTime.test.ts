import { describe, expect, it } from 'vitest';
import {
  parseInstant, formatInstant, getChurchDate, getChurchClockMinutes,
  formatDateOnly, addDateOnly, differenceInDateOnlyDays,
} from './churchTime';

describe('churchTime', () => {
  it('parses a SQLite timestamp as UTC', () => {
    expect(parseInstant('2026-08-13 02:15:00')?.toISOString()).toBe('2026-08-13T02:15:00.000Z');
  });

  it('formats an instant in the church timezone', () => {
    expect(formatInstant('2026-08-13 02:15:00', 'Australia/Hobart', {
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }, 'en-AU')).toBe('12:15');
  });

  it('gets church today independently of UTC day', () => {
    expect(getChurchDate('Australia/Hobart', new Date('2026-08-13T14:30:00Z'))).toBe('2026-08-14');
  });

  it('gets church wall-clock minutes across DST', () => {
    expect(getChurchClockMinutes('Australia/Hobart', new Date('2026-10-03T16:30:00Z'))).toBe(210);
  });

  it('never shifts date-only values', () => {
    expect(formatDateOnly('2026-01-01', { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA')).toBe('2026-01-01');
    expect(addDateOnly('2026-01-01', { days: -1 })).toBe('2025-12-31');
    expect(differenceInDateOnlyDays('2026-01-02', '2025-12-31')).toBe(2);
  });
});
