import React from 'react';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { authAPI, type ChurchLocationResult } from '../services/api';
import SignupPage from './SignupPage';

vi.mock('../services/api', () => ({
  authAPI: {
    searchLocations: vi.fn(),
    register: vi.fn(),
    verifyCode: vi.fn(),
  },
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ login: async () => {} }),
}));

const auckland: ChurchLocationResult = {
  name: 'Auckland',
  admin1: null,
  country: 'New Zealand',
  countryCode: 'NZ',
  lat: -36.8485,
  lng: 174.7633,
  timezone: 'Pacific/Auckland',
  displayName: 'Auckland, New Zealand',
  source: 'open-meteo',
};
const details = {
  churchName: 'Test Church',
  email: 'new@example.com',
  firstName: 'New',
  lastName: 'Admin',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(authAPI.register).mockResolvedValue(response({ message: 'Account created' }));
});
afterEach(() => vi.unstubAllGlobals());

function response<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

function renderSignup() {
  render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/app" element={<p>Application entry</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillOrganisationDetails() {
  fireEvent.change(screen.getByLabelText(/organisation name/i), { target: { value: details.churchName } });
  fireEvent.change(screen.getByLabelText(/admin email/i), { target: { value: details.email } });
  fireEvent.change(screen.getByLabelText(/admin first name/i), { target: { value: details.firstName } });
  fireEvent.change(screen.getByLabelText(/admin last name/i), { target: { value: details.lastName } });
}

test('a keyboard-selected location is submitted and code verification enters through the app', async () => {
  const user = userEvent.setup();
  vi.mocked(authAPI.searchLocations).mockResolvedValue(response({ results: [auckland] }));
  vi.mocked(authAPI.verifyCode).mockResolvedValue(response({ token: 'test', user: {} }));
  renderSignup();
  const location = screen.getByRole('combobox', { name: /where is your church/i });
  await user.type(location, 'Auckland');
  await screen.findByRole('option', { name: auckland.displayName });
  await user.keyboard('{ArrowDown}{Enter}');
  expect(screen.getByRole('button', { name: 'Change location' })).toHaveFocus();
  fillOrganisationDetails();
  await user.click(screen.getByRole('button', { name: 'Set Up Organisation' }));
  expect(authAPI.register).toHaveBeenCalledWith({
    ...details,
    locationName: auckland.displayName,
    locationLat: auckland.lat,
    locationLng: auckland.lng,
    countryCode: auckland.countryCode,
  });

  await user.type(await screen.findByLabelText('Verification Code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Verify Code' }));
  expect(await screen.findByText('Application entry')).toBeInTheDocument();
});

test('search failure can be retried or explicitly skipped without blocking signup', async () => {
  const user = userEvent.setup();
  vi.mocked(authAPI.searchLocations)
    .mockRejectedValueOnce(new Error('Search unavailable'))
    .mockResolvedValue(response({ results: [] }));
  renderSignup();
  await user.type(screen.getByRole('combobox', { name: /where is your church/i }), 'Auckland');
  await screen.findByRole('button', { name: /retry/i });
  await user.click(screen.getByRole('button', { name: /retry/i }));
  expect(await screen.findByText(/no places found/i)).toBeInTheDocument();
  expect(authAPI.searchLocations).toHaveBeenNthCalledWith(2, 'Auckland');
  await user.click(screen.getByRole('button', { name: /set this later/i }));
  fillOrganisationDetails();
  await user.click(screen.getByRole('button', { name: 'Set Up Organisation' }));

  expect(authAPI.register).toHaveBeenCalledWith(details);
});

test('a slow response cannot replace results for a newer search', async () => {
  let resolveOld!: (value: AxiosResponse<{ results: ChurchLocationResult[] }>) => void;
  vi.mocked(authAPI.searchLocations).mockImplementation(query => query === 'Hobart'
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve(response({ results: [auckland] })));
  renderSignup();

  const location = screen.getByRole('combobox', { name: /where is your church/i });
  fireEvent.change(location, { target: { value: 'Hobart' } });
  await waitFor(() => expect(authAPI.searchLocations).toHaveBeenCalledWith('Hobart'));
  fireEvent.change(location, { target: { value: 'Auckland' } });
  await screen.findByRole('option', { name: auckland.displayName });
  await act(async () => {
    resolveOld(response({ results: [{ ...auckland, displayName: 'Hobart, Tasmania, Australia' }] }));
  });
  expect(screen.queryByRole('option', { name: /Hobart/ })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name: auckland.displayName })).toBeInTheDocument();
});
