import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStatusControl } from './AttendancePage';

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

  it('lets authorised users confirm, cancel, and restore while explaining report exclusion', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SessionStatusControl status="open" canManage onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Confirm held' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('held'));

    rerender(<SessionStatusControl status="held" canManage onChange={onChange} />);
    expect(screen.getByText(/Exclude from reports keeps a gathering/)).toBeInTheDocument();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel gathering' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('cancelled'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('does not delete attendance data'));

    rerender(<SessionStatusControl status="cancelled" canManage onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore gathering' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('open'));
  });

  it('shows the server activity-conflict message without changing or deleting data', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onChange = vi.fn().mockRejectedValue({
      response: {
        data: {
          error: 'Correct present attendance, headcount submissions, and check-in activity before cancelling this session.',
        },
      },
    });
    render(<SessionStatusControl status="held" canManage onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel gathering' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Correct present attendance');
    expect(screen.getByText('Held')).toBeInTheDocument();
  });
});
