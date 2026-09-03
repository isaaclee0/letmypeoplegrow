import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextualLongTermOverviewDto } from './api';
import {
  clearLongTermTrendsCache,
  readLongTermTrendsCache,
  writeLongTermTrendsCache,
} from './engagementReportCache';

const contextualOverview = ({
  churchId = 'church-a',
  gatheringTypeIds = [1, 2],
  completedWeekEnd = '2026-08-30',
}: Partial<ContextualLongTermOverviewDto> = {}): ContextualLongTermOverviewDto => ({
  schemaVersion: 4,
  churchId,
  gatheringTypeIds,
  window: {
    completedWeekEnd,
    startDate: '2025-09-01',
    endDate: completedWeekEnd,
    maximumWeeks: 52,
  },
  settings: {
    coreMinimum: 60,
    casualMinimum: 20,
    tiers: {
      core: { label: 'Core', colour: '#16A34A' },
      casual: { label: 'Casual', colour: '#D97706' },
      irregular: { label: 'Irregular', colour: '#DC2626' },
    },
    calculationRulesVersion: 1,
  },
  dataAvailability: {
    availableWeeks: 31,
    firstSessionDate: '2026-02-08',
    lastSessionDate: '2026-08-23',
    validOpportunityWeeks: 29,
    excludedWeeks: 2,
    unclassifiedBecauseNoEvidence: 1,
    standardGatherings: 1,
    headcountGatherings: 1,
  },
  direction: {
    comparisonWeeks: 12,
    previousAverage: 42,
    recentAverage: 38,
    percentChange: -9.5,
    status: 'down',
    series: gatheringTypeIds.map((gatheringTypeId) => ({
      gatheringTypeId,
      name: `Gathering ${gatheringTypeId}`,
      attendanceType: 'standard' as const,
      buckets: Array.from({ length: 13 }, (_, index) => ({
        index,
        startDate: '2025-09-01',
        endDate: '2025-09-28',
        heldSessions: 4,
        averageAttendance: 42,
        sessionsToken: 'sessions-token',
      })),
    })),
  },
  regularity: {
    population: 10,
    tiers: [{
      tier: 'core', label: 'Core', colour: '#16A34A', count: 8, rate: 80, peopleToken: 'core-token',
    }, {
      tier: 'casual', label: 'Casual', colour: '#D97706', count: 1, rate: 10, peopleToken: 'casual-token',
    }, {
      tier: 'irregular', label: 'Irregular', colour: '#DC2626', count: 1, rate: 10, peopleToken: 'irregular-token',
    }],
  },
  declines: {
    total: 1,
    rows: [{
      individualId: 9,
      firstName: 'Ada',
      lastName: 'Lovelace',
      baseline: { attendedWeeks: 8, opportunityWeeks: 8, rate: 100 },
      recent: { attendedWeeks: 1, opportunityWeeks: 4, rate: 25 },
      summary: 'Usually attends 1 week in 1; attended 1 of the last 4 weeks.',
    }],
    peopleToken: 'decline-token',
  },
});

describe('contextual long-term trends cache', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('shares a cache entry only with the same canonical gathering selection and church', () => {
    writeLongTermTrendsCache(contextualOverview({ churchId: 'church-a', gatheringTypeIds: [2, 1] }));

    expect(readLongTermTrendsCache('church-a', [1, 2])).not.toBeNull();
    expect(readLongTermTrendsCache('church-a', [1])).toBeNull();
    expect(readLongTermTrendsCache('church-b', [1, 2])).toBeNull();
  });

  it('rejects malformed schema-v4 entries and removes only the corrupt selection entry', () => {
    const corruptions: Array<(candidate: any) => void> = [
      (candidate) => { candidate.gatheringTypeIds = [2, 1]; },
      (candidate) => { candidate.window.completedWeekEnd = '2026-02-30'; },
      (candidate) => { candidate.schemaVersion = 3; },
      (candidate) => { candidate.direction.status = 'declining'; },
      (candidate) => { candidate.regularity.tiers[0].peopleToken = null; },
      (candidate) => { delete candidate.declines.rows[0].baseline.opportunityWeeks; },
      (candidate) => { candidate.dataAvailability.headcountGatherings = 'one'; },
      (candidate) => { candidate.regularity = null; candidate.declines = {}; },
    ];

    for (const corrupt of corruptions) {
      localStorage.clear();
      const candidate = structuredClone(contextualOverview());
      corrupt(candidate);
      localStorage.setItem('long-term-trends:v4:church-a:1,2:2026-08-30', JSON.stringify(candidate));

      expect(readLongTermTrendsCache('church-a', [1, 2])).toBeNull();
      expect(localStorage.length).toBe(0);
    }
  });

  it('allows headcount-only data only when regularity and declines are both unavailable', () => {
    const headcountOnly = contextualOverview({ gatheringTypeIds: [3] });
    headcountOnly.dataAvailability = {
      ...headcountOnly.dataAvailability,
      standardGatherings: 0,
      headcountGatherings: 1,
    };
    headcountOnly.regularity = null;
    headcountOnly.declines = null;

    writeLongTermTrendsCache(headcountOnly);
    expect(readLongTermTrendsCache('church-a', [3])).not.toBeNull();

    headcountOnly.regularity = contextualOverview().regularity;
    clearLongTermTrendsCache('church-a', [3]);
    writeLongTermTrendsCache(headcountOnly);
    expect(readLongTermTrendsCache('church-a', [3])).toBeNull();
  });

  it('clears only the requested selection when one is provided', () => {
    writeLongTermTrendsCache(contextualOverview({ gatheringTypeIds: [1] }));
    writeLongTermTrendsCache(contextualOverview({ gatheringTypeIds: [2] }));
    writeLongTermTrendsCache(contextualOverview({ churchId: 'church-b', gatheringTypeIds: [1] }));

    clearLongTermTrendsCache('church-a', [1]);

    expect(readLongTermTrendsCache('church-a', [1])).toBeNull();
    expect(readLongTermTrendsCache('church-a', [2])).not.toBeNull();
    expect(readLongTermTrendsCache('church-b', [1])).not.toBeNull();
  });

  it('keeps the newest snapshot for each selection before retaining older snapshots', () => {
    for (let id = 1; id <= 3; id += 1) {
      writeLongTermTrendsCache(contextualOverview({ gatheringTypeIds: [id], completedWeekEnd: '2026-08-23' }));
      writeLongTermTrendsCache(contextualOverview({ gatheringTypeIds: [id], completedWeekEnd: '2026-08-30' }));
    }

    expect(readLongTermTrendsCache('church-a', [1])?.window.completedWeekEnd).toBe('2026-08-30');
    expect(readLongTermTrendsCache('church-a', [3])?.window.completedWeekEnd).toBe('2026-08-30');
  });
});
