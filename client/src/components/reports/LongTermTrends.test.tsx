import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextualLongTermOverviewDto, GatheringType } from '../../services/api';
import { individualsAPI, reportsAPI, settingsAPI } from '../../services/api';
import { readLongTermTrendsCache, writeLongTermTrendsCache } from '../../services/engagementReportCache';
import LongTermTrends from './LongTermTrends';
import { ReportPanelGrid } from './ReportPanelGrid';
import { defaultReportLayout } from './reportLayout';

const chartRender = vi.hoisted(() => vi.fn());

vi.mock('react-chartjs-2', () => ({
  Doughnut: () => <div aria-label="Regularity distribution" />,
  Line: (props: unknown) => { chartRender(props); return <div aria-label="Attendance direction chart" />; },
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
        comparison: { comparisonWeeks: 12, previousAverage: directionStatus === 'unavailable' ? null : 50, recentAverage: directionStatus === 'unavailable' ? null : 46.5, percentChange, status: directionStatus },
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

  it('requests canonical selected IDs and keeps the trends header concise', async () => {
    const gatherings = [selected(2, 'Evening'), selected(1, 'Morning')];
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview({ gatherings }) } as never);

    render(<LongTermTrends churchId="church-a" selectedGatherings={gatherings} canConfigure={false} />);

    await waitFor(() => expect(reportsAPI.getLongTermTrends).toHaveBeenCalledWith([1, 2]));
    expect(await screen.findByText(/based on 52 weeks of available attendance history/i)).toBeInTheDocument();
    expect(screen.getByText(/date range above does not affect these trends/i)).toBeInTheDocument();
    expect(screen.queryByText('Attendance at any selected gathering counts once per week.')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Long-term trends' }).parentElement).toHaveTextContent('Long-term trendsBased on 52 weeks of available attendance history.The date range above does not affect these trends.');
    expect(screen.queryByText('Completed-week view')).not.toBeInTheDocument();
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
    expect(screen.queryByText(/8 Feb 2026 – 23 Aug 2026/)).not.toBeInTheDocument();
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
    expect(screen.queryByLabelText('Attendance direction chart')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View attendance history' }));
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
    expect(screen.queryByLabelText('Regularity distribution')).not.toBeInTheDocument();
    first.unmount();

    const mixed = [selected(1, 'Sunday'), headcount];
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValueOnce({ data: overview({ gatherings: mixed }) } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={mixed} canConfigure={false} />);
    await screen.findByRole('region', { name: 'Regularity' });
    expect(screen.queryByText(/attendance direction includes all selected gatherings/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/person-level results use only the selected standard gathering/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Regularity distribution')).toBeInTheDocument();
  });

  it('opens a regularity tier as a focused full-width section below the regularity row', async () => {
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview() } as never);
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [{
      rowType: 'contextual_regularity', individualId: 1, firstName: 'Alex', lastName: 'Able', familyId: null,
      tier: 'core', rate: 75, evidence: { attendedWeeks: 9, opportunityWeeks: 12 },
    }], nextCursor: null } } as never);
    render(
      <ReportPanelGrid layout={defaultReportLayout()} editing={false} unavailable={{}} onReorder={vi.fn()} onHide={vi.fn()}>
        <LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} embedded />
      </ReportPanelGrid>,
    );

    const trigger = await screen.findByRole('button', { name: 'Core: 4 people (50%)' });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = await screen.findByRole('region', { name: 'Core people' });
    expect(within(panel).getByRole('list', { name: 'People' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Sort by name ascending' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Sort by attendance descending' })).toBeInTheDocument();
    expect(within(panel).getByText('9 of 12 weeks (75%)')).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Core people' })).toHaveFocus();
    expect(panel.closest('[data-report-panel="regularity"]')).toBeNull();
    expect(panel.parentElement).toHaveClass('lg:col-span-2');
    expect(panel.parentElement).toHaveStyle({ order: 14 });
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(trigger).toHaveFocus();
  });

  it('refreshes an expired regularity token and reopens the requested tier', async () => {
    const staleOverview = overview();
    const freshOverview = overview();
    freshOverview.regularity!.tiers = freshOverview.regularity!.tiers.map((tier) => (
      tier.tier === 'core' ? { ...tier, peopleToken: 'fresh-core-token' } : tier
    ));
    vi.mocked(reportsAPI.getLongTermTrends)
      .mockResolvedValueOnce({ data: staleOverview } as never)
      .mockResolvedValueOnce({ data: freshOverview } as never);
    vi.mocked(reportsAPI.getEngagementPeople)
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { data: { code: 'INVALID_DRILLDOWN_TOKEN' } },
      })
      .mockResolvedValueOnce({ data: { rows: [{
        rowType: 'contextual_regularity', individualId: 1, firstName: 'Alex', lastName: 'Able', familyId: null,
        tier: 'core', rate: 75, evidence: { attendedWeeks: 9, opportunityWeeks: 12 },
      }], nextCursor: null } } as never);

    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Core: 4 people (50%)' }));

    expect(await screen.findByText('Alex Able')).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Core people' });
    expect(reportsAPI.getLongTermTrends).toHaveBeenCalledTimes(2);
    expect(reportsAPI.getEngagementPeople).toHaveBeenLastCalledWith({
      segment: 'fresh-core-token', cursor: undefined, limit: 50,
    });
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
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

  it('limits the decline preview to four person cards and opens View all', async () => {
    const rows = declineRows(10);
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({
      data: { ...overview({ declines: rows }), declines: { total: 11, rows, peopleToken: 'decline-token' } },
    } as never);
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: { rows: [{
      rowType: 'contextual_decline', ...rows[0],
    }], nextCursor: null } } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    const declineRegion = await screen.findByRole('region', { name: 'People attending less often' });
    expect(within(declineRegion).getAllByRole('listitem')).toHaveLength(4);
    expect(within(declineRegion).getAllByText('Usually attends 3 weeks in 4; attended 1 of the last 6 weeks.')).toHaveLength(4);
    const viewAll = within(declineRegion).getByRole('button', { name: 'View all 11 people' });
    viewAll.focus();
    fireEvent.click(viewAll);
    const panel = await within(declineRegion).findByRole('region', { name: 'People attending less often' });
    expect(within(panel).getByRole('columnheader', { name: 'Recent attendance' })).toBeInTheDocument();
    expect(within(panel).getByText('1 of 6 recent weeks (16.7%)')).toBeInTheDocument();
  });

  it('switches between attendance changes with keyboard navigation and opens all increases', async () => {
    const row = { ...declineRows(1)[0], individualId: 99, firstName: 'Growing',
      baseline: { attendedWeeks: 1, opportunityWeeks: 6, rate: 16.7 },
      recent: { attendedWeeks: 5, opportunityWeeks: 6, rate: 83.3 },
      summary: 'Previously attended 1 week in 6; attended 5 of the last 6 weeks.' };
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: {
      ...overview(), increases: { total: 5, rows: [row], peopleToken: 'increase-token' },
    } } as never);
    vi.mocked(reportsAPI.getEngagementPeople).mockResolvedValue({ data: {
      rows: [{ rowType: 'contextual_increase', ...row }], nextCursor: null,
    } } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);
    const more = await screen.findByRole('tab', { name: 'Attending more often 5' });
    const less = screen.getByRole('tab', { name: 'Attending less often 1' });
    expect(less).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(less, { key: 'ArrowLeft' });
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Growing Example')).toBeInTheDocument();
    expect(screen.queryByText('Person1 Example')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View all 5 people' }));
    expect(await screen.findByText('5 of 6 recent weeks (83.3%)')).toBeInTheDocument();
    fireEvent.click(less);
    expect(screen.queryByText('Growing Example')).not.toBeInTheDocument();
  });

  it('shows separate gathering averages and changes instead of the combined average', async () => {
    const result = overview({ gatherings: [selected(1, 'Sunday'), selected(2, 'Youth')] });
    result.direction.series[0].comparison = { comparisonWeeks: 12, previousAverage: 100.4, recentAverage: 119.5, percentChange: 20, status: 'up' };
    result.direction.series[1].comparison = { comparisonWeeks: 12, previousAverage: 20, recentAverage: 10, percentChange: -50, status: 'down' };
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: result } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday'), selected(2, 'Youth')]} canConfigure={false} />);
    const sunday = await screen.findByRole('region', { name: 'Sunday attendance trend' });
    expect(within(sunday).getByText('120')).toBeInTheDocument();
    expect(within(sunday).getByText('100')).toBeInTheDocument();
    expect(within(sunday).getByText('↑ 20%')).toBeInTheDocument();
    const youth = screen.getByRole('region', { name: 'Youth attendance trend' });
    expect(within(youth).getByText('10')).toBeInTheDocument();
    expect(within(youth).getByText('↓ 50%')).toBeInTheDocument();
    expect(screen.queryByText('46.5')).not.toBeInTheDocument();
  });

  it('uses separate named Y scales and month labels while retaining exact dates in tooltips', async () => {
    const result = overview({ gatherings: [selected(1, 'Sunday'), selected(2, 'Youth')] });
    result.direction.series[0].buckets.forEach((bucket) => { bucket.averageAttendance = 200; });
    result.direction.series[1].buckets.forEach((bucket) => { bucket.averageAttendance = 20; });
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: result } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday'), selected(2, 'Youth')]} canConfigure={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View attendance history' }));
    const { data, options } = chartRender.mock.lastCall![0];
    expect(data.datasets.map((dataset: { yAxisID: string }) => dataset.yAxisID)).toEqual(['yRight', 'y']);
    expect(options.scales.y.title.text).toBe('Youth');
    expect(options.scales.yRight.title.text).toBe('Sunday');
    expect(options.scales.yRight.position).toBe('right');
    expect(data.labels[0]).toBe('Sept 2025');
    expect(options.scales.x.ticks.callback(1, 1)).toBe('');
    expect(options.plugins.tooltip.callbacks.title([{ datasetIndex: 0, dataIndex: 0 }])).toBe('1 Sept 2025 – 7 Sept 2025');
  });

  it('trims empty chart edges across gatherings while retaining internal gaps and zero attendance', async () => {
    const result = overview({ gatherings: [selected(1, 'Sunday'), selected(2, 'Youth')] });
    result.direction.series.forEach((series) => series.buckets.forEach((bucket) => {
      bucket.averageAttendance = null;
      bucket.heldSessions = 0;
    }));
    Object.assign(result.direction.series[0].buckets[4], { averageAttendance: 0, heldSessions: 1 });
    Object.assign(result.direction.series[1].buckets[6], { averageAttendance: 20, heldSessions: 1 });
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: result } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday'), selected(2, 'Youth')]} canConfigure={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View attendance history' }));
    const { data, options } = chartRender.mock.lastCall![0];
    expect(data.labels).toHaveLength(3);
    expect(data.labels[0]).toBe('Oct 2025');
    expect(data.datasets[0].data).toEqual([0, null, null]);
    expect(data.datasets[1].data).toEqual([null, null, 20]);
    expect(options.plugins.tooltip.callbacks.title([{ datasetIndex: 1, dataIndex: 2 }])).toBe('15 Oct 2025 – 21 Oct 2025');
  });

  it('does not show empty dates when no gathering has history', async () => {
    const result = overview();
    result.direction.series[0].buckets.forEach((bucket) => { bucket.averageAttendance = null; bucket.heldSessions = 0; });
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: result } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View attendance history' }));
    expect(chartRender.mock.lastCall![0].data.labels).toEqual([]);
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

  it('omits the missing attendance warning even when every classified tier is zero', async () => {
    const result = overview({ population: 3 });
    result.dataAvailability.unclassifiedBecauseNoEvidence = 3;
    result.regularity!.tiers = result.regularity!.tiers.map((tier) => ({ ...tier, count: 0, rate: 0 }));
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: result } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);

    await screen.findByRole('region', { name: 'Regularity' });
    expect(screen.queryByText(/could not be classified/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Core: 0 people (0%)' })).toBeInTheDocument();
  });

  it('shows attendance history without session selectors or session buttons', async () => {
    vi.mocked(reportsAPI.getLongTermTrends).mockResolvedValue({ data: overview() } as never);
    render(<LongTermTrends churchId="church-a" selectedGatherings={[selected(1, 'Sunday')]} canConfigure={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'View attendance history' }));
    const history = screen.getByRole('region', { name: 'Attendance history' });
    expect(within(history).getByLabelText('Attendance direction chart')).toBeInTheDocument();
    expect(within(history).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(history).queryByRole('button', { name: /attendance sessions/i })).not.toBeInTheDocument();
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
