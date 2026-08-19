import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attendanceAPI, type AttendanceSessionState } from '../services/api';
import HeadcountAttendanceInterface from './HeadcountAttendanceInterface';

const { authState } = vi.hoisted(() => ({
  authState: {
    user: { id: 1, role: 'admin' },
    isAuthenticated: true,
    isLoading: false,
  },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

describe('HeadcountAttendanceInterface session state', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the session state from a headcount read back to Attendance', async () => {
    const openState: AttendanceSessionState = {
      id: 12,
      gatheringTypeId: 3,
      sessionDate: '2026-08-17',
      status: 'open',
      rosterProvenanceVersion: 0,
      cancelledAt: null,
      cancelledBy: null,
    };
    vi.spyOn(attendanceAPI, 'getHeadcount').mockResolvedValue({
      data: {
        headcount: 0,
        userHeadcount: 0,
        otherUsers: [],
        sessionState: openState,
      },
    } as any);
    const onSessionStateChange = vi.fn();

    render(
      <HeadcountAttendanceInterface
        gatheringTypeId={3}
        date="2026-08-17"
        gatheringName="Evening service"
        onSessionStateChange={onSessionStateChange}
        socket={null}
        isConnected={false}
        sendHeadcountUpdate={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    await waitFor(() => expect(onSessionStateChange).toHaveBeenCalledWith(openState));
  });
});
