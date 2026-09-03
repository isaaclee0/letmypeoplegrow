import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextualLongTermOverviewDto, EngagementOverviewDto } from './api';
import {
  clearLongTermTrendsCache,
  clearEngagementOverviewCache,
  readLongTermTrendsCache,
  readEngagementOverviewCache,
  writeLongTermTrendsCache,
  writeEngagementOverviewCache,
} from './engagementReportCache';

const overview = (churchId = 'church-a', completedWeekEnd = '2026-08-16'): EngagementOverviewDto => ({
  schemaVersion: 3,
  churchId,
  window: {
    completedWeekEnd,
    sourceStart: '2025-07-21', sourceEnd: completedWeekEnd,
    currentStart: '2025-08-18', currentEnd: completedWeekEnd,
    comparisonStart: '2025-07-21', comparisonEnd: '2026-07-19',
  },
  settings: {
    coreMinimum: 60, casualMinimum: 20,
    tiers: {
      core: { label: 'Core', colour: '#16A34A' },
      casual: { label: 'Casual', colour: '#D97706' },
      irregular: { label: 'Irregular', colour: '#DC2626' },
    },
    gatheringRoles: [{ gatheringTypeId: 1, name: 'Sunday', attendanceType: 'standard', isActive: true, role: 'primary' }],
    calculationRulesVersion: 1,
    assignmentPreview: { primaryAssigned: 1, communityAssigned: 0, primaryNotAssigned: 0 },
  },
  setup: { hasPrimaryRole: true, hasStandardPrimaryRole: true, hasPrimaryAssignments: true },
  baseline: { pending: false, pendingAxes: 0 },
  historyBackfill: { completed: true, firstWeekEnd: '2026-01-04', lastWeekEnd: completedWeekEnd, weeksEvaluated: 33, transitionsReconstructed: 1 },
  population: { activeRegulars: 1 },
  primaryDistribution: {
    classified: { denominator: 1, tiers: [{ tier: 'core', label: 'Core', colour: '#16A34A', count: 1, rate: 1, peopleToken: 'core' }] },
    establishing: { count: 0, peopleToken: 'establishing' },
    notAssigned: { count: 0, peopleToken: 'not-assigned' },
  },
  tierMovement: {
    recentWindowWeeks: 13,
    axes: {
      primary: {
        confirmingHigher: { count: 1, peopleToken: 'primary-higher' },
        confirmingLower: { count: 0, peopleToken: 'primary-lower' },
        confirmedRecently: { count: 1, peopleToken: 'primary-recent' },
      },
      community: {
        confirmingHigher: { count: 0, peopleToken: 'community-higher' },
        confirmingLower: { count: 1, peopleToken: 'community-lower' },
        confirmedRecently: { count: 1, peopleToken: 'community-recent' },
      },
    },
  },
  matrix: {
    classifiedOnBothAxes: 0,
    cells: [{ primaryTier: 'core', communityTier: 'core', primaryLabel: 'Core', communityLabel: 'Core', count: 0, peopleToken: 'matrix' }],
    outside: { primaryEstablishing: 0, primaryNotAssigned: 0, communityEstablishing: 0, communityNotAssigned: 1, notClassifiedOnBothAxes: 1 },
  },
  trend: { buckets: [{ index: 0, startDate: '2025-08-18', endDate: '2025-09-14', series: [{
    role: 'primary', attendanceType: 'standard', heldSessions: 1, totalAttendance: 1,
    averageAttendance: 1, uniquePeople: 1, sessionsToken: 'sessions', peopleToken: 'people',
  }] }] },
  visitorJourney: { local: {
    firstTime: { count: 0, peopleToken: 'local-first' },
    returnedWithinEightWeeks: { count: 0, peopleToken: 'local-returned' },
    currentRegular: { count: 0, peopleToken: 'local-regular' }, conversionDateKnown: false,
  }, traveller: { firstTime: { count: 0, peopleToken: 'traveller-first' } } },
  coverage: {
    personLevelSessions: { numerator: 1, denominator: 1, rate: 1, excluded: 0 },
    explicitProvenance: { numerator: 1, denominator: 1, rate: 1 },
    legacyProvenance: { numerator: 0, denominator: 1, rate: 0 },
    establishing: { numerator: 0, denominator: 1, rate: 0 },
    primaryNotAssigned: { numerator: 0, denominator: 1, rate: 0 },
    sessionsTokens: { eligible: 'eligible', explicit: 'explicit', legacy: 'legacy', excludedUnknown: 'unknown' },
  },
});

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

describe('engagement report cache', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('treats a storage read failure as a cache miss', () => {
    writeEngagementOverviewCache(overview());
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });

    expect(readEngagementOverviewCache('church-a')).toBeNull();
  });

  it('ignores a storage write failure', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });

    expect(() => writeEngagementOverviewCache(overview())).not.toThrow();
  });

  it('ignores a storage removal failure', () => {
    writeEngagementOverviewCache(overview());
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });

    expect(() => clearEngagementOverviewCache('church-a')).not.toThrow();
  });

  it('keeps overview entries separate by church, completed week, and schema version', () => {
    writeEngagementOverviewCache(overview('church-a', '2026-08-09'));
    writeEngagementOverviewCache(overview('church-a', '2026-08-16'));
    writeEngagementOverviewCache(overview('church-b', '2026-08-16'));

    expect(readEngagementOverviewCache('church-a')?.window.completedWeekEnd).toBe('2026-08-16');
    expect(readEngagementOverviewCache('church-b')?.churchId).toBe('church-b');
    expect(Object.keys(localStorage).every((key) => key.includes(':v3:'))).toBe(true);
  });

  it('ignores schema-v1 overview entries without migrating them', () => {
    const legacy = { ...overview(), schemaVersion: 1 };
    localStorage.setItem(
      'engagement-overview:v1:church-a:2026-08-16',
      JSON.stringify(legacy),
    );

    expect(readEngagementOverviewCache('church-a')).toBeNull();
    expect(localStorage.getItem('engagement-overview:v1:church-a:2026-08-16')).not.toBeNull();
  });

  it('rejects malformed cached JSON and clears entries whose embedded church differs', () => {
    localStorage.setItem('engagement-overview:v3:church-a:2026-08-16', '{bad json');
    localStorage.setItem(
      'engagement-overview:v3:church-a:2026-08-09',
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

  it('rejects cached overviews with missing or invalid nested render fields', () => {
    const corruptions: Array<(candidate: any) => void> = [
      (candidate) => { delete candidate.settings.tiers.core.label; },
      (candidate) => { delete candidate.settings.gatheringRoles[0].attendanceType; },
      (candidate) => { candidate.primaryDistribution.classified.tiers[0].peopleToken = null; },
      (candidate) => { delete candidate.baseline.pendingAxes; },
      (candidate) => { delete candidate.tierMovement.axes.primary.confirmingLower.count; },
      (candidate) => { candidate.tierMovement.recentWindowWeeks = 12; },
      (candidate) => { candidate.movement = { categories: {} }; },
      (candidate) => { delete candidate.matrix.outside.communityNotAssigned; },
      (candidate) => { candidate.trend.buckets[0].series[0].uniquePeople = 'one'; },
      (candidate) => { delete candidate.visitorJourney.local.currentRegular.peopleToken; },
      (candidate) => { delete candidate.coverage.sessionsTokens.excludedUnknown; },
    ];

    for (const corrupt of corruptions) {
      localStorage.clear();
      const candidate = structuredClone(overview());
      corrupt(candidate);
      localStorage.setItem('engagement-overview:v3:church-a:2026-08-16', JSON.stringify(candidate));
      expect(readEngagementOverviewCache('church-a')).toBeNull();
      expect(localStorage.length).toBe(0);
    }
  });

  it.each([
    ['completed-week cache key', (candidate: EngagementOverviewDto) => { candidate.window.completedWeekEnd = '2026-02-30'; }],
    ['rendered window date', (candidate: EngagementOverviewDto) => { candidate.window.currentStart = 'not-a-date'; }],
    ['rendered trend date', (candidate: EngagementOverviewDto) => { candidate.trend.buckets[0].startDate = '2025-8-18'; }],
  ])('rejects cached overviews with an invalid %s', (_name, corrupt) => {
    const candidate = structuredClone(overview());
    corrupt(candidate);
    const key = `engagement-overview:v3:church-a:${candidate.window.completedWeekEnd}`;
    localStorage.setItem(key, JSON.stringify(candidate));

    expect(readEngagementOverviewCache('church-a')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
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
});
