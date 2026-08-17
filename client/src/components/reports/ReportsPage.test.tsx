import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReportsPage from '../../pages/ReportsPage';
import { familiesAPI, gatheringsAPI, reportsAPI } from '../../services/api';
import CaregiverPicker from './CaregiverPicker';

const { refreshUserData } = vi.hoisted(() => ({
  refreshUserData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: {
      id: 7,
      role: 'admin',
      church_id: 'test-church',
      gatheringAssignments: [{ id: 11 }, { id: 12 }],
    },
    refreshUserData,
  }),
}));

vi.mock('../../hooks/useChurchTime', () => ({
  useChurchTime: () => ({
    today: () => '2026-08-17',
    formatDateOnly: (value: string) => value,
  }),
}));

vi.mock('../../services/userPreferences', () => ({
  PREFERENCE_KEYS: {
    REPORTS_EXPORT_FORMAT: 'reports_export_format',
  },
  userPreferences: {
    getLocalPreference: vi.fn().mockReturnValue(null),
    getGatheringOrder: vi.fn().mockResolvedValue(null),
    getReportsLastViewed: vi.fn().mockResolvedValue(null),
    setReportsLastViewed: vi.fn().mockResolvedValue(undefined),
    setLocalPreference: vi.fn(),
  },
}));

vi.mock('../../utils/logger', () => ({
  default: {
    log: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('react-chartjs-2', () => ({
  Bar: () => <div aria-label="Report chart" />,
  Doughnut: () => <div aria-label="Primary tier distribution chart" />,
  Line: () => <div aria-label="Attendance trend chart" />,
}));

vi.mock('./AttendanceHistoryPopover', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../services/api', () => ({
  attendanceAPI: {
    get: vi.fn().mockResolvedValue({
      data: {
        attendanceList: [{
          id: 101,
          firstName: 'Alex',
          lastName: 'Example',
          familyId: 501,
          familyName: 'EXAMPLE, A',
          present: false,
        }],
        visitors: [],
      },
    }),
  },
  contactsAPI: { getAll: vi.fn().mockResolvedValue([]) },
  familiesAPI: {
    getCaregivers: vi.fn().mockResolvedValue([]),
    assignCaregiver: vi.fn(),
    removeCaregiver: vi.fn(),
  },
  gatheringsAPI: { getAll: vi.fn() },
  reportsAPI: {
    getDashboard: vi.fn(),
    getDismissals: vi.fn().mockResolvedValue({ data: { dismissals: [] } }),
    dismissAbsence: vi.fn(),
    exportData: vi.fn(),
    getEngagementOverview: vi.fn().mockRejectedValue(new Error('offline')),
    getEngagementPeople: vi.fn(),
    getEngagementSessions: vi.fn(),
  },
  settingsAPI: {},
  usersAPI: {
    getAll: vi.fn().mockResolvedValue({
      data: {
        users: [{
          id: 81,
          firstName: 'Jamie',
          lastName: 'Carer',
          email: 'jamie@example.test',
        }],
      },
    }),
  },
}));

const gatherings = [
  {
    id: 11,
    name: 'Sunday Morning',
    attendanceType: 'standard',
    frequency: 'weekly',
  },
  {
    id: 12,
    name: 'Sunday Evening',
    attendanceType: 'standard',
    frequency: 'weekly',
  },
];

describe('ReportsPage selected period workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.mocked(gatheringsAPI.getAll).mockResolvedValue({
      data: { gatherings },
    } as never);
    vi.mocked(reportsAPI.getDashboard).mockResolvedValue({
      data: {
        metrics: {
          averageAttendance: 28,
          growthRate: 3,
          totalVisitors: 0,
          totalLocalVisitors: 0,
          returningLocalVisitors: 0,
          attendanceData: [
            { date: '2026-08-16', gatheringId: 11, present: 28 },
            { date: '2026-08-09', gatheringId: 11, present: 27 },
            { date: '2026-08-02', gatheringId: 11, present: 26 },
          ],
        },
        gatheringNames: { 11: 'Sunday Morning' },
      },
    } as never);
    vi.mocked(familiesAPI.getCaregivers).mockResolvedValue([] as never);
    vi.mocked(familiesAPI.assignCaregiver).mockResolvedValue(undefined as never);
    vi.mocked(familiesAPI.removeCaregiver).mockResolvedValue(undefined as never);
  });

  it('keeps the current four-week report controls and follow-up workflow', async () => {
    render(<ReportsPage />);

    expect(await screen.findByRole('checkbox', { name: /Sunday Morning/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Sunday Evening/ })).not.toBeChecked();

    await waitFor(() => {
      expect(reportsAPI.getDashboard).toHaveBeenCalledWith({
        gatheringTypeIds: [11],
        startDate: '2026-07-20',
        endDate: '2026-08-17',
      });
    });

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Regulars With Recent Absences' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Assign caregiver' }));
    expect(await screen.findByRole('heading', { name: 'Caregivers' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Jamie Carer/ }));
    await waitFor(() => {
      expect(familiesAPI.assignCaregiver).toHaveBeenCalledWith(501, {
        caregiver_type: 'user',
        user_id: 81,
        contact_id: undefined,
      });
    });
  });

  it('switches between linked lazy tab panels without carrying selected-period controls forward', async () => {
    render(<ReportsPage />);

    const selectedPeriodTab = screen.getByRole('tab', { name: 'Selected period' });
    const longTermTab = screen.getByRole('tab', { name: 'Long-term health' });
    const pastoralCareTab = screen.getByRole('tab', { name: 'Pastoral care' });
    expect(selectedPeriodTab).toHaveAttribute('aria-selected', 'true');

    const selectedPeriodPanel = document.getElementById(selectedPeriodTab.getAttribute('aria-controls')!);
    const longTermPanel = document.getElementById(longTermTab.getAttribute('aria-controls')!);
    const pastoralCarePanel = document.getElementById(pastoralCareTab.getAttribute('aria-controls')!);
    expect(selectedPeriodPanel).toHaveAttribute('role', 'tabpanel');
    expect(selectedPeriodPanel).not.toHaveAttribute('hidden');
    expect(longTermPanel).toHaveAttribute('role', 'tabpanel');
    expect(longTermPanel).toHaveAttribute('hidden');
    expect(pastoralCarePanel).toHaveAttribute('role', 'tabpanel');
    expect(pastoralCarePanel).toHaveAttribute('hidden');

    fireEvent.click(longTermTab);

    expect(longTermTab).toHaveAttribute('aria-selected', 'true');
    expect(selectedPeriodPanel).toHaveAttribute('hidden');
    expect(longTermPanel).not.toHaveAttribute('hidden');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load long-term health');
    expect(screen.queryByText('Coming in the next implementation slice.')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Gathering Types')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('2026-07-20')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Pastoral care' }));

    expect(screen.getByRole('status', { name: 'Pastoral care' })).toHaveTextContent(
      'Coming in the next implementation slice.',
    );
  });

  it('keeps caregiver results and actions bound to the displayed family after a family switch', async () => {
    const familyACaregiver = {
      id: 901,
      caregiver_type: 'user' as const,
      user_id: 71,
      first_name: 'Family A',
      last_name: 'Caregiver',
      email: 'a@example.test',
      mobile_number: null,
    };
    const familyBCaregiver = {
      id: 902,
      caregiver_type: 'user' as const,
      user_id: 72,
      first_name: 'Family B',
      last_name: 'Caregiver',
      email: 'b@example.test',
      mobile_number: null,
    };
    let resolveFamilyA!: (caregivers: typeof familyACaregiver[]) => void;
    let resolveFamilyB!: (caregivers: typeof familyBCaregiver[]) => void;
    let familyBResolved = false;
    const familyARequest = new Promise<typeof familyACaregiver[]>((resolve) => {
      resolveFamilyA = resolve;
    });
    const familyBRequest = new Promise<typeof familyBCaregiver[]>((resolve) => {
      resolveFamilyB = resolve;
    });
    vi.mocked(familiesAPI.getCaregivers).mockImplementation((familyId) => {
      if (familyId === 501) return familyARequest as never;
      if (!familyBResolved) return familyBRequest as never;
      return Promise.resolve([familyBCaregiver]) as never;
    });
    const onClose = vi.fn();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <CaregiverPicker
        familyId={501}
        open
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
    await waitFor(() => expect(familiesAPI.getCaregivers).toHaveBeenCalledWith(501));

    rerender(
      <CaregiverPicker
        familyId={502}
        open
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
    await waitFor(() => expect(familiesAPI.getCaregivers).toHaveBeenCalledWith(502));

    familyBResolved = true;
    await act(async () => resolveFamilyB([familyBCaregiver]));
    expect(screen.getByText('Family B Caregiver')).toBeInTheDocument();

    await act(async () => resolveFamilyA([familyACaregiver]));
    expect(screen.queryByText('Family A Caregiver')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(familiesAPI.removeCaregiver).toHaveBeenCalledWith(502, 902);
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { action: 'add' as const },
    { action: 'remove' as const },
  ])('does not run parent effects when an in-flight $action finishes after switching families', async ({ action }) => {
    const familyACaregiver = {
      id: 911,
      caregiver_type: 'user' as const,
      user_id: 73,
      first_name: 'Family A',
      last_name: 'Caregiver',
      email: 'a@example.test',
      mobile_number: null,
    };
    const familyBCaregiver = {
      id: 912,
      caregiver_type: 'user' as const,
      user_id: 74,
      first_name: 'Family B',
      last_name: 'Caregiver',
      email: 'b@example.test',
      mobile_number: null,
    };
    vi.mocked(familiesAPI.getCaregivers).mockImplementation((familyId) => Promise.resolve(
      familyId === 501
        ? (action === 'remove' ? [familyACaregiver] : [])
        : [familyBCaregiver],
    ) as never);

    let resolveAction!: () => void;
    const actionRequest = new Promise<void>((resolve) => {
      resolveAction = resolve;
    });
    if (action === 'add') {
      vi.mocked(familiesAPI.assignCaregiver).mockReturnValue(actionRequest as never);
    } else {
      vi.mocked(familiesAPI.removeCaregiver).mockReturnValue(actionRequest as never);
    }

    let currentFamilyId = 501;
    const refreshedFamilyIds: number[] = [];
    let closed = false;
    const onChanged = () => {
      refreshedFamilyIds.push(currentFamilyId);
    };
    const onClose = () => {
      closed = true;
    };
    const { rerender } = render(
      <CaregiverPicker
        familyId={currentFamilyId}
        open
        onClose={onClose}
        onChanged={onChanged}
      />,
    );

    if (action === 'add') {
      const addButton = await screen.findByRole('button', { name: /Jamie Carer/ });
      await waitFor(() => expect(addButton).toBeEnabled());
      fireEvent.click(addButton);
      await waitFor(() => expect(familiesAPI.assignCaregiver).toHaveBeenCalled());
    } else {
      expect(await screen.findByText('Family A Caregiver')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      await waitFor(() => expect(familiesAPI.removeCaregiver).toHaveBeenCalledWith(501, 911));
    }

    currentFamilyId = 502;
    rerender(
      <CaregiverPicker
        familyId={currentFamilyId}
        open
        onClose={onClose}
        onChanged={onChanged}
      />,
    );
    expect(await screen.findByText('Family B Caregiver')).toBeInTheDocument();

    await act(async () => {
      resolveAction();
      await actionRequest;
      await Promise.resolve();
    });

    expect(refreshedFamilyIds).toEqual([]);
    expect(closed).toBe(false);
    expect(screen.getByText('Family B Caregiver')).toBeInTheDocument();
  });
});
