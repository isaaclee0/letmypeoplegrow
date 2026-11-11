import React from 'react';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attendanceAPI, authAPI, gatheringsAPI, settingsAPI } from '../services/api';
import ToastContainer from '../components/ToastContainer';
import AttendancePage, { recordAttendanceViaRest } from './AttendancePage';

function response<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

const auth = vi.hoisted(() => ({
  user: { id: 1, role: 'admin', gatheringAssignments: [{ id: 7 }, { id: 22 }] },
  refreshUserData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({
    isConnected: false,
    isOfflineMode: false,
    onReconnect: () => () => {},
  }),
}));

vi.mock('../services/userPreferences', () => ({
  userPreferences: {
    getAttendanceLastViewed: vi.fn().mockResolvedValue({ gatheringId: 7, date: '2027-03-01' }),
    getGatheringOrder: vi.fn().mockResolvedValue(null),
    setAttendanceLastViewed: vi.fn().mockResolvedValue(undefined),
    setAttendanceGatheringDate: vi.fn().mockResolvedValue(undefined),
  },
  PREFERENCE_KEYS: {},
}));

describe('REST attendance writes', () => {
  it('returns the saved attendance response', async () => {
    const heldState = {
      id: 42,
      gatheringTypeId: 7,
      sessionDate: '2026-08-17',
      status: 'held' as const,
      rosterProvenanceVersion: 1,
      cancelledAt: null,
      cancelledBy: null,
    };
    const record = vi.fn().mockResolvedValue({
      data: { message: 'Attendance recorded successfully', sessionState: heldState },
    });
    const result = await recordAttendanceViaRest(
      record,
      7,
      '2026-08-17',
      { attendanceRecords: [{ individualId: 5, present: true }], visitors: [] },
    );

    expect(result.sessionState).toEqual(heldState);
  });
});

describe('Attendance setup handoff', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('opens the requested assigned gathering on its custom date despite a saved last-viewed gathering', async () => {
    vi.spyOn(authAPI, 'getServerTime').mockResolvedValue(response({ serverTime: Date.now() }));
    vi.spyOn(settingsAPI, 'getBadgeDefaults').mockResolvedValue(response({ settings: {} }));
    vi.spyOn(gatheringsAPI, 'getAll').mockResolvedValue(response({
      gatherings: [
        { id: 7, name: 'Sunday service', attendanceType: 'standard', dayOfWeek: 'Sunday', frequency: 'weekly', isActive: true },
        { id: 22, name: 'Holiday club', attendanceType: 'standard', isActive: true, customSchedule: { type: 'one_off', startDate: '2027-03-03' } },
      ],
    }));
    vi.spyOn(attendanceAPI, 'getSessionDates').mockResolvedValue(response({ dates: [] }));
    const getAttendance = vi.spyOn(attendanceAPI, 'getFull').mockResolvedValue(response({ attendanceList: [], visitors: [] }));
    render(
      <MemoryRouter initialEntries={['/app/attendance?gathering=22']}>
        <ToastContainer><AttendancePage /></ToastContainer>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByRole('combobox')).toHaveValue('22'));
    await waitFor(() => expect(getAttendance).toHaveBeenCalledWith(22, '2027-03-03'));
    expect(screen.getByRole('button', { name: 'Choose meeting date' })).toBeVisible();
  });
});
