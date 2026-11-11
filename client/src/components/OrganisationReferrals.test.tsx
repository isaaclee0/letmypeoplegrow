import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { referralsAPI } from '../services/api';
import OrganisationReferrals from './OrganisationReferrals';

vi.mock('../services/api', () => ({ referralsAPI: { list: vi.fn(), send: vi.fn() } }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(referralsAPI.list).mockResolvedValue({ data: { referrals: [] } } as any);
});

test('an admin can send an invitation and see its pre-approved state', async () => {
  const user = userEvent.setup();
  render(<OrganisationReferrals />);
  await screen.findByText(/no referrals yet/i);
  vi.mocked(referralsAPI.send).mockResolvedValue({ data: { message: 'Invitation sent.' } } as any);
  vi.mocked(referralsAPI.list).mockResolvedValue({ data: { referrals: [{
    id: 1, email: 'new@example.com', status: 'pre_approved', expires_at: '2026-12-11 00:00:00',
    referrer_name: 'Test Admin', delivery_failed: 0,
  }] } } as any);
  await user.type(screen.getByLabelText('Email address'), 'new@example.com');
  await user.click(screen.getByRole('button', { name: 'Send invitation' }));
  expect(referralsAPI.send).toHaveBeenCalledWith('new@example.com');
  expect(await screen.findByRole('status')).toHaveTextContent('Invitation sent.');
  expect(await screen.findByText('Pre-approved')).toBeInTheDocument();
  expect(screen.getByLabelText('Email address')).toHaveValue('');
});

test('a failed invitation preserves the address for retry and shows the server error', async () => {
  const user = userEvent.setup();
  vi.mocked(referralsAPI.send).mockRejectedValue({ response: { data: { error: 'Email delivery failed. Try again.' } } });
  render(<OrganisationReferrals />);
  await user.type(screen.getByLabelText('Email address'), 'new@example.com');
  await user.click(screen.getByRole('button', { name: 'Send invitation' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Email delivery failed. Try again.');
  expect(screen.getByLabelText('Email address')).toHaveValue('new@example.com');
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('history errors offer retry without claiming there are no referrals', async () => {
  vi.mocked(referralsAPI.list).mockRejectedValueOnce(new Error('Offline'));
  render(<OrganisationReferrals />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i);
  expect(screen.queryByText(/no referrals yet/i)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByText(/no referrals yet/i)).toBeInTheDocument());
});
