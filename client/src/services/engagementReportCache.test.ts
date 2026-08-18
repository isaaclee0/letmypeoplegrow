import { beforeEach, describe, expect, it } from 'vitest';
import type { EngagementOverviewDto } from './api';
import {
  clearEngagementOverviewCache,
  readEngagementOverviewCache,
  writeEngagementOverviewCache,
} from './engagementReportCache';

const overview = (churchId = 'church-a', completedWeekEnd = '2026-08-16'): EngagementOverviewDto => ({
  schemaVersion: 1,
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
  population: { activeRegulars: 1 },
  primaryDistribution: {
    classified: { denominator: 1, tiers: [{ tier: 'core', label: 'Core', colour: '#16A34A', count: 1, rate: 1, peopleToken: 'core' }] },
    establishing: { count: 0, peopleToken: 'establishing' },
    notAssigned: { count: 0, peopleToken: 'not-assigned' },
  },
  movement: { denominator: 1, categories: {
    higher: { count: 0, peopleToken: 'higher' }, same: { count: 1, peopleToken: 'same' },
    lower: { count: 0, peopleToken: 'lower' }, nonComparable: { count: 0, peopleToken: 'non-comparable' },
  } },
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

  it('rejects cached overviews with missing or invalid nested render fields', () => {
    const corruptions: Array<(candidate: any) => void> = [
      (candidate) => { delete candidate.settings.tiers.core.label; },
      (candidate) => { delete candidate.settings.gatheringRoles[0].attendanceType; },
      (candidate) => { candidate.primaryDistribution.classified.tiers[0].peopleToken = null; },
      (candidate) => { delete candidate.movement.categories.lower.count; },
      (candidate) => { delete candidate.matrix.outside.communityNotAssigned; },
      (candidate) => { candidate.trend.buckets[0].series[0].uniquePeople = 'one'; },
      (candidate) => { delete candidate.visitorJourney.local.currentRegular.peopleToken; },
      (candidate) => { delete candidate.coverage.sessionsTokens.excludedUnknown; },
    ];

    for (const corrupt of corruptions) {
      localStorage.clear();
      const candidate = structuredClone(overview());
      corrupt(candidate);
      localStorage.setItem('engagement-overview:v1:church-a:2026-08-16', JSON.stringify(candidate));
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
    const key = `engagement-overview:v1:church-a:${candidate.window.completedWeekEnd}`;
    localStorage.setItem(key, JSON.stringify(candidate));

    expect(readEngagementOverviewCache('church-a')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
