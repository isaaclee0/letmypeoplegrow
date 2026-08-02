import React, { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PeoplePickerDialog from './PeoplePickerDialog';
import type { PeopleSyncPeopleDirectory } from './types';

const directory: PeopleSyncPeopleDirectory = {
  external: {
    'provider-alex': { firstName: 'Alex', lastName: 'Smith', family: { state: 'none' } },
    'provider-other': { firstName: 'Robin', lastName: 'Taylor', family: { state: 'none' } },
  },
  local: {
    '11': {
      firstName: 'Alex', lastName: 'Jones', matchEligible: true,
      family: {
        state: 'known', name: 'Jones family', totalOtherMembers: 1,
        members: [{ firstName: 'Casey', lastName: 'Jones' }],
      },
    },
    '12': {
      firstName: 'Morgan', lastName: 'Reed', matchEligible: true,
      family: {
        state: 'known', name: 'Reed household', totalOtherMembers: 1,
        members: [{ firstName: 'Jamie', lastName: 'Stone' }],
      },
    },
    '13': { firstName: 'Durable', lastName: 'Link', matchEligible: false, family: { state: 'unavailable' } },
    '14': { firstName: 'Claimed', lastName: 'Person', matchEligible: true, family: { state: 'none' } },
    '15': { firstName: 'Pat', lastName: 'Excluded', matchEligible: true, family: { state: 'none' } },
  },
};

const defaultProps = {
  externalId: 'provider-alex',
  directory,
  availableIndividualIds: new Set([11, 12, 14, 15]),
  claimedBy: new Map([[14, 'provider-other']]),
  allowCreate: true,
  selectedIndividualId: null,
  excludedIndividualIds: [] as number[],
  onSelectPerson: vi.fn(),
  onSelectCreate: vi.fn(),
};

function PickerHarness(props: Partial<React.ComponentProps<typeof PeoplePickerDialog>> = {}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Change LMPG match for Alex Smith</button>
      <PeoplePickerDialog {...defaultProps} {...props} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe('PeoplePickerDialog', () => {
  it.each([
    ['name', 'Alex Jones', 'Select Alex Jones'],
    ['family', 'Jones family', 'Select Alex Jones'],
    ['family member', 'Jamie Stone', 'Select Morgan Reed'],
  ])('searches by %s', async (_kind, query, resultName) => {
    const user = userEvent.setup();
    render(<PickerHarness />);

    await user.click(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose an LMPG person for Alex Smith' });
    const search = within(dialog).getByRole('searchbox', { name: 'Search LMPG people' });
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, query);

    expect(within(dialog).getByRole('button', { name: resultName })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: 'Select Durable Link' })).not.toBeInTheDocument();
  });

  it('explains durable and in-review claims and exposes creation without leaking identifiers', async () => {
    const user = userEvent.setup();
    const onSelectCreate = vi.fn();
    render(<PickerHarness onSelectCreate={onSelectCreate} />);

    await user.click(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose an LMPG person for Alex Smith' });

    expect(within(dialog).getByRole('button', { name: 'Select Durable Link' })).toBeDisabled();
    expect(within(dialog).getByText('Already linked to a provider person')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Select Claimed Person' })).toBeDisabled();
    expect(within(dialog).getByText('Already selected for another provider person')).toBeVisible();
    expect(within(dialog).queryByText('provider-alex')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('provider-other')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Add new person' }));
    expect(onSelectCreate).toHaveBeenCalledOnce();
    expect(onSelectCreate).toHaveBeenCalledWith();
  });

  it('confirms a previously excluded exact pair before selecting it', async () => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    render(<PickerHarness excludedIndividualIds={[11]} onSelectPerson={onSelectPerson} />);

    await user.click(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose an LMPG person for Alex Smith' });
    await user.click(within(dialog).getByRole('button', { name: 'Select Alex Jones' }));

    expect(onSelectPerson).not.toHaveBeenCalled();
    expect(within(dialog).getByText('This exact pairing was previously rejected.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Confirm match to Alex Jones' }));
    expect(onSelectPerson).toHaveBeenCalledOnce();
    expect(onSelectPerson).toHaveBeenCalledWith(11);
  });

  it('selects an eligible person directly and identifies the current selection', async () => {
    const user = userEvent.setup();
    const onSelectPerson = vi.fn();
    render(<PickerHarness selectedIndividualId={12} onSelectPerson={onSelectPerson} />);

    await user.click(screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' }));
    const dialog = screen.getByRole('dialog', { name: 'Choose an LMPG person for Alex Smith' });
    expect(within(dialog).getByText('Currently selected')).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Select Alex Jones' }));
    expect(onSelectPerson).toHaveBeenCalledWith(11);
  });

  it('closes on Escape and returns focus to the invoking control', async () => {
    const user = userEvent.setup();
    render(<PickerHarness />);
    const trigger = screen.getByRole('button', { name: 'Change LMPG match for Alex Smith' });

    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Choose an LMPG person for Alex Smith' })).toBeVisible();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
