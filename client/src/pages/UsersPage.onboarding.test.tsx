import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { gatheringsAPI, usersAPI } from '../services/api';
import UsersPage from './UsersPage';

vi.mock('../contexts/AuthContext', () => {
  const user = { id: 1, role: 'admin' };
  return { useAuth: () => ({ user }) };
});
vi.mock('../services/api', () => ({
  contactsAPI: {},
  gatheringsAPI: { getAll: vi.fn() },
  usersAPI: { getAll: vi.fn() },
}));

const sendInvitation = vi.fn<typeof fetch>();

function response<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(usersAPI.getAll).mockResolvedValue(response({ users: [] }));
  vi.mocked(gatheringsAPI.getAll).mockResolvedValue(response({ gatherings: [{ id: 7, name: 'Sunday Service' }] }));
  vi.stubGlobal('fetch', sendInvitation);
});
afterEach(() => vi.unstubAllGlobals());

function Setup() {
  const { search } = useLocation();
  return <h1>{search === '?invited=1' ? 'Invitation confirmed in setup' : 'Back in setup'}</h1>;
}

function renderUsers(path = '/app/users?onboarding=1') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/users" element={<UsersPage />} />
        <Route path="/app/onboarding" element={<Setup />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillInviteForm(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole('dialog', { name: 'Invite New User' });
  await user.type(within(dialog).getByPlaceholderText('Enter first name'), 'Jordan');
  await user.type(within(dialog).getByPlaceholderText('Enter last name'), 'Example');
  await user.type(within(dialog).getByPlaceholderText('Enter email address'), 'jordan@example.com');
  await user.selectOptions(within(dialog).getByRole('combobox'), 'coordinator');
  await user.click(within(dialog).getByRole('checkbox', { name: 'Sunday Service' }));
  await user.click(within(dialog).getByRole('button', { name: 'Send Invitation' }));
  return screen.getByRole('dialog', { name: 'Confirm Invitation' });
}

test('the Users header offers a way back while the page is loading', async () => {
  const user = userEvent.setup();
  vi.mocked(usersAPI.getAll).mockReturnValue(new Promise(() => {}));
  renderUsers();

  await user.click(screen.getByRole('link', { name: 'Back to setup' }));
  expect(screen.getByRole('heading', { name: 'Back in setup' })).toBeInTheDocument();
  expect(sendInvitation).not.toHaveBeenCalled();
});

test('the invite form opens from onboarding and cancel returns without sending', async () => {
  const user = userEvent.setup();
  renderUsers();

  const dialog = await screen.findByRole('dialog', { name: 'Invite New User' });
  expect(screen.getByRole('link', { name: 'Back to setup' })).toHaveAttribute('href', '/app/onboarding');
  expect(sendInvitation).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('heading', { name: 'Back in setup' })).toBeInTheDocument();
  expect(sendInvitation).not.toHaveBeenCalled();
});

test('the user chooses the role and gathering, then confirms before the app sends', async () => {
  const user = userEvent.setup();
  sendInvitation.mockResolvedValue(Response.json({ message: 'Sent' }));
  renderUsers();

  const confirm = await fillInviteForm(user);
  expect(sendInvitation).not.toHaveBeenCalled();
  await user.click(within(confirm).getByRole('button', { name: 'Send Invitation' }));

  expect(await screen.findByRole('heading', { name: 'Invitation confirmed in setup' })).toBeInTheDocument();
  expect(sendInvitation).toHaveBeenCalledTimes(1);
  const [url, options] = sendInvitation.mock.calls[0];
  expect(url).toBe('/api/invitations/send');
  expect(options?.method).toBe('POST');
  expect(JSON.parse(options?.body as string)).toEqual({
    firstName: 'Jordan', lastName: 'Example', email: 'jordan@example.com', mobileNumber: '',
    primaryContactMethod: 'email', role: 'coordinator', gatheringIds: [7],
  });
});

test('a failed send keeps the invitation open with an error and allows a confirmed retry', async () => {
  const user = userEvent.setup();
  sendInvitation.mockResolvedValueOnce(Response.json({ error: 'This person already has an account.' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ message: 'Sent' }));
  renderUsers();

  const confirm = await fillInviteForm(user);
  await user.click(within(confirm).getByRole('button', { name: 'Send Invitation' }));

  const dialog = await screen.findByRole('dialog', { name: 'Invite New User' });
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('This person already has an account.');
  expect(within(dialog).getByPlaceholderText('Enter email address')).toHaveValue('jordan@example.com');
  expect(screen.queryByText(/invited successfully/i)).not.toBeInTheDocument();

  await user.click(within(dialog).getByRole('button', { name: 'Send Invitation' }));
  expect(sendInvitation).toHaveBeenCalledTimes(1);
  await user.click(within(screen.getByRole('dialog', { name: 'Confirm Invitation' })).getByRole('button', { name: 'Send Invitation' }));
  expect(await screen.findByRole('heading', { name: 'Invitation confirmed in setup' })).toBeInTheDocument();
  expect(sendInvitation).toHaveBeenCalledTimes(2);
});

test('ordinary Users entry leaves the existing invitation form closed', async () => {
  renderUsers('/app/users');

  await waitFor(() => expect(screen.getByRole('button', { name: 'Invite User' })).toBeInTheDocument());
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Back to setup' })).not.toBeInTheDocument();
});
