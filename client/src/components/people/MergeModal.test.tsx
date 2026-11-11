import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { individualsAPI } from '../../services/api';
import MergeModal from './MergeModal';

const people = [
  { id: 11, firstName: 'Casey', lastName: 'Example', familyName: 'Retained family' },
  { id: 12, firstName: 'Casey', lastName: 'Duplicate', externalLinks: { planning_center: 'pco-person' } },
];

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('requires an explicit retained person and submits the chosen ID with attendance preserved regardless of assignment choice', async () => {
  const merge = vi.spyOn(individualsAPI, 'deduplicate').mockResolvedValue({ data: {} } as never);
  const onSuccess = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<MergeModal isOpen mergeMode="deduplicate" selectedPeople={[11, 12]} people={people} families={[]} onClose={vi.fn()} onSuccess={onSuccess} />);
  const submit = screen.getByRole('button', { name: /merge duplicate|deduplicate individuals/i });
  expect(submit).toBeDisabled();
  expect(screen.getByText(/attendance history.*preserved/i)).toBeInTheDocument();
  await user.selectOptions(screen.getByRole('combobox', { name: /record to keep/i }), '11');
  expect(screen.getByText(/keep Casey Example.*11/i)).toBeInTheDocument();
  expect(screen.getByText(/Retained family.*stay/i)).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /gathering assignments/i }));
  await user.click(submit);
  expect(merge).toHaveBeenCalledWith({ keepId: 11, deleteIds: [12], mergeAssignments: false });
  expect(onSuccess).toHaveBeenCalledWith(expect.stringMatching(/Casey Example.*attendance/i));
});

it('blocks incompatible provider links and names the conflict before submitting', async () => {
  const merge = vi.spyOn(individualsAPI, 'deduplicate');
  render(<MergeModal isOpen mergeMode="deduplicate" selectedPeople={[11, 12]}
    people={[{ ...people[0], externalLinks: { planning_center: 'another-pco-person' } }, people[1]]}
    families={[]} onClose={vi.fn()} onSuccess={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/different Planning Center people/i);
  expect(screen.getByRole('button', { name: /merge duplicate|deduplicate individuals/i })).toBeDisabled();
  expect(merge).not.toHaveBeenCalled();
});

it('shows a stale provider conflict returned by the server without claiming a successful merge', async () => {
  const onSuccess = vi.fn();
  vi.spyOn(individualsAPI, 'deduplicate').mockRejectedValue({ response: { data: {
    code: 'INCOMPATIBLE_PROVIDER_IDENTITIES', error: 'These records link to different Elvanto people. Correct the provider links in sync review before merging.',
  } } });
  const user = userEvent.setup();
  render(<MergeModal isOpen mergeMode="deduplicate" selectedPeople={[11, 12]} people={people} families={[]} onClose={vi.fn()} onSuccess={onSuccess} />);
  await user.selectOptions(screen.getByRole('combobox', { name: /record to keep/i }), '11');
  await user.click(screen.getByRole('button', { name: /merge duplicate|deduplicate individuals/i }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/different Elvanto people/i);
  expect(onSuccess).not.toHaveBeenCalled();
});

it('requires choosing a retained record again after closing and reopening', async () => {
  const user = userEvent.setup();
  const props = { mergeMode: 'deduplicate' as const, selectedPeople: [11, 12], people, families: [], onClose: vi.fn(), onSuccess: vi.fn() };
  const view = render(<MergeModal {...props} isOpen />);
  await user.selectOptions(screen.getByRole('combobox', { name: /record to keep/i }), '11');
  view.rerender(<MergeModal {...props} isOpen={false} />);
  view.rerender(<MergeModal {...props} isOpen />);
  expect(screen.getByRole('button', { name: /merge duplicate|deduplicate individuals/i })).toBeDisabled();
});
