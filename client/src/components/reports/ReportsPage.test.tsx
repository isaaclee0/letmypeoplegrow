import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ReportsPage from '../../pages/ReportsPage';
import { familiesAPI, gatheringsAPI, reportsAPI } from '../../services/api';

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
    expect(selectedPeriodTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Selected period' })).toHaveAttribute(
      'id',
      selectedPeriodTab.getAttribute('aria-controls'),
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Long-term health' }));

    expect(screen.getByRole('tab', { name: 'Long-term health' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('status', { name: 'Long-term health' })).toHaveTextContent(
      'Coming in the next implementation slice.',
    );
    expect(screen.queryByLabelText('Gathering Types')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('2026-07-20')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Pastoral care' }));

    expect(screen.getByRole('status', { name: 'Pastoral care' })).toHaveTextContent(
      'Coming in the next implementation slice.',
    );
  });
});
