import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
  it.each([0, 53])('shows total %s when only another person has counted', async (total) => {
    vi.spyOn(attendanceAPI, 'getHeadcount').mockResolvedValue({ data: {
      headcount: total, userHeadcount: 0,
      otherUsers: [{ userId: 2, name: 'Peirce Baehr', headcount: total, isCurrentUser: false }],
    }} as any);
    const { container } = render(<HeadcountAttendanceInterface gatheringTypeId={3} date="2025-09-13" gatheringName="Hall" socket={null} isConnected={true} sendHeadcountUpdate={vi.fn()} />);
    await waitFor(() => {
      const label = screen.getByText('Total');
      expect(label.previousElementSibling).toHaveTextContent(String(total));
    });
    expect(container.querySelector('details')).toBeNull();
    expect(screen.queryByText('Peirce Baehr')).not.toBeInTheDocument();
    for (const counter of screen.getAllByRole('spinbutton')) expect(counter).toHaveValue(0);
  });

  it('keeps contributions collapsed until requested and resets on changing session', async () => {
    vi.spyOn(attendanceAPI, 'getHeadcount').mockResolvedValue({ data: {
      headcount: 12, userHeadcount: 3,
      otherUsers: [{userId:1,name:'You',headcount:3,isCurrentUser:true},{userId:2,name:'Peirce Baehr',headcount:9,isCurrentUser:false}],
    }} as any);
    const props = { gatheringTypeId: 3, date: '2025-09-12', gatheringName: 'Hall', socket: null, isConnected: true, sendHeadcountUpdate: vi.fn() };
    const { container, rerender } = render(<HeadcountAttendanceInterface {...props} />);
    await screen.findByText('Contributions (2)');
    const details = container.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Contributions (2)'));
    expect(details).toHaveAttribute('open');
    expect(screen.getByRole('table')).toBeVisible();
    expect(screen.getByRole('rowheader', {name:'Peirce Baehr'})).toBeVisible();
    expect(screen.getByTitle("Edit Peirce Baehr's headcount")).toBeVisible();
    rerender(<HeadcountAttendanceInterface {...props} date="2025-09-11" />);
    await screen.findByText('Contributions (2)');
    expect(container.querySelector('details')).not.toHaveAttribute('open');
  });

});
