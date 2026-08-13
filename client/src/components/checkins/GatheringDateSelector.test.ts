import { describe, expect, it } from 'vitest';
import { getNextGatheringDate } from './GatheringDateSelector';

describe('getNextGatheringDate', () => {
  it('uses the supplied church date instead of the browser date', () => {
    expect(getNextGatheringDate({
      id: 1,
      name: 'Friday gathering',
      attendanceType: 'standard',
      dayOfWeek: 'Friday',
      isActive: true,
    }, '2026-08-14')).toEqual({ date: '2026-08-14', daysAway: 0 });
  });
});
