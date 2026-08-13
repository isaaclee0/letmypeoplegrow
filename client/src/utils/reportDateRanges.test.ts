import { describe, expect, it } from 'vitest';
import { reportDateRange } from './reportDateRanges';

describe('reportDateRange', () => {
  it('uses date-only arithmetic across a year boundary', () => {
    expect(reportDateRange('last-4-weeks', '2026-01-02')).toEqual({ start: '2025-12-05', end: '2026-01-02' });
    expect(reportDateRange('year-to-date', '2026-01-02')).toEqual({ start: '2026-01-01', end: '2026-01-02' });
  });
});
