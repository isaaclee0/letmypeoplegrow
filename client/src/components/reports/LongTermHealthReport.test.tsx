import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngagementOverviewDto } from '../../services/api';
import { reportsAPI, settingsAPI } from '../../services/api';
import { writeEngagementOverviewCache } from '../../services/engagementReportCache';
import LongTermHealthReport from './LongTermHealthReport';

vi.mock('react-chartjs-2', () => ({
  Doughnut: () => <div aria-label="Primary tier distribution chart" />,
  Line: () => <div aria-label="Attendance trend chart" />,
}));

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    reportsAPI: {
      ...actual.reportsAPI,
      getEngagementOverview: vi.fn(),
      getEngagementPeople: vi.fn(),
      getEngagementSessions: vi.fn(),
    },
    settingsAPI: {
      ...actual.settingsAPI,
      updateEngagementSettings: vi.fn(),
    },
  };
});

const settings = {
  coreMinimum: 60,
  casualMinimum: 20,
  tiers: {
    core: { label: 'Committed', colour: '#166534' },
    casual: { label: 'Connected', colour: '#b45309' },
    irregular: { label: 'Occasional', colour: '#b91c1c' },
  },
  gatheringRoles: [
    { gatheringTypeId: 1, name: 'Sunday', attendanceType: 'standard' as const, isActive: true, role: 'primary' as const },
    { gatheringTypeId: 2, name: 'Youth', attendanceType: 'standard' as const, isActive: false, role: 'community' as const },
    { gatheringTypeId: 3, name: 'Conference', attendanceType: 'headcount' as const, isActive: true, role: 'other' as const },
  ],
  calculationRulesVersion: 2,
  assignmentPreview: { primaryAssigned: 8, communityAssigned: 6, primaryNotAssigned: 2 },
};

const overview = (overrides: Partial<EngagementOverviewDto> = {}): EngagementOverviewDto => ({
  schemaVersion: 1,
  churchId: 'church-a',
  window: {
    completedWeekEnd: '2026-08-16', sourceStart: '2025-07-21', sourceEnd: '2026-08-16',
    currentStart: '2025-08-18', currentEnd: '2026-08-16',
    comparisonStart: '2025-07-21', comparisonEnd: '2026-07-19',
  },
  settings,
  setup: { hasPrimaryRole: true, hasStandardPrimaryRole: true, hasPrimaryAssignments: true },
  population: { activeRegulars: 10 },
  primaryDistribution: {
    classified: { denominator: 7, tiers: [
      { tier: 'core', ...settings.tiers.core, count: 4, rate: 4 / 7, peopleToken: 'core-token' },
      { tier: 'casual', ...settings.tiers.casual, count: 2, rate: 2 / 7, peopleToken: 'casual-token' },
      { tier: 'irregular', ...settings.tiers.irregular, count: 1, rate: 1 / 7, peopleToken: 'irregular-token' },
    ] },
    establishing: { count: 1, peopleToken: 'establishing-token' },
    notAssigned: { count: 2, peopleToken: 'unassigned-token' },
  },
  movement: { denominator: 10, categories: {
    higher: { count: 2, peopleToken: 'higher-token' }, same: { count: 5, peopleToken: 'same-token' },
    lower: { count: 1, peopleToken: 'lower-token' }, nonComparable: { count: 2, peopleToken: 'nc-token' },
  } },
  matrix: {
    classifiedOnBothAxes: 5,
    cells: [
      { primaryTier: 'core', communityTier: 'core', primaryLabel: 'Committed', communityLabel: 'Committed', count: 3, peopleToken: 'matrix-cc' },
      { primaryTier: 'irregular', communityTier: 'core', primaryLabel: 'Occasional', communityLabel: 'Committed', count: 2, peopleToken: 'matrix-ic' },
    ],
    outside: { primaryEstablishing: 1, primaryNotAssigned: 2, communityEstablishing: 1, communityNotAssigned: 3, notClassifiedOnBothAxes: 5 },
  },
  trend: { buckets: [{
    index: 0, startDate: '2025-08-18', endDate: '2025-09-14', series: [{
      role: 'primary', attendanceType: 'standard', heldSessions: 4, totalAttendance: 120,
      averageAttendance: 30, uniquePeople: 42, sessionsToken: 'sessions-0', peopleToken: 'people-0',
    }, {
      role: 'community', attendanceType: 'headcount', heldSessions: 2, totalAttendance: 36,
      averageAttendance: 18, uniquePeople: null, sessionsToken: 'sessions-hc', peopleToken: null,
    }],
  }] },
  visitorJourney: { local: {
    firstTime: { count: 6, peopleToken: 'visitor-first' },
    returnedWithinEightWeeks: { count: 4, peopleToken: 'visitor-return' },
    currentRegular: { count: 2, peopleToken: 'visitor-regular' }, conversionDateKnown: false,
  }, traveller: { firstTime: { count: 3, peopleToken: 'traveller-first' } } },
  coverage: {
    personLevelSessions: { numerator: 45, denominator: 50, rate: .9, excluded: 5 },
    explicitProvenance: { numerator: 30, denominator: 45, rate: 2 / 3 },
    legacyProvenance: { numerator: 15, denominator: 45, rate: 1 / 3 },
    establishing: { numerator: 1, denominator: 10, rate: .1 },
    primaryNotAssigned: { numerator: 2, denominator: 10, rate: .2 },
    sessionsTokens: { eligible: 'eligible', explicit: 'explicit', legacy: 'legacy', excludedUnknown: 'unknown' },
  },
  ...overrides,
});

describe('LongTermHealthReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders authoritative server data and completes loading when overview storage is blocked', async () => {
    writeEngagementOverviewCache(overview({ population: { activeRegulars: 9 } }));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });
    vi.mocked(reportsAPI.getEngagementOverview).mockResolvedValue({
      data: overview({ population: { activeRegulars: 13 } }),
    } as never);

    render(<LongTermHealthReport churchId="church-a" canConfigure />);

    expect(await screen.findByText('13 active regulars')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Updating…')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('refreshes to authoritative rules after settings save when cache removal fails', async () => {
    vi.mocked(reportsAPI.getEngagementOverview)
      .mockResolvedValueOnce({ data: overview() } as never)
      .mockResolvedValueOnce({ data: overview({
        population: { activeRegulars: 14 },
        settings: { ...settings, coreMinimum: 65, calculationRulesVersion: 3 },
      }) } as never);
    vi.mocked(settingsAPI.updateEngagementSettings).mockResolvedValue({ data: { settings: {
      ...settings, coreMinimum: 65, calculationRulesVersion: 3,
    } } } as never);
    render(<LongTermHealthReport churchId="church-a" canConfigure />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure engagement' }));
    fireEvent.change(screen.getByLabelText('Core minimum'), { target: { value: '65' } });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked', 'SecurityError');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save engagement settings' }));

    expect(await screen.findByText('14 active regulars')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Configure engagement' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Updating…')).not.toBeInTheDocument());
  });

  it('renders setup guidance instead of an empty chart when Primary is not configured', async () => {
    vi.mocked(reportsAPI.getEngagementOverview).mockResolvedValue({ data: overview({
      setup: { hasPrimaryRole: false, hasStandardPrimaryRole: false, hasPrimaryAssignments: false },
    }) } as never);

    render(<LongTermHealthReport churchId="church-a" canConfigure />);

    expect(await screen.findByRole('heading', { name: 'Choose a Primary gathering' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Primary tier distribution chart')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure engagement' })).toBeInTheDocument();
  });

  it('warns when nobody has an active Primary assignment', async () => {
    vi.mocked(reportsAPI.getEngagementOverview).mockResolvedValue({ data: overview({
      setup: { hasPrimaryRole: true, hasStandardPrimaryRole: true, hasPrimaryAssignments: false },
    }) } as never);
    render(<LongTermHealthReport churchId="church-a" canConfigure />);
    expect(await screen.findByText(/No active regulars have a Primary assignment/)).toBeInTheDocument();
  });

  it('shows cached data immediately, marks it as updating, then replaces it with fresh data', async () => {
    writeEngagementOverviewCache(overview({ population: { activeRegulars: 10 } }));
    let resolveRequest!: (value: unknown) => void;
    vi.mocked(reportsAPI.getEngagementOverview).mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }) as never);

    render(<LongTermHealthReport churchId="church-a" canConfigure />);
    expect(screen.getByText('10 active regulars')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Updating…');

    resolveRequest({ data: overview({ population: { activeRegulars: 12 } }) });
    expect(await screen.findByText('12 active regulars')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Updating…')).not.toBeInTheDocument());
  });

  it('does not replace a newly selected church with a late response from the previous church', async () => {
    let resolveChurchA!: (value: unknown) => void;
    let resolveChurchB!: (value: unknown) => void;
    vi.mocked(reportsAPI.getEngagementOverview)
      .mockReturnValueOnce(new Promise((resolve) => { resolveChurchA = resolve; }) as never)
      .mockReturnValueOnce(new Promise((resolve) => { resolveChurchB = resolve; }) as never);
    const { rerender } = render(<LongTermHealthReport churchId="church-a" canConfigure />);

    rerender(<LongTermHealthReport churchId="church-b" canConfigure />);
    await act(async () => { resolveChurchB({ data: overview({ churchId: 'church-b', population: { activeRegulars: 22 } }) }); });
    expect(await screen.findByText('22 active regulars')).toBeInTheDocument();

    await act(async () => { resolveChurchA({ data: overview({ churchId: 'church-a', population: { activeRegulars: 11 } }) }); });
    expect(screen.getByText('22 active regulars')).toBeInTheDocument();
    expect(screen.queryByText('11 active regulars')).not.toBeInTheDocument();
  });

  it('synchronously hides the previous church overview and settings modal when church changes', async () => {
    writeEngagementOverviewCache(overview());
    vi.mocked(reportsAPI.getEngagementOverview).mockReturnValue(new Promise(() => {}) as never);
    const { rerender } = render(<LongTermHealthReport churchId="church-a" canConfigure />);
    const configure = screen.getByRole('button', { name: 'Configure engagement' });
    configure.focus();
    fireEvent.click(configure);
    expect(screen.getByRole('dialog', { name: 'Configure engagement' })).toBeInTheDocument();

    rerender(<LongTermHealthReport churchId="church-b" canConfigure />);

    expect(screen.queryByText('10 active regulars')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Configure engagement' })).not.toBeInTheDocument();
  });

  it('synchronously closes a previous-church drilldown and hides its rows when church changes', async () => {
    writeEngagementOverviewCache(overview());
    vi.mocked(reportsAPI.getEngagementOverview).mockReturnValue(new Promise(() => {}) as never);
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [{
      rowType: 'engagement_profile', individualId: 1, firstName: 'Alex', lastName: 'Able', familyId: null,
      primary: { status: 'core', attended: 31, opportunities: 46, rate: 31 / 46 },
      community: { status: 'establishing', attended: 3, opportunities: 5, rate: .6 },
    }], nextCursor: null } } as never);
    const { rerender } = render(<LongTermHealthReport churchId="church-a" canConfigure />);
    fireEvent.click(screen.getByRole('button', { name: /Committed: 4 of 7/ }));
    expect(await screen.findByText('Alex Able')).toBeInTheDocument();

    rerender(<LongTermHealthReport churchId="church-b" canConfigure />);

    expect(screen.queryByRole('dialog', { name: 'Committed people' })).not.toBeInTheDocument();
    expect(screen.queryByText('Alex Able')).not.toBeInTheDocument();
  });

  it('keeps cached data with a refresh warning, but shows an error when no cache exists', async () => {
    writeEngagementOverviewCache(overview());
    vi.mocked(reportsAPI.getEngagementOverview).mockRejectedValue(new Error('offline'));
    const first = render(<LongTermHealthReport churchId="church-a" canConfigure />);
    expect(await screen.findByText(/showing saved data/i)).toBeInTheDocument();
    expect(screen.getByText('10 active regulars')).toBeInTheDocument();
    first.unmount();
    localStorage.clear();
    render(<LongTermHealthReport churchId="church-a" canConfigure />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load long-term health');
  });

  it('provides fixed-window, distribution, matrix, trend, visitor, and coverage facts as text', async () => {
    vi.mocked(reportsAPI.getEngagementOverview).mockResolvedValue({ data: overview() } as never);
    render(<LongTermHealthReport churchId="church-a" canConfigure={false} />);

    expect(await screen.findByText('18 Aug 2025 – 16 Aug 2026')).toBeInTheDocument();
    expect(screen.getByText(/latest 52 fully completed weeks/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Committed: 4 of 7 classified people \(57%\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Establishing: 1 person' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not assigned: 2 people' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /Occasional Primary, Committed Community: 2 people/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /18 Aug 2025 – 14 Sept 2025: Primary standard — average 30 across 4 held sessions; 42 unique people/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Community headcount — average 18 across 2 held sessions; unique reach is unavailable/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'First attended as a local visitor: 6 people' })).toBeInTheDocument();
    expect(screen.getByText(/exact historical conversion date is not known/i)).toBeInTheDocument();
    expect(screen.getByText(/45 of 50 held sessions had reliable person-level coverage \(90%\)/)).toBeInTheDocument();
    expect(screen.getByText(/15 of 45 reliable sessions use legacy roster evidence \(33%\)/)).toBeInTheDocument();
    expect(screen.getByText(/Colour is a visual aid; every tier is also identified by name/)).toBeInTheDocument();
    expect(screen.getByText(/Active rules: Committed ≥ 60%; Connected 20–59%; Occasional < 20%/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Configure engagement' })).not.toBeInTheDocument();
  });

  it('opens token-based drilldowns and appends cursor-paginated rows', async () => {
    vi.mocked(reportsAPI.getEngagementOverview).mockResolvedValue({ data: overview() } as never);
    vi.mocked(reportsAPI.getEngagementPeople)
      .mockResolvedValueOnce({ data: { rows: [{
        rowType: 'engagement_profile', individualId: 1, firstName: 'Alex', lastName: 'Able', familyId: null,
        primary: { status: 'core', attended: 31, opportunities: 46, rate: 31 / 46 },
        community: { status: 'establishing', attended: 3, opportunities: 5, rate: .6 },
      }], nextCursor: 'next-page' } } as never)
      .mockResolvedValueOnce({ data: { rows: [{
        rowType: 'engagement_profile', individualId: 2, firstName: 'Blair', lastName: 'Baker', familyId: null,
        primary: { status: 'not_assigned', attended: 0, opportunities: 0, rate: null },
        community: { status: 'irregular', attended: 1, opportunities: 10, rate: .1 },
      }], nextCursor: null } } as never);

    render(<LongTermHealthReport churchId="church-a" canConfigure />);
    fireEvent.click(await screen.findByRole('button', { name: /Committed: 4 of 7/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Committed people' });
    expect(within(dialog).getByText('31 of 46 opportunities (67%)')).toBeInTheDocument();
    expect(within(dialog).getByText('Establishing')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load more' }));
    expect(await within(dialog).findByText('Blair Baker')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Not assigned')).toHaveLength(2);
    expect(reportsAPI.getEngagementPeople).toHaveBeenNthCalledWith(2, {
      segment: 'core-token', cursor: 'next-page', limit: 50,
    });
  });

  it('clears old rules and drilldown tokens after save before refreshing, and fails closed if refresh fails', async () => {
    vi.mocked(reportsAPI.getEngagementOverview)
      .mockResolvedValueOnce({ data: overview() } as never)
      .mockRejectedValueOnce(new Error('offline'));
    vi.mocked(settingsAPI.updateEngagementSettings).mockResolvedValue({ data: { settings: {
      ...settings, coreMinimum: 65, calculationRulesVersion: 3,
    } } } as never);
    render(<LongTermHealthReport churchId="church-a" canConfigure />);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure engagement' }));
    fireEvent.change(screen.getByLabelText('Core minimum'), { target: { value: '65' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save engagement settings' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load long-term health');
    expect(screen.queryByText('10 active regulars')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Committed: 4 of 7/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/showing saved data/i)).not.toBeInTheDocument();
  });

  it('traps focus in settings, closes on Escape, and restores the Configure engagement trigger', async () => {
    vi.mocked(reportsAPI.getEngagementOverview).mockResolvedValue({ data: overview() } as never);
    render(<LongTermHealthReport churchId="church-a" canConfigure />);
    const trigger = await screen.findByRole('button', { name: 'Configure engagement' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Configure engagement' });
    const close = within(dialog).getByRole('button', { name: 'Close settings' });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(within(dialog).getByRole('button', { name: 'Save engagement settings' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Configure engagement' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('traps focus in a drilldown, closes on Escape, and restores its segment trigger', async () => {
    vi.mocked(reportsAPI.getEngagementOverview).mockResolvedValue({ data: overview() } as never);
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [], nextCursor: null } } as never);
    render(<LongTermHealthReport churchId="church-a" canConfigure />);
    const trigger = await screen.findByRole('button', { name: /Committed: 4 of 7/ });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Committed people' });
    const close = within(dialog).getByRole('button', { name: 'Close details' });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Committed people' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
