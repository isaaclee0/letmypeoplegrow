import React from 'react';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gatheringsAPI } from '../../services/api';
import GatheringWizard from './GatheringWizard';

function response<T>(data: T): AxiosResponse<T> {
  return { data, status: 200, statusText: 'OK', headers: {}, config: { headers: new AxiosHeaders() } };
}

vi.mock('../../services/api', () => ({
  gatheringsAPI: { create: vi.fn() },
}));

const createGathering = vi.mocked(gatheringsAPI.create);

async function enterName(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Gathering name'), 'Sunday Service');
}

async function chooseHeadcount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('radio', { name: /simple headcount/i }));
}

describe('GatheringWizard', () => {
  beforeEach(() => {
    createGathering.mockReset();
    createGathering.mockResolvedValue(response({ id: 42, message: 'Gathering type created', setAsDefault: false }));
  });

  it('validates the schedule, preserves the draft going back, and saves the standard defaults', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<GatheringWizard onCreated={onCreated} timeZone="Australia/Hobart" />);

    expect(screen.getByText(/Australia\/Hobart/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/gathering name/i);
    expect(createGathering).not.toHaveBeenCalled();
    await enterName(user);
    await user.selectOptions(screen.getByLabelText('Day of week'), 'Tuesday');
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '18:00' } });
    fireEvent.change(screen.getByLabelText('End time (optional)'), { target: { value: '20:15' } });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: /how will you take attendance/i })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Gathering name')).toHaveValue('Sunday Service');
    expect(screen.getByLabelText('Day of week')).toHaveValue('Tuesday');
    expect(screen.getByLabelText('End time (optional)')).toHaveValue('20:15');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: /track people by name/i }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('checkbox', { name: 'Group people into families' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Enable leader check-in' })).not.toBeChecked();
    expect(createGathering).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create gathering' }));

    expect(createGathering).toHaveBeenCalledWith({
      name: 'Sunday Service', attendanceType: 'standard', dayOfWeek: 'Tuesday',
      startTime: '18:00', endTime: '20:15', frequency: 'weekly',
      kioskEnabled: false, individualMode: false, leaderCheckinEnabled: false,
    });
    expect(onCreated).toHaveBeenCalledWith({ id: 42, name: 'Sunday Service', attendanceType: 'standard', individualMode: false });
  });

  it('applies explicitly chosen individual mode and leader check-in', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<GatheringWizard onCreated={onCreated} />);
    await enterName(user);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: 'Track people by name' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('checkbox', { name: 'Group people into families' }));
    await user.click(screen.getByRole('checkbox', { name: 'Enable leader check-in' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Create gathering' }));

    expect(createGathering).toHaveBeenCalledWith(expect.objectContaining({
      attendanceType: 'standard', individualMode: true, leaderCheckinEnabled: true, kioskEnabled: false,
    }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ individualMode: true }));
  });

  it('creates a headcount without opening family or check-in settings', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<GatheringWizard onCreated={onCreated} />);
    await enterName(user);
    await user.selectOptions(screen.getByLabelText('Frequency'), 'biweekly');
    await chooseHeadcount(user);
    expect(screen.queryByRole('checkbox', { name: 'Group people into families' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create gathering' }));
    expect(createGathering).toHaveBeenCalledWith(expect.objectContaining({
      attendanceType: 'headcount', frequency: 'biweekly', kioskEnabled: false,
    }));
    expect(onCreated).toHaveBeenCalledWith({ id: 42, name: 'Sunday Service', attendanceType: 'headcount' });
  });

  it('rejects impossible custom dates and submits the unique dates in order', async () => {
    const user = userEvent.setup();
    render(<GatheringWizard onCreated={vi.fn()} />);
    await enterName(user);
    await user.selectOptions(screen.getByLabelText('Frequency'), 'custom');
    await user.selectOptions(screen.getByLabelText('Custom schedule type'), 'dates');
    const dates = screen.getByLabelText('Dates (YYYY-MM-DD)');
    fireEvent.change(dates, { target: { value: '2027-02-29\n2027-03-01' } });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/valid date/i);

    fireEvent.change(dates, { target: { value: '2027-03-12\n2027-03-01\n2027-03-12' } });
    await chooseHeadcount(user);
    await user.click(screen.getByRole('button', { name: 'Create gathering' }));
    expect(createGathering).toHaveBeenCalledWith(expect.objectContaining({
      customSchedule: {
        type: 'recurring', startDate: '2027-03-01',
        pattern: { frequency: 'daily', interval: 1, customDates: ['2027-03-01', '2027-03-12'] },
      },
    }));
  });

  it('validates recurring dates and carries the selected pattern into the request', async () => {
    const user = userEvent.setup();
    render(<GatheringWizard onCreated={vi.fn()} />);
    await enterName(user);
    await user.selectOptions(screen.getByLabelText('Frequency'), 'custom');
    await user.selectOptions(screen.getByLabelText('Custom schedule type'), 'recurring');
    fireEvent.change(screen.getByLabelText('First date'), { target: { value: '2027-03-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-02-28' } });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/end date/i);
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2027-05-01' } });
    await user.selectOptions(screen.getByLabelText('Repeat'), 'monthly');
    fireEvent.change(screen.getByLabelText('Day of month'), { target: { value: '15' } });
    await chooseHeadcount(user);
    await user.click(screen.getByRole('button', { name: 'Create gathering' }));
    expect(createGathering).toHaveBeenCalledWith(expect.objectContaining({
      customSchedule: {
        type: 'recurring', startDate: '2027-03-01', endDate: '2027-05-01',
        pattern: { frequency: 'monthly', interval: 1, dayOfMonth: 15 },
      },
    }));
  });

  it('allows retry after a failed request and guards submission while saving', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    let rejectRequest!: (error: unknown) => void;
    createGathering.mockImplementationOnce(() => new Promise((_, reject) => { rejectRequest = reject; }));
    render(<GatheringWizard onCreated={onCreated} />);
    await enterName(user);
    await chooseHeadcount(user);
    const submit = screen.getByRole('button', { name: 'Create gathering' });
    const form = submit.closest('form')!;

    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(submit).toBeDisabled();
    expect(createGathering).toHaveBeenCalledTimes(1);
    await act(async () => rejectRequest({ response: { data: { error: 'Could not create this gathering' } } }));
    expect(screen.getByRole('alert')).toHaveTextContent('Could not create this gathering');
    expect(onCreated).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Create gathering' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(createGathering).toHaveBeenCalledTimes(2);
    expect(createGathering.mock.calls[1]).toEqual(createGathering.mock.calls[0]);
  });

  it('retries the continuation without creating a second gathering', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn().mockRejectedValueOnce(new Error('Could not update setup progress'));
    render(<GatheringWizard onCreated={onCreated} />);
    await enterName(user);
    await chooseHeadcount(user);
    await user.click(screen.getByRole('button', { name: 'Create gathering' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/gathering was saved/i);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onCreated).toHaveBeenCalledTimes(2);
    expect(createGathering).toHaveBeenCalledTimes(1);
  });
});
