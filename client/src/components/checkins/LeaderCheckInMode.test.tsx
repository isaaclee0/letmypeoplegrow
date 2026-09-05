import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as leaderCheckInModule from './LeaderCheckInMode';
import LeaderCheckInMode from './LeaderCheckInMode';
import { attendanceAPI, kioskAPI } from '../../services/api';

vi.mock('../../services/api', () => ({
  attendanceAPI: {
    getFull: vi.fn(),
  },
  kioskAPI: {
    getHistoryDetail: vi.fn(),
    addPersonToGathering: vi.fn(),
  },
  familiesAPI: {},
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, firstName: 'Leader', lastName: 'One' } }),
}));

const websocket = {
  socket: null,
  isConnected: false,
  sendAttendanceUpdate: vi.fn(),
  sendKioskAction: vi.fn(),
  onAttendanceUpdate: vi.fn(() => () => undefined),
  onKioskCheckout: vi.fn(() => () => undefined),
  onReconnect: vi.fn(() => () => undefined),
  broadcastKioskSelection: vi.fn(),
  clearKioskSelection: vi.fn(),
  onKioskSelectionChanged: vi.fn(() => () => undefined),
  onKioskSelectionCleared: vi.fn(() => () => undefined),
};

vi.mock('../../contexts/WebSocketContext', () => ({
  useWebSocket: () => websocket,
}));

vi.mock('../../hooks/useBadgeSettings', () => ({
  useBadgeSettings: () => ({ getBadgeInfo: () => null }),
}));

describe('Leader check-in roster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(kioskAPI.getHistoryDetail).mockResolvedValue({ data: { individuals: [] } } as never);
  });

  it('uses the same assigned and recent people returned for Attendance', () => {
    const buildRoster = (leaderCheckInModule as any).buildLeaderCheckInRoster;
    expect(buildRoster).toBeTypeOf('function');

    expect(buildRoster({
      attendanceList: [{ id: 1, firstName: 'Assigned', lastName: 'Regular', peopleType: 'regular' }],
      visitors: [{ id: 2, name: 'Assigned Visitor', visitorType: 'potential_regular' }],
      recentVisitors: [
        { id: 2, name: 'Assigned Visitor', visitorType: 'potential_regular' },
        { id: 3, name: 'Recent Visitor', visitorType: 'temporary_other' },
      ],
    }).map((person: any) => person.id)).toEqual([1, 2, 3]);
  });

  it('finds a church person and adds them to this gathering without checking them in', async () => {
    vi.mocked(attendanceAPI.getFull).mockResolvedValueOnce({
      data: {
        attendanceList: [],
        visitors: [],
        recentVisitors: [],
        allChurchPeople: [{
          id: 9,
          name: 'Morgan Field',
          familyId: 4,
          familyName: 'Field Family',
          visitorType: 'regular',
          isChild: false,
        }],
      },
    } as never);
    vi.mocked(kioskAPI.addPersonToGathering).mockResolvedValue({ data: {} } as never);

    render(
      <LeaderCheckInMode
        selectedGathering={{
          id: 7,
          name: 'Evening Service',
          attendanceType: 'standard',
          isActive: true,
        }}
        gatheringDate="2026-09-06"
        onBack={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /add someone from church/i }));
    fireEvent.change(screen.getByRole('searchbox', { name: /find someone in the church/i }), {
      target: { value: 'Morgan' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add Morgan Field to evening service/i }));

    await waitFor(() => {
      expect(kioskAPI.addPersonToGathering).toHaveBeenCalledWith(7, 9);
    });
    expect(await screen.findByRole('checkbox', { name: 'Morgan' })).not.toBeChecked();
    expect(websocket.sendKioskAction).not.toHaveBeenCalled();
  });
});
