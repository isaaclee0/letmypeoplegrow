import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CheckInHistory from './CheckInHistory';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'admin', timezone: 'Australia/Hobart' } }),
}));

vi.mock('../../services/api', () => ({
  kioskAPI: {
    getHistory: vi.fn().mockResolvedValue({ data: { sessions: [{ date: '2026-08-13', records: [] }] } }),
    getHistoryDetail: vi.fn().mockResolvedValue({ data: {
      date: '2026-08-13',
      individuals: [{
        individualId: 1,
        firstName: 'Ada',
        lastName: 'Lovelace',
        familyName: null,
        checkins: [{ time: '2026-08-13 02:15:00', signerName: null }],
        checkouts: [],
      }],
    } }),
    deleteSession: vi.fn(),
  },
}));

describe('CheckInHistory', () => {
  it('displays timestamps in the church timezone', async () => {
    render(<CheckInHistory gatheringId={1} gatheringName="Sunday" />);
    fireEvent.click(await screen.findByRole('button', { name: /Thursday, August 13, 2026/i }));
    expect(await screen.findByText(/12:15/)).toBeInTheDocument();
  });
});
