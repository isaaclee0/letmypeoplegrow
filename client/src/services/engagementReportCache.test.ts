import { beforeEach, describe, expect, it } from 'vitest';
import type { EngagementOverviewDto } from './api';
import {
  clearEngagementOverviewCache,
  readEngagementOverviewCache,
  writeEngagementOverviewCache,
} from './engagementReportCache';

const overview = (churchId = 'church-a', completedWeekEnd = '2026-08-16') => ({
  schemaVersion: 1,
  churchId,
  window: {
    completedWeekEnd,
    sourceStart: '2025-07-21', sourceEnd: completedWeekEnd,
    currentStart: '2025-08-18', currentEnd: completedWeekEnd,
    comparisonStart: '2025-07-21', comparisonEnd: '2026-07-19',
  },
  setup: {},
  population: {},
  primaryDistribution: {},
  movement: {},
  matrix: {},
  trend: { buckets: [] },
  visitorJourney: {},
  coverage: {},
  settings: {},
} as EngagementOverviewDto);

describe('engagement report cache', () => {
  beforeEach(() => localStorage.clear());

  it('keeps overview entries separate by church, completed week, and schema version', () => {
    writeEngagementOverviewCache(overview('church-a', '2026-08-09'));
    writeEngagementOverviewCache(overview('church-a', '2026-08-16'));
    writeEngagementOverviewCache(overview('church-b', '2026-08-16'));

    expect(readEngagementOverviewCache('church-a')?.window.completedWeekEnd).toBe('2026-08-16');
    expect(readEngagementOverviewCache('church-b')?.churchId).toBe('church-b');
    expect(Object.keys(localStorage).every((key) => key.includes(':v1:'))).toBe(true);
  });

  it('rejects malformed cached JSON and clears entries whose embedded church differs', () => {
    localStorage.setItem('engagement-overview:v1:church-a:2026-08-16', '{bad json');
    localStorage.setItem(
      'engagement-overview:v1:church-a:2026-08-09',
      JSON.stringify(overview('church-b', '2026-08-09')),
    );

    expect(readEngagementOverviewCache('church-a')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('clears only the requested church overview entries', () => {
    writeEngagementOverviewCache(overview('church-a'));
    writeEngagementOverviewCache(overview('church-b'));

    clearEngagementOverviewCache('church-a');

    expect(readEngagementOverviewCache('church-a')).toBeNull();
    expect(readEngagementOverviewCache('church-b')).not.toBeNull();
  });
});
