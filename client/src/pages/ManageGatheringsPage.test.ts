import { describe, expect, it } from 'vitest';
import { generateGatheringOccurrences } from './ManageGatheringsPage';

describe('generateGatheringOccurrences', () => {
  it('keeps custom recurring dates as date-only values west of UTC', () => {
    const occurrences = generateGatheringOccurrences({
      id: 1,
      name: 'Kids',
      description: '',
      attendanceType: 'headcount',
      isActive: true,
      customSchedule: {
        type: 'recurring',
        startDate: '2026-01-01',
        pattern: { frequency: 'weekly', interval: 1, daysOfWeek: ['Sunday'] },
      },
    }, '2026-01-02');

    expect(occurrences[0]?.date).toBe('2026-01-04');
  });

  it('does not roll a monthly day-of-month into the following month', () => {
    const occurrences = generateGatheringOccurrences({
      id: 1,
      name: 'Month end',
      description: '',
      attendanceType: 'headcount',
      isActive: true,
      customSchedule: {
        type: 'recurring',
        startDate: '2026-01-01',
        pattern: { frequency: 'monthly', interval: 1, dayOfMonth: 31 },
      },
    }, '2026-01-01');

    expect(occurrences.map(({ date }) => date)).toEqual(['2026-01-31', '2026-03-31']);
  });
});
