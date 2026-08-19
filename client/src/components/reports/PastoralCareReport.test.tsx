import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngagementSettingsDto, PastoralInsightDto, PastoralInsightsDto } from '../../services/api';
import { contactsAPI, familiesAPI, reportsAPI, settingsAPI, usersAPI } from '../../services/api';
import {
  readPastoralInsightsCache,
  writePastoralInsightsCache,
} from '../../services/engagementReportCache';
import PastoralCareReport from './PastoralCareReport';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    contactsAPI: { ...actual.contactsAPI, getAll: vi.fn() },
    familiesAPI: {
      ...actual.familiesAPI,
      getCaregivers: vi.fn(),
      assignCaregiver: vi.fn(),
      removeCaregiver: vi.fn(),
    },
    reportsAPI: {
      ...actual.reportsAPI,
      getPastoralInsights: vi.fn(),
      applyPastoralInsightAction: vi.fn(),
    },
    settingsAPI: { ...actual.settingsAPI, getEngagementSettings: vi.fn() },
    usersAPI: { ...actual.usersAPI, getAll: vi.fn() },
  };
});

const settings: EngagementSettingsDto = {
  coreMinimum: 60,
  casualMinimum: 20,
  tiers: {
    core: { label: 'Core', colour: '#166534' },
    casual: { label: 'Casual', colour: '#b45309' },
    irregular: { label: 'Irregular', colour: '#b91c1c' },
  },
  gatheringRoles: [],
  calculationRulesVersion: 1,
  assignmentPreview: { primaryAssigned: 4, communityAssigned: 3, primaryNotAssigned: 1 },
};

const insight = (
  id: number,
  type: PastoralInsightDto['type'],
  overrides: Partial<PastoralInsightDto> = {},
): PastoralInsightDto => ({
  id,
  type,
  episodeKey: `${type}:${id}`,
  declineEventId: type === 'primary_decline' || type === 're_engagement' ? 80 + id : null,
  person: {
    id: 100 + id,
    firstName: ['Alex', 'Blair', 'Casey', 'Devon'][id - 1] || `Person${id}`,
    lastName: 'Example',
    peopleType: type === 'visitor_next_step' ? 'local_visitor' : 'regular',
    isActive: true,
  },
  family: { id: 500 + id, name: `Example Household ${id}` },
  lastAttendance: {
    individualId: 100 + id,
    date: '2026-08-10',
    gatheringTypeId: 9,
    gatheringName: 'Sunday Morning',
    engagementRole: 'primary',
  },
  profiles: {
    primary: { status: 'casual', attended: 12, opportunities: 40, rate: 0.3 },
    community: { status: 'core', attended: 18, opportunities: 20, rate: 0.9 },
  },
  evidence: type === 'primary_decline'
    ? { eventId: 80 + id, fromTier: 'core', toTier: 'casual', effectiveWeekEnd: '2026-08-09', detectedAt: '2026-08-10 08:00:00', recoveredAt: null }
    : type === 'community_primary_gap'
      ? { primaryTier: 'irregular', communityTier: 'core', completedWeekEnd: '2026-08-16' }
      : type === 'visitor_next_step'
        ? { firstPrimaryAttendanceDate: '2026-08-02', laterPrimaryAttendances: 0 }
        : { eventId: 80 + id, fromTier: 'core', toTier: 'irregular', effectiveWeekEnd: '2026-07-26', recoveredAt: '2026-08-10 09:00:00' },
  caregivers: [{
    assignmentId: 700 + id,
    type: 'user',
    id: 900 + id,
    firstName: 'Jordan',
    lastName: `Carer ${id}`,
    email: 'jordan@example.test',
    isActive: true,
  }],
  deliverySummary: type === 'primary_decline'
    ? { pending: 1, delivered: 2, cancelled: 0 }
    : { pending: 0, delivered: 0, cancelled: 0 },
  workflow: {
    state: 'open',
    snoozedUntil: null,
    actedBy: null,
    createdAt: '2026-08-17 08:00:00',
    updatedAt: '2026-08-17 08:00:00',
  },
  ...overrides,
});

const queue = (
  insights: PastoralInsightDto[] = [
    insight(1, 'primary_decline'),
    insight(2, 'community_primary_gap', {
      profiles: {
        primary: { status: 'irregular', attended: 2, opportunities: 16, rate: 0.125 },
        community: { status: 'core', attended: 14, opportunities: 16, rate: 0.875 },
      },
    }),
    insight(3, 'visitor_next_step', {
      profiles: {
        primary: { status: 'establishing', attended: 1, opportunities: 3, rate: 1 / 3 },
        community: { status: 'not_assigned', attended: 0, opportunities: 0, rate: null },
      },
    }),
    insight(4, 're_engagement', {
      profiles: {
        primary: { status: 'casual', attended: 16, opportunities: 40, rate: 0.4 },
        community: { status: 'not_assigned', attended: 0, opportunities: 0, rate: null },
      },
    }),
  ],
  churchId = 'church-a',
): PastoralInsightsDto => ({
  schemaVersion: 1,
  churchId,
  window: { completedWeekEnd: '2026-08-16' },
  insights,
});

function keepPending(): Promise<never> {
  return new Promise(() => undefined);
}

describe('PastoralCareReport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    vi.mocked(settingsAPI.getEngagementSettings).mockResolvedValue({ data: { settings } } as never);
    vi.mocked(familiesAPI.getCaregivers).mockResolvedValue([] as never);
    vi.mocked(familiesAPI.assignCaregiver).mockResolvedValue({} as never);
    vi.mocked(familiesAPI.removeCaregiver).mockResolvedValue({} as never);
    vi.mocked(contactsAPI.getAll).mockResolvedValue([] as never);
    vi.mocked(usersAPI.getAll).mockResolvedValue({ data: { users: [] } } as never);
  });

  it('renders every insight as factual evidence with both axes and caregiver context', async () => {
    vi.mocked(reportsAPI.getPastoralInsights).mockResolvedValue({ data: queue() } as never);

    render(<PastoralCareReport churchId="church-a" />);

    expect(await screen.findByRole('heading', { name: 'Pastoral care' })).toBeInTheDocument();
    const decline = screen.getByRole('article', { name: 'Alex Example' });
    expect(within(decline).getByText('Recent Primary tier decline')).toBeInTheDocument();
    expect(within(decline).getByText('Primary changed from Core to Casual')).toBeInTheDocument();
    expect(within(decline).getByText('12 of 40 opportunities (30%)')).toBeInTheDocument();
    expect(within(decline).getByText('18 of 20 opportunities (90%)')).toBeInTheDocument();
    expect(within(decline).getByText(/Jordan Carer 1/)).toBeInTheDocument();
    expect(within(decline).getByText('Caregiver email: 1 pending, 2 delivered, 0 cancelled')).toBeInTheDocument();
    expect(within(decline).getByText('New')).toBeInTheDocument();
    expect(within(decline).getByText(/Last attendance: 10 Aug 2026 at Sunday Morning/)).toBeInTheDocument();

    expect(within(screen.getByRole('article', { name: 'Blair Example' }))
      .getByText('Community is Core while Primary is Irregular')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Casey Example' }))
      .getByText('First Primary attendance on 2 Aug 2026; no later Primary attendance')).toBeInTheDocument();
    const reEngagement = screen.getByRole('article', { name: 'Devon Example' });
    expect(within(reEngagement).getByText('Primary is now above the Irregular decline tier')).toBeInTheDocument();
    expect(within(reEngagement).queryByText(/caregiver email/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/risk score|motivation|wellbeing/i)).not.toBeInTheDocument();
  });

  it('does not invent a later-attendance count when visitor evidence is incomplete', async () => {
    vi.mocked(reportsAPI.getPastoralInsights).mockResolvedValue({ data: queue([
      insight(3, 'visitor_next_step', {
        evidence: { firstPrimaryAttendanceDate: '2026-08-02' },
      }),
    ]) } as never);

    render(<PastoralCareReport churchId="church-a" />);

    const card = await screen.findByRole('article', { name: 'Casey Example' });
    expect(within(card).getByText('Visitor attendance evidence is unavailable.')).toBeInTheDocument();
    expect(within(card).queryByText(/0 later Primary attendances/)).not.toBeInTheDocument();
  });

  it.each([
    ['visitor count', insight(3, 'visitor_next_step', { evidence: { firstPrimaryAttendanceDate: '2026-08-02' } })],
    ['visitor date', insight(3, 'visitor_next_step', { evidence: { firstPrimaryAttendanceDate: '2026-02-30', laterPrimaryAttendances: 0 } })],
    ['decline tier', insight(1, 'primary_decline', { evidence: { eventId: 81, fromTier: 'unknown', toTier: 'casual', effectiveWeekEnd: '2026-08-09', detectedAt: '2026-08-10 08:00:00', recoveredAt: null } })],
    ['community completed week', insight(2, 'community_primary_gap', { evidence: { primaryTier: 'irregular', communityTier: 'core' } })],
    ['re-engagement event ID', insight(4, 're_engagement', { evidence: { eventId: '84', fromTier: 'core', toTier: 'irregular', effectiveWeekEnd: '2026-07-26', recoveredAt: '2026-08-10 09:00:00' } })],
  ])('rejects cached pastoral data with invalid discriminated %s evidence', (_field, malformed) => {
    localStorage.setItem('pastoral-insights:v1:church-a', JSON.stringify({
      cachedAt: Date.now(),
      data: queue([malformed]),
    }));

    expect(readPastoralInsightsCache('church-a')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('shows an Unassigned person without offering family caregiver management', async () => {
    vi.mocked(reportsAPI.getPastoralInsights).mockResolvedValue({ data: queue([
      insight(1, 'primary_decline', { family: null, caregivers: [] }),
    ]) } as never);
    render(<PastoralCareReport churchId="church-a" />);

    const card = await screen.findByRole('article', { name: 'Alex Example' });
    expect(within(card).getByText('No family assigned')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Manage caregivers' })).not.toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'View person' })).toHaveAttribute(
      'href',
      '/app/people?search=Alex%20Example',
    );
  });

  it('shows loading, empty, and uncached error states', async () => {
    vi.mocked(reportsAPI.getPastoralInsights).mockReturnValueOnce(keepPending() as never);
    const loading = render(<PastoralCareReport churchId="church-a" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading pastoral care…');
    loading.unmount();

    vi.mocked(reportsAPI.getPastoralInsights).mockResolvedValueOnce({ data: queue([]) } as never);
    const empty = render(<PastoralCareReport churchId="church-a" />);
    expect(await screen.findByText('No pastoral care follow-up is currently open.')).toBeInTheDocument();
    empty.unmount();
    localStorage.clear();

    vi.mocked(reportsAPI.getPastoralInsights).mockRejectedValueOnce(new Error('offline'));
    render(<PastoralCareReport churchId="church-a" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load pastoral care. Please try again.');
  });

  it('renders a fresh church-scoped cache immediately, warns on refresh failure, and expires it after five minutes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T02:00:00.000Z'));
    writePastoralInsightsCache(queue([insight(1, 'primary_decline')]));
    vi.mocked(reportsAPI.getPastoralInsights).mockRejectedValue(new Error('offline'));
    vi.mocked(settingsAPI.getEngagementSettings).mockReturnValue(keepPending() as never);

    const cached = render(<PastoralCareReport churchId="church-a" />);
    expect(screen.getByRole('article', { name: 'Alex Example' })).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh pastoral care. You are showing saved data.');
    cached.unmount();

    vi.setSystemTime(new Date('2026-08-19T02:05:01.000Z'));
    vi.mocked(reportsAPI.getPastoralInsights).mockReturnValue(keepPending() as never);
    render(<PastoralCareReport churchId="church-a" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading pastoral care…');
    expect(screen.queryByRole('article', { name: 'Alex Example' })).not.toBeInTheDocument();
  });

  it('ignores stale responses and cached data when the church changes', async () => {
    writePastoralInsightsCache(queue([insight(1, 'primary_decline')], 'church-a'));
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    vi.mocked(reportsAPI.getPastoralInsights)
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }) as never)
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }) as never);
    const { rerender } = render(<PastoralCareReport churchId="church-a" />);
    expect(screen.getByText('Alex Example')).toBeInTheDocument();

    rerender(<PastoralCareReport churchId="church-b" />);
    expect(screen.queryByText('Alex Example')).not.toBeInTheDocument();
    await act(async () => resolveB({ data: queue([insight(2, 'community_primary_gap')], 'church-b') }));
    expect(await screen.findByText('Blair Example')).toBeInTheDocument();
    await act(async () => resolveA({ data: queue([insight(1, 'primary_decline')], 'church-a') }));
    expect(screen.getByText('Blair Example')).toBeInTheDocument();
    expect(screen.queryByText('Alex Example')).not.toBeInTheDocument();
  });

  it('removes expired and recovered cached episodes when the authoritative refresh omits them', async () => {
    writePastoralInsightsCache(queue([
      insight(1, 'primary_decline', { person: { id: 101, firstName: 'Recovered', lastName: 'Regular', peopleType: 'regular', isActive: true } }),
      insight(3, 'visitor_next_step', { person: { id: 103, firstName: 'Expired', lastName: 'Visitor', peopleType: 'local_visitor', isActive: true } }),
    ]));
    let resolveRefresh!: (value: unknown) => void;
    vi.mocked(reportsAPI.getPastoralInsights).mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }) as never);
    render(<PastoralCareReport churchId="church-a" />);
    expect(screen.getByText('Recovered Regular')).toBeInTheDocument();
    expect(screen.getByText('Expired Visitor')).toBeInTheDocument();

    await act(async () => resolveRefresh({ data: queue([]) }));
    await waitFor(() => expect(screen.queryByText('Recovered Regular')).not.toBeInTheDocument());
    expect(screen.queryByText('Expired Visitor')).not.toBeInTheDocument();
  });

  it('snoozes to the selected date, replaces the row, and offers reopen', async () => {
    const original = insight(1, 'primary_decline');
    const snoozed = insight(1, 'primary_decline', {
      workflow: { ...original.workflow, state: 'snoozed', snoozedUntil: '2026-08-30' },
    });
    vi.mocked(reportsAPI.getPastoralInsights)
      .mockResolvedValueOnce({ data: queue([original]) } as never)
      .mockReturnValue(keepPending() as never);
    vi.mocked(reportsAPI.applyPastoralInsightAction).mockResolvedValue({ data: { insight: snoozed } } as never);
    render(<PastoralCareReport churchId="church-a" />);

    const card = await screen.findByRole('article', { name: 'Alex Example' });
    fireEvent.click(within(card).getByRole('button', { name: 'Snooze' }));
    const dialog = screen.getByRole('dialog', { name: 'Snooze Alex Example' });
    fireEvent.change(within(dialog).getByLabelText('Snooze until'), { target: { value: '2026-08-30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm snooze' }));

    expect(await within(card).findByText('Snoozed until 30 Aug 2026')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(reportsAPI.applyPastoralInsightAction).toHaveBeenCalledWith(1, {
      action: 'snooze', snoozeUntil: '2026-08-30',
    });
    expect(reportsAPI.getPastoralInsights).toHaveBeenLastCalledWith({ includeSnoozed: true });
  });

  it('keeps successful concurrent actions for different insights and applies only the latest refresh', async () => {
    const first = insight(1, 'primary_decline', {
      workflow: { ...insight(1, 'primary_decline').workflow, state: 'snoozed', snoozedUntil: '2026-08-30' },
    });
    const second = insight(2, 'community_primary_gap', {
      workflow: { ...insight(2, 'community_primary_gap').workflow, state: 'snoozed', snoozedUntil: '2026-08-31' },
    });
    const reopenedFirst = insight(1, 'primary_decline');
    const reopenedSecond = insight(2, 'community_primary_gap');
    let resolveFirstAction!: (value: unknown) => void;
    let resolveSecondAction!: (value: unknown) => void;
    let resolveFirstRefresh!: (value: unknown) => void;
    let resolveSecondRefresh!: (value: unknown) => void;
    vi.mocked(reportsAPI.getPastoralInsights)
      .mockResolvedValueOnce({ data: queue([first, second]) } as never)
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirstRefresh = resolve; }) as never)
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecondRefresh = resolve; }) as never);
    vi.mocked(reportsAPI.applyPastoralInsightAction).mockImplementation((id) => new Promise((resolve) => {
      if (id === first.id) resolveFirstAction = resolve;
      else resolveSecondAction = resolve;
    }) as never);
    render(<PastoralCareReport churchId="church-a" />);
    const firstCard = await screen.findByRole('article', { name: 'Alex Example' });
    const secondCard = screen.getByRole('article', { name: 'Blair Example' });

    fireEvent.click(within(firstCard).getByRole('button', { name: 'Reopen' }));
    fireEvent.click(within(secondCard).getByRole('button', { name: 'Reopen' }));
    await act(async () => resolveSecondAction({ data: { insight: reopenedSecond } }));
    expect(within(secondCard).getByText('New')).toBeInTheDocument();
    await act(async () => resolveFirstAction({ data: { insight: reopenedFirst } }));
    expect(within(firstCard).getByText('New')).toBeInTheDocument();

    await act(async () => resolveFirstRefresh({ data: queue([first, second]) }));
    expect(within(firstCard).getByText('New')).toBeInTheDocument();
    expect(within(secondCard).getByText('New')).toBeInTheDocument();
    await act(async () => resolveSecondRefresh({ data: queue([]) }));
    expect(await screen.findByText('No pastoral care follow-up is currently open.')).toBeInTheDocument();
  });

  it('persists an action result before a failed refresh so remount does not restore stale workflow', async () => {
    const snoozed = insight(1, 'primary_decline', {
      workflow: { ...insight(1, 'primary_decline').workflow, state: 'snoozed', snoozedUntil: '2026-08-30' },
    });
    const reopened = insight(1, 'primary_decline');
    vi.mocked(reportsAPI.getPastoralInsights)
      .mockResolvedValueOnce({ data: queue([snoozed]) } as never)
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(keepPending() as never);
    vi.mocked(reportsAPI.applyPastoralInsightAction).mockResolvedValue({ data: { insight: reopened } } as never);
    vi.mocked(settingsAPI.getEngagementSettings).mockReturnValue(keepPending() as never);
    const mounted = render(<PastoralCareReport churchId="church-a" />);
    const card = await screen.findByRole('article', { name: 'Alex Example' });
    fireEvent.click(within(card).getByRole('button', { name: 'Reopen' }));
    expect(await within(card).findByText('New')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh pastoral care');
    mounted.unmount();

    render(<PastoralCareReport churchId="church-a" />);

    const restored = screen.getByRole('article', { name: 'Alex Example' });
    expect(within(restored).getByText('New')).toBeInTheDocument();
    expect(within(restored).queryByText(/Snoozed until/)).not.toBeInTheDocument();
  });

  it('renders fresh server data when pastoral cache persistence is unavailable', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });
    vi.mocked(reportsAPI.getPastoralInsights).mockResolvedValue({ data: queue([
      insight(1, 'primary_decline'),
    ]) } as never);
    try {
      render(<PastoralCareReport churchId="church-a" />);

      expect(await screen.findByRole('article', { name: 'Alex Example' })).toBeInTheDocument();
      expect(screen.queryByText('Could not load pastoral care. Please try again.')).not.toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });

  it('requires accessible dismissal confirmation, restores focus on Escape, and replaces dismissed and reopened rows', async () => {
    const original = insight(1, 'primary_decline');
    const dismissed = insight(1, 'primary_decline', {
      workflow: { ...original.workflow, state: 'dismissed', snoozedUntil: null },
    });
    vi.mocked(reportsAPI.getPastoralInsights)
      .mockResolvedValueOnce({ data: queue([original]) } as never)
      .mockReturnValue(keepPending() as never);
    vi.mocked(reportsAPI.applyPastoralInsightAction).mockImplementation((_id, action) => Promise.resolve({
      data: { insight: action.action === 'reopen' ? original : dismissed },
    }) as never);
    render(<PastoralCareReport churchId="church-a" />);
    const card = await screen.findByRole('article', { name: 'Alex Example' });
    const trigger = within(card).getByRole('button', { name: 'Dismiss' });
    trigger.focus();
    fireEvent.click(trigger);
    let dialog = screen.getByRole('dialog', { name: "Dismiss Alex Example's insight?" });
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Keep insight' })).toHaveFocus());
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: "Dismiss Alex Example's insight?" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(reportsAPI.applyPastoralInsightAction).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    dialog = screen.getByRole('dialog', { name: "Dismiss Alex Example's insight?" });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Dismiss insight' }));
    expect(await within(card).findByText('Dismissed')).toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'Reopen' }));
    expect(await within(card).findByText('New')).toBeInTheDocument();
    expect(reportsAPI.applyPastoralInsightAction).toHaveBeenNthCalledWith(1, 1, { action: 'dismiss' });
    expect(reportsAPI.applyPastoralInsightAction).toHaveBeenNthCalledWith(2, 1, { action: 'reopen' });
  });

  it('uses the shared family caregiver picker and refreshes the card summary after a change', async () => {
    const original = insight(1, 'primary_decline');
    const changed = insight(1, 'primary_decline', {
      caregivers: [{
        assignmentId: 799,
        type: 'user',
        id: 999,
        firstName: 'Taylor',
        lastName: 'Shepherd',
        email: 'taylor@example.test',
        isActive: true,
      }],
    });
    vi.mocked(reportsAPI.getPastoralInsights)
      .mockResolvedValueOnce({ data: queue([original]) } as never)
      .mockResolvedValueOnce({ data: queue([changed]) } as never);
    vi.mocked(familiesAPI.getCaregivers).mockResolvedValue([] as never);
    vi.mocked(usersAPI.getAll).mockResolvedValue({ data: { users: [{
      id: 999, firstName: 'Taylor', lastName: 'Shepherd', email: 'taylor@example.test',
    }] } } as never);
    render(<PastoralCareReport churchId="church-a" />);
    const card = await screen.findByRole('article', { name: 'Alex Example' });
    fireEvent.click(within(card).getByRole('button', { name: 'Manage caregivers' }));
    const picker = await screen.findByRole('dialog', { name: 'Caregivers' });
    fireEvent.click(await within(picker).findByRole('button', { name: /Taylor Shepherd/ }));

    await waitFor(() => expect(familiesAPI.assignCaregiver).toHaveBeenCalledWith(501, {
      caregiver_type: 'user', user_id: 999, contact_id: undefined,
    }));
    expect(await within(card).findByText(/Taylor Shepherd/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Caregivers' })).not.toBeInTheDocument();
  });
});
