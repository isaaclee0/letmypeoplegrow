import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recordAttendanceViaRest,
  SessionExclusionControl,
  SessionStatusControl,
} from './AttendancePage';

vi.mock('../services/userPreferences', () => ({
  userPreferences: {},
  PREFERENCE_KEYS: {},
}));

describe('Attendance session status control', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the current state without management actions to attendance takers', () => {
    render(<SessionStatusControl status="open" canManage={false} onChange={vi.fn()} />);

    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('lets authorised users confirm held sessions without offering cancellation', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionStatusControl status="open" canManage onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm held' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('held'));
    expect(screen.queryByRole('button', { name: 'Cancel gathering' })).not.toBeInTheDocument();
  });

  it('uses one reversible Exclude action with clear confirmation copy', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onChange = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SessionExclusionControl excluded={false} canManage onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Exclude' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(true));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('will not affect reports or engagement calculations'));

    rerender(<SessionExclusionControl excluded canManage onChange={onChange} />);
    expect(screen.getByText(/excluded from reports and engagement calculations/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Include' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
  });

  it('applies the session state returned by a REST attendance write', async () => {
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
    const onSessionState = vi.fn();

    const result = await recordAttendanceViaRest(
      record,
      7,
      '2026-08-17',
      { attendanceRecords: [{ individualId: 5, present: true }], visitors: [] },
      onSessionState,
    );

    expect(result.sessionState).toEqual(heldState);
    expect(onSessionState).toHaveBeenCalledWith(heldState);
  });
});
