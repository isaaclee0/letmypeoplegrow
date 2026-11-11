import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import AddPeopleModal from './AddPeopleModal';
const { copyPaste, updateExisting, createPerson, createFamily, deletePerson, deleteFamily, massAssign } = vi.hoisted(() => ({
  copyPaste: vi.fn(), updateExisting: vi.fn(), createPerson: vi.fn(), createFamily: vi.fn(),
  deletePerson: vi.fn(), deleteFamily: vi.fn(), massAssign: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  individualsAPI: { create: createPerson, delete: deletePerson },
  familiesAPI: { create: createFamily, delete: deleteFamily },
  csvImportAPI: { copyPaste, updateExisting, massAssign },
}));
const gathering = { id: 7, name: 'Sunday', dayOfWeek: 'Sunday', startTime: '10:00', frequency: 'weekly', attendanceType: 'standard' as const };
const existingPerson = { id: 1, firstName: 'Jane', lastName: 'Smith', peopleType: 'regular' as const };
const header = 'FIRST NAME,LAST NAME,FAMILY NAME,GATHERINGS,ADULT/CHILD';
const existingRow = 'Jane,Smith,"Smith, Jane",Sunday,Adult';
const mixed = `${header}\n${existingRow}\nPat,Ng,Ng,Sunday,Child`;

beforeEach(() => {
  vi.resetAllMocks();
  copyPaste.mockResolvedValue({ data: { imported: 1, duplicates: 0, skipped: 0 } });
  updateExisting.mockResolvedValue({ data: { updated: 1 } });
  createFamily.mockResolvedValue({ data: { id: 11 } });
  createPerson.mockResolvedValue({ data: { id: 12 } });
  massAssign.mockResolvedValue({ data: {} });
});

async function loadSpreadsheet(csv: string) {
  await userEvent.upload(screen.getByLabelText(/Select .*File/i), new File([csv], 'people.csv', { type: 'text/csv' }));
  const preview = await screen.findByPlaceholderText('CSV data will appear here...');
  await waitFor(() => expect(preview).toHaveValue(csv));
  return preview;
}

it('embeds manual entry with the onboarding gathering already selected', () => {
  render(<AddPeopleModal isOpen embedded initialGatheringId={7} onClose={vi.fn()} onSuccess={vi.fn()} people={[]} gatheringTypes={[gathering]} />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /Sunday/ })).toBeChecked();
});

it('sends the same normalized CSV columns shown in the file preview', async () => {
  const complete = vi.fn();
  render(<AddPeopleModal isOpen embedded initialMethod="csv" onClose={vi.fn()} onSuccess={complete} people={[]} gatheringTypes={[gathering]} />);
  const csv = 'FIRST NAME,LAST NAME,FAMILY NAME,GATHERINGS,ADULT/CHILD\nJane,Smith,"Smith, Jane",Sunday,Adult';
  await loadSpreadsheet(csv);
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));
  await waitFor(() => expect(copyPaste).toHaveBeenCalledWith('FIRST NAME\tLAST NAME\tFAMILY NAME\tGATHERINGS\tADULT/CHILD\nJane\tSmith\tSmith, Jane\tSunday\tAdult'));
  await waitFor(() => expect(complete).toHaveBeenCalled());
});

it('adds new rows in a mixed file through duplicate-safe import and preserves existing rows', async () => {
  copyPaste.mockResolvedValue({ data: { imported: 1, duplicates: 1, skipped: 0 } });
  const complete = vi.fn();
  render(<AddPeopleModal isOpen embedded initialMethod="csv" onClose={vi.fn()} onSuccess={complete} people={[existingPerson]} gatheringTypes={[gathering]} />);
  await loadSpreadsheet(mixed);
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));

  expect(copyPaste).toHaveBeenCalledWith('FIRST NAME\tLAST NAME\tFAMILY NAME\tGATHERINGS\tADULT/CHILD\nJane\tSmith\tSmith, Jane\tSunday\tAdult\nPat\tNg\tNg\tSunday\tChild');
  expect(updateExisting).not.toHaveBeenCalled();
  await waitFor(() => expect(complete).toHaveBeenCalledWith({ imported: 1, duplicates: 1, skipped: 0 }));
});

it('analyzes an edited preview and explains which rows the upload changes', async () => {
  render(<AddPeopleModal isOpen embedded initialMethod="csv" onClose={vi.fn()} onSuccess={vi.fn()} people={[existingPerson]} gatheringTypes={[gathering]} />);
  const preview = await loadSpreadsheet(mixed);
  expect(screen.getByText(/existing rows will be skipped/i)).toBeInTheDocument();

  fireEvent.change(preview, { target: { value: `${header}\n${existingRow}` } });
  expect(screen.getByText(/existing gathering assignments will be replaced/i)).toBeInTheDocument();
  expect(screen.queryByText(/existing rows will be skipped/i)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Upload' }));

  expect(updateExisting).toHaveBeenCalledWith('FIRST NAME\tLAST NAME\tFAMILY NAME\tGATHERINGS\tADULT/CHILD\nJane\tSmith\tSmith, Jane\tSunday\tAdult');
  expect(copyPaste).not.toHaveBeenCalled();
});

it('keeps a saved family when the completion refresh fails and retries only the refresh', async () => {
  const complete = vi.fn().mockRejectedValueOnce(new Error('Refresh failed')).mockResolvedValueOnce(undefined);
  const close = vi.fn();
  render(<AddPeopleModal isOpen embedded initialGatheringId={7} onClose={close} onSuccess={complete} people={[]} gatheringTypes={[gathering]} />);

  await userEvent.type(screen.getByPlaceholderText('First name'), 'Jane');
  await userEvent.type(screen.getByPlaceholderText('Last name'), 'Smith');
  await userEvent.click(screen.getByRole('button', { name: 'Add People' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/people were saved/i);
  expect(deleteFamily).not.toHaveBeenCalled();
  expect(deletePerson).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: /retry refresh/i }));
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(createFamily).toHaveBeenCalledTimes(1);
  expect(createPerson).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(2);
});
