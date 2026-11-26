import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AddVisitorModal from './AddVisitorModal';
import { attendanceAPI } from '../../services/api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('previews the family, retains a correction while typing, and submits a family note', async () => {
  const save = vi.spyOn(attendanceAPI, 'createVisitorDetails').mockResolvedValue({} as never);
  const onSaved = vi.fn();
  render(<AddVisitorModal gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={onSaved} />);
  const entry = screen.getByRole('textbox', { name: 'Who came?' });
  const note = screen.getByRole('textbox', { name: 'Family note' });
  expect(note).toBeVisible();
  fireEvent.change(entry, { target: { value: 'john and judy smith, 1 kid' } });
  expect(screen.getByLabelText('Surname 1')).toHaveValue('Smith');
  fireEvent.change(screen.getByLabelText('First name 3'), { target: { value: 'Lucy' } });
  fireEvent.change(entry, { target: { value: 'john and judy smith, 2 kids' } });
  expect(screen.getByLabelText('First name 3')).toHaveValue('Lucy');
  expect(screen.getByLabelText('First name 4')).toHaveValue('Child 2');
  fireEvent.change(note, { target: { value: 'Asked about kids club' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add 4 visitors' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(save.mock.calls[0][2]).toMatchObject({ notes: 'Asked about kids club', people: [
    { firstName: 'John', lastName: 'Smith' }, { firstName: 'Judy', lastName: 'Smith' },
    { firstName: 'Lucy', lastName: 'Smith', isChild: true }, { firstName: 'Child 2', lastName: 'Smith', isChild: true }
  ] });
});

it.each(['Visiting', ''])('reopens the visitor with the existing note %j ready to edit', async (notes) => {
  vi.spyOn(attendanceAPI, 'getVisitorDetails').mockResolvedValue({ data: {
    familyId: 8, familyName: 'John', peopleType: 'local_visitor', notes, revision: 'r1',
    familyEditable: true, notesEditable: true, people: [{ id: 12, firstName: 'John', lastName: '', isChild: false }]
  } } as never);
  const save = vi.spyOn(attendanceAPI, 'updateVisitorDetails').mockResolvedValue({} as never);
  render(<AddVisitorModal visitorId={12} gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('Surname 1'), { target: { value: 'Smith' } });
  expect(screen.getByLabelText('Family note')).toHaveValue(notes);
  fireEvent.change(screen.getByLabelText('Family note'), { target: { value: 'Returned Sunday' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(7, '2026-11-26', 12, expect.objectContaining({
    familyName: 'Smith, John', revision: 'r1', notes: 'Returned Sunday',
    people: [{ id: 12, firstName: 'John', lastName: 'Smith', isChild: false }]
  })));
});

it('asks how many came when the volunteer only knows a family surname', async () => {
  render(<AddVisitorModal gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Who came?'), { target: { value: 'the Smith family' } });
  expect(screen.getByRole('button', { name: 'Add visitor' })).toBeDisabled();
  fireEvent.change(screen.getByRole('spinbutton', { name: /adults/i }), { target: { value: '2' } });
  fireEvent.change(screen.getByRole('spinbutton', { name: /children/i }), { target: { value: '1' } });
  expect(screen.getByLabelText('Surname 3')).toHaveValue('Smith');
  expect(screen.getByLabelText('Age group 3')).toHaveValue('child');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add 3 visitors' })).toBeEnabled());
});

it('fills blank surnames from the edited person and preserves other surnames', async () => {
  const save = vi.spyOn(attendanceAPI, 'createVisitorDetails').mockResolvedValue({} as never);
  render(<AddVisitorModal gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Who came?'), { target: { value: 'John Brown + Judy, 2 children' } });
  expect(screen.getByLabelText('Surname 2')).toHaveValue('');
  expect(screen.getByLabelText('Surname 3')).toHaveValue('Brown');
  fireEvent.change(screen.getByLabelText('Surname 2'), { target: { value: 'Smith' } });
  expect(screen.getByLabelText('Surname 3')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Fill 2 blank surnames with Smith' }));
  expect(screen.getByLabelText('Surname 1')).toHaveValue('Brown');
  expect(screen.getByLabelText('Surname 3')).toHaveValue('Smith');
  expect(screen.queryByRole('button', { name: /fill .*blank surname/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add 4 visitors' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][2].people.map(p => p.lastName)).toEqual(['Brown', 'Smith', 'Smith', 'Smith']);
});

it('updates inherited surnames while keeping a named child, a manual override and an explicitly cleared surname', async () => {
  const save = vi.spyOn(attendanceAPI, 'createVisitorDetails').mockResolvedValue({} as never);
  render(<AddVisitorModal gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Who came?'), { target: { value: 'John Smith, 4 kids: Mia Brown, Lucy, Sam and Jo' } });
  const surname = (n: number) => screen.getByLabelText('Surname ' + n);
  expect(surname(3)).toHaveValue('Smith');
  fireEvent.change(surname(3), { target: { value: 'Green' } });
  fireEvent.change(surname(4), { target: { value: '' } });
  fireEvent.change(surname(1), { target: { value: 'Jones' } });
  expect(surname(5)).toHaveValue('Jones');
  fireEvent.click(screen.getByRole('button', { name: 'Add 5 visitors' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][2].people.map(p => p.lastName)).toEqual(['Jones', 'Brown', 'Green', '', 'Jones']);
});

it('uses an adult surname added later for an existing unnamed child and a manually added child', async () => {
  vi.spyOn(attendanceAPI, 'getVisitorDetails').mockResolvedValue({ data: {
    familyName: 'John', familyEditable: true, notesEditable: true, notes: '', revision: 'r3', peopleType: 'local_visitor',
    people: [
      { id: 21, firstName: 'John', lastName: '', isChild: false },
      { id: 22, firstName: 'Lucy', lastName: '', isChild: true },
    ],
  } } as never);
  render(<AddVisitorModal visitorId={21} gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('Surname 1'), { target: { value: 'Smith' } });
  expect(screen.getByLabelText('Surname 2')).toHaveValue('Smith');
  fireEvent.click(screen.getByRole('button', { name: 'Add another person' }));
  fireEvent.change(screen.getByLabelText('Age group 3'), { target: { value: 'child' } });
  expect(screen.getByLabelText('Surname 3')).toHaveValue('Smith');
});

it('preserves a saved blank child surname when reopening a family to edit its note', async () => {
  vi.spyOn(attendanceAPI, 'getVisitorDetails').mockResolvedValue({ data: {
    familyName: 'Smith, John', familyEditable: true, notesEditable: true, notes: '', revision: 'r4', peopleType: 'local_visitor',
    people: [
      { id: 21, firstName: 'John', lastName: 'Smith', isChild: false },
      { id: 22, firstName: 'Lucy', lastName: '', isChild: true },
    ],
  } } as never);
  const save = vi.spyOn(attendanceAPI, 'updateVisitorDetails').mockResolvedValue({} as never);
  render(<AddVisitorModal visitorId={21} gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('Family note'), { target: { value: 'Back next week' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0][3].people[1].lastName).toBe('');
});

it('skips locked visitors when filling surnames in an existing family', async () => {
  vi.spyOn(attendanceAPI, 'getVisitorDetails').mockResolvedValue({ data: {
    familyName: 'John and Judy', familyEditable: false, notesEditable: true, notes: '', revision: 'r2', peopleType: 'local_visitor',
    people: [
      { id: 21, firstName: 'John', lastName: '', isChild: false },
      { id: 22, firstName: 'Judy', lastName: '', isChild: false },
      { id: 23, firstName: 'Lucy', lastName: '', isChild: true, locked: true },
    ]
  } } as never);
  render(<AddVisitorModal visitorId={21} gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('Surname 1'), { target: { value: 'Smith' } });
  fireEvent.click(screen.getByRole('button', { name: 'Fill 1 blank surname with Smith' }));
  expect(screen.getByLabelText('Surname 2')).toHaveValue('Smith');
  expect(screen.getByLabelText('Surname 3')).toHaveValue('');
});

it('opens one mobile row at a time and opens a manually added person for typing', async () => {
  render(<AddVisitorModal gatheringId={7} date="2026-11-26" canSetType={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Who came?'), { target: { value: 'john and judy' } });
  const john = screen.getByRole('button', { name: 'Edit John' });
  expect(john).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(john);
  expect(john).toHaveAttribute('aria-expanded', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Judy' }));
  expect(john).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Add another person' }));
  expect(screen.getByLabelText('First name 3')).toHaveFocus();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Edit unnamed visitor' })).toHaveAttribute('aria-expanded', 'true'));
});
