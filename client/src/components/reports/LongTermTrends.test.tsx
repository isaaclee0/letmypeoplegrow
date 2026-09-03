import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextualLongTermOverviewDto, GatheringType } from '../../services/api';
import { individualsAPI, reportsAPI, settingsAPI } from '../../services/api';
import { readLongTermTrendsCache, writeLongTermTrendsCache } from '../../services/engagementReportCache';
import LongTermTrends from './LongTermTrends';

vi.mock('react-chartjs-2', () => ({
  Doughnut: () => <div aria-label="Regularity chart" />,
  Line: () => <div aria-label="Attendance direction chart" />,
}));

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    reportsAPI: {
      ...actual.reportsAPI,
      getLongTermTrends: vi.fn(),
      getEngagementPeople: vi.fn(),
      getEngagementSessions: vi.fn(),
    },
    individualsAPI: {
      ...actual.individualsAPI,
      getAttendanceHistory: vi.fn(),
    },
    settingsAPI: {
      ...actual.settingsAPI,
      updateEngagementSettings: vi.fn(),
    },
  };
});

const selected = (
  id: number,
  name: string,
  attendanceType: GatheringType['attendanceType'] = 'standard',
): GatheringType => ({ id, name, attendanceType, isActive: true });

const makeBuckets = (prefix: string) => Array.from({ length: 13 }, (_, index) => ({
  index,
  startDate: `2025-${String(9 + Math.floor(index / 4)).padStart(2, '0')}-${String(1 + (index % 4) * 7).padStart(2, '0')}`,
  endDate: `2025-${String(9 + Math.floor(index / 4)).padStart(2, '0')}-${String(7 + (index % 4) * 7).padStart(2, '0')}`,
  heldSessions: 4,
  averageAttendance: 40 + index,
  sessionsToken: `${prefix}-${index}`,
}));

const declineRows = (count: number) => Array.from({ length: count }, (_, index) => ({
  individualId: index + 1,
  firstName: `Person${index + 1}`,
  lastName: 'Example',
  baseline: { attendedWeeks: 3, opportunityWeeks: 4, rate: 75 },
  recent: { attendedWeeks: 1, opportunityWeeks: 6, rate: 16.7 },
  summary: 'Usually attends 3 weeks in 4; attended 1 of the last 6 weeks.',
}));

const overview = ({
  churchId = 'church-a',
  gatherings = [selected(1, 'Sunday')],
  availableWeeks = 52,
  directionStatus = 'down',
  percentChange = -7,
  population = 8,
  declines = declineRows(1),
}: {
  churchId?: string;
  gatherings?: GatheringType[];
  availableWeeks?: number;
  directionStatus?: ContextualLongTermOverviewDto['direction']['status'];
  percentChange?: number | null;
  population?: number;
  declines?: NonNullable<ContextualLongTermOverviewDto['declines']>['rows'];
} = {}): ContextualLongTermOverviewDto => {
  const canonical = [...gatherings].sort((left, right) => left.id - right.id);
  const standardGatherings = canonical.filter(({ attendanceType }) => attendanceType === 'standard').length;
  const headcountGatherings = canonical.length - standardGatherings;
  return {
    schemaVersion: 4,
    churchId,
    gatheringTypeIds: canonical.map(({ id }) => id),
    window: {
      completedWeekEnd: '2026-08-30',
      startDate: availableWeeks === 52 ? '2025-09-01' : '2026-02-02',
      endDate: '2026-08-30',
      maximumWeeks: 52,
    },
    settings: {
      coreMinimum: 60,
      casualMinimum: 20,
      tiers: {
        core: { label: 'Core', colour: '#166534' },
        casual: { label: 'Casual', colour: '#b45309' },
        irregular: { label: 'Irregular', colour: '#b91c1c' },
      },
      calculationRulesVersion: 2,
    },
    dataAvailability: {
      availableWeeks,
      firstSessionDate: availableWeeks === 52 ? '2025-09-01' : '2026-02-08',
      lastSessionDate: '2026-08-23',
      validOpportunityWeeks: availableWeeks,
      excludedWeeks: 0,
      unclassifiedBecauseNoEvidence: 0,
      standardGatherings,
      headcountGatherings,
    },
    direction: {
      comparisonWeeks: 12,
      previousAverage: directionStatus === 'unavailable' ? null : 50,
      recentAverage: directionStatus === 'unavailable' ? null : 46.5,
      percentChange,
      status: directionStatus,
      series: canonical.map((gathering) => ({
        gatheringTypeId: gathering.id,
        name: gathering.name,
        attendanceType: gathering.attendanceType,
        buckets: makeBuckets(`sessions-${gathering.id}`),
      })),
    },
    regularity: standardGatherings === 0 ? null : {
      population,
      tiers: [
        { tier: 'core', label: 'Core', colour: '#166534', count: 4, rate: 50, peopleToken: 'core-token' },
        { tier: 'casual', label: 'Casual', colour: '#b45309', count: 3, rate: 37.5, peopleToken: 'casual-token' },
        { tier: 'irregular', label: 'Irregular', colour: '#b91c1c', count: 1, rate: 12.5, peopleToken: 'irregular-token' },
      ],
    },
    declines: standardGatherings === 0 ? null : {
      total: declines.length,
      rows: declines.slice(0, 10),
      peopleToken: 'decline-token',
    },
  };
};

describe('LongTermTrends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('explains an empty gathering selection without requesting trends', () => {
    render(<LongTermTrends churchId="church-a" selectedGatherings={[]} canConfigure />);

    expect(screen.getByRole('heading', { name: 'Long-term trends' })).toBeInTheDocument();
    expect(screen.getByText(/choose one or more gatherings/i)).toBeInTheDocument();
    expect(reportsAPI.getLongTermTrends).not.toHaveBeenCalled();
  });

  it('requests canonical selected IDs and explains the fixed window and weekly alternatives', async () => {
    const gatherings = [selected(2, 'Evening'), selected(1, 'Morning')];
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview({ gatherings }) } as never);

    render(<LongTermTrends churchId="church-a" selectedGatherings={gatherings} canConfigure={false} />);

    await waitFor(() => expect(reportsAPI.getLongTermTrends).toHaveBeenCalledWith([1, 2]));
    expect(await screen.findByText(/latest 52 completed weeks/i)).toBeInTheDocument();
    expect(screen.getByText(/date range above does not affect these trends/i)).toBeInTheDocument();
    expect(screen.getByText('Attendance at any selected gathering counts once per week.')).toBeInTheDocument();
  });

  it('ignores a late response after the gathering selection changes', async () => {
    let resolveSunday!: (value: unknown) => void;
    let resolveYouth!: (value: unknown) => void;
    vi.mocked(reportsAPI.getLongTermTrends)
      .mockReturnValueOnce(new Promise((resolve) => { resolveSunday = resolve; }) as never)
      .mockReturnValueOnce(new Promise((resolve) => { resolveYouth = resolve; }) as never);
    const { rerender } = render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    rerender(<LongTermTrends churchId="church-a" selectedGatherings={[selected(2, 'Youth')]} canConfigure={false} />);
    await act(async () => resolveYouth({ data: overview({ gatherings: [selected(2, 'Youth')], population: 22 }) }));
    expect(await screen.findByText('22 assigned active regulars')).toBeInTheDocument();

    await act(async () => resolveSunday({ data: overview({ population: 11 }) }));
    expect(screen.getByText('22 assigned active regulars')).toBeInTheDocument();
    expect(screen.queryByText('11 assigned active regulars')).not.toBeInTheDocument();
  });

  it('uses the actual available history when fewer than 52 completed weeks exist', async () => {
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview({ availableWeeks: 31 }) } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    expect(await screen.findByText(/based on 31 weeks of available attendance history/i)).toBeInTheDocument();
    expect(screen.getByText(/8 Feb 2026 – 23 Aug 2026/)).toBeInTheDocument();
  });

  it.each([
    ['up', 7, 'Average attendance is up 7% compared with the previous 12 weeks.'],
    ['down', -7, 'Average attendance is down 7% compared with the previous 12 weeks.'],
    ['steady', 0.4, 'Average attendance is steady compared with the previous 12 weeks.'],
    ['unavailable', null, 'There is not enough completed attendance history to compare the latest 12 weeks.'],
  ] as const)('summarises %s attendance direction in words', async (directionStatus, percentChange, expected) => {
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({
      data: overview({ directionStatus, percentChange }),
    } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.getByLabelText('Attendance direction chart')).toBeInTheDocument();
  });

  it('explains headcount-only and mixed selections without treating them as errors', async () => {
    const headcount = selected(3, 'Conference', 'headcount');
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValueOnce({
      data: overview({ gatherings: [headcount] }),
    } as never);
    const first = render(<LongTermTrends churchId="church-a" selectedGatherings={[headcount]} canConfigure={false} />);

    expect(await screen.findByText(/person-level trends require a standard attendance gathering/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Attendance direction' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Regularity chart')).not.toBeInTheDocument();
    first.unmount();

    const mixed = [selected(1, 'Sunday'), headcount];
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValueOnce({ data: overview({ gatherings: mixed }) } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={mixed} canConfigure={false} />);
    expect(await screen.findByText(/attendance direction includes all selected gatherings/i)).toBeInTheDocument();
    expect(screen.getByText(/person-level results use only the selected standard gathering/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Regularity chart')).toBeInTheDocument();
  });

  it('shows labelled tier counts and visibly opens a focused contextual people panel', async () => {
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview() } as never);
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [{
      rowType: 'contextual_regularity', individualId: 1, firstName: 'Alex', lastName: 'Able', familyId: null,
      tier: 'core', rate: 75, evidence: { attendedWeeks: 9, opportunityWeeks: 12 },
    }], nextCursor: null } } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    const trigger = await screen.findByRole('button', { name: 'Core: 4 people (50%)' });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = await screen.findByRole('region', { name: 'Core people' });
    expect(within(panel).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(within(panel).getByRole('columnheader', { name: 'Attendance' })).toBeInTheDocument();
    expect(within(panel).getByText('9 of 12 weeks (75%)')).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Core people' })).toHaveFocus();
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(trigger).toHaveFocus();
  });

  it('keeps contextual column labels visible while people are still loading', async () => {
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview() } as never);
    vi.mocked(reportsAPI.getEngagementPeople).mockReturnValue(new Promise(() => {}) as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Core: 4 people (50%)' }));
    const panel = screen.getByRole('region', { name: 'Core people' });
    expect(within(panel).getByRole('columnheader', { name: 'Name' })).toBeInTheDocument();
    expect(within(panel).getByRole('columnheader', { name: 'Attendance' })).toBeInTheDocument();
  });

  it('limits the decline preview to ten plain evidence rows and opens View all', async () => {
    const rows = declineRows(10);
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({
      data: { ...overview({ declines: rows }), declines: { total: 11, rows, peopleToken: 'decline-token' } },
    } as never);
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [{
      rowType: 'contextual_decline', ...rows[0],
    }], nextCursor: null } } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    const declineRegion = await screen.findByRole('region', { name: 'People attending less often' });
    expect(within(declineRegion).getAllByRole('listitem')).toHaveLength(10);
    expect(within(declineRegion).getAllByText('Usually attends 3 weeks in 4; attended 1 of the last 6 weeks.')).toHaveLength(10);
    const viewAll = within(declineRegion).getByRole('button', { name: 'View all 11 people' });
    viewAll.focus();
    fireEvent.click(viewAll);
    const panel = await within(declineRegion).findByRole('region', { name: 'People attending less often' });
    expect(within(panel).getByRole('columnheader', { name: 'Recent attendance' })).toBeInTheDocument();
    expect(within(panel).getByText('1 of 6 recent weeks (16.7%)')).toBeInTheDocument();
  });

  it('shows matching cached data while refreshing and warns when that refresh fails', async () => {
    writeLongTermTrendsCache(overview({ population: 10 }));
    let rejectRefresh!: (reason?: unknown) => void;
    vi.mocked(reportsAPI.getLongTermTrends).mockReturnValue(new Promise((_resolve, reject) => { rejectRefresh = reject; }) as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    expect(screen.getByText('10 assigned active regulars')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Updating');
    await act(async () => rejectRefresh(new Error('offline')));
    expect(await screen.findByRole('alert')).toHaveTextContent(/showing saved data/i);
    expect(screen.getByText('10 assigned active regulars')).toBeInTheDocument();
  });

  it('clears every long-term trends cache for the church after settings change, then refreshes the current selection', async () => {
    const current = overview();
    const otherSelection = overview({ gatherings: [selected(2, 'Youth')] });
    writeLongTermTrendsCache(otherSelection);
    vi.mocked(reportsAPI.getLongTermTrends)
      .mockResolvedValueOnce({ data: current } as never)
      .mockResolvedValueOnce({ data: { ...current, settings: { ...current.settings, calculationRulesVersion: 3 } } } as never);
    vi.mocked(settingsAPI.updateEngagementSettings).mockResolvedValue({ data: { settings: current.settings } } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure />);

    fireEvent.click(await screen.findByRole('button', { name: 'Regularity settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save regularity settings' }));

    await waitFor(() => expect(reportsAPI.getLongTermTrends).toHaveBeenCalledTimes(2));
    expect(readLongTermTrendsCache('church-a', [2])).toBeNull();
  });

  it('explains people without evidence even when every classified tier is zero', async () => {
    const result = overview({ population: 3 });
    result.dataAvailability.unclassifiedBecauseNoEvidence = 3;
    result.regularity!.tiers = result.regularity!.tiers.map((tier) => ({ ...tier, count: 0, rate: 0 }));
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: result } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    expect(await screen.findByText('3 people could not be classified because they have no reliable attendance evidence.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Core: 0 people (0%)' })).toBeInTheDocument();
  });

  it('lets users choose and open every nonempty attendance-session bucket', async () => {
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview() } as never);
    vi.mocked(reportsAPI.getEngagementSessions).mockResolvedValue({ data: { rows: [], nextCursor: null } } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    const period = await screen.findByRole('combobox', { name: 'Attendance period for Sunday' });
    fireEvent.change(period, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'View Sunday attendance sessions' }));
    expect(await screen.findByRole('dialog', { name: 'Sunday attendance sessions — 22 Sept 2025 – 28 Sept 2025' })).toBeInTheDocument();
  });

  it('opens decline attendance history from the keyboard and scopes it to selected gatherings', async () => {
    const gatherings = [selected(2, 'Youth'), selected(1, 'Sunday')];
    const decline = {
      ...declineRows(1)[0],
      individualId: 1001,
      firstName: 'Alex',
      lastName: 'Able',
    };
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview({ gatherings, declines: [decline] }) } as never);
    vi.mocked(individualsAPI.getAttendanceHistory).mockResolvedValue({ data: { history: [
      { date: '2026-09-02', gatheringId: 2, gatheringName: 'Youth', present: true },
      { date: '2026-09-01', gatheringId: 1, gatheringName: 'Sunday', present: true },
      { date: '2026-08-31', gatheringId: 3, gatheringName: 'Conference', present: true },
    ] } } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={gatherings} canConfigure={false} />);

    const declineRegion = await screen.findByRole('region', { name: 'People attending less often' });
    const historyTrigger = within(declineRegion).getByRole('button', { name: /Alex Able/ });
    expect(historyTrigger).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(historyTrigger, { key: 'Enter' });

    expect(await within(declineRegion).findByText(/Sep 2, 2026/)).toHaveTextContent('Youth');
    expect(within(declineRegion).getByText(/Sep 1, 2026/)).toHaveTextContent('Sunday');
    expect(within(declineRegion).queryByText(/Aug 31, 2026/)).not.toBeInTheDocument();
  });

  it('keeps a no-cache failure local and retries it', async () => {
    vi.mocked(reportsAPI.getLongTermTrends)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: overview({ population: 12 }) } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load long-term trends/i);
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('12 assigned active regulars')).toBeInTheDocument();
    expect(reportsAPI.getLongTermTrends).toHaveBeenCalledTimes(2);
  });

  it('shows Regularity settings only to administrators', async () => {
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview() } as never);
    const first = render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);
    await screen.findByRole('region', { name: 'Regularity' });
    expect(screen.queryByRole('button', { name: 'Regularity settings' })).not.toBeInTheDocument();
    first.unmount();

    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure />);
    expect(await screen.findByRole('button', { name: 'Regularity settings' })).toBeInTheDocument();
  });
});
