import React, { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import EstablishedLinkDialog from './EstablishedLinkDialog';
import type { PeopleSyncPeopleDirectory } from './types';

const directory: PeopleSyncPeopleDirectory = {
  external: {
    'provider-alex': { firstName: 'Alex', lastName: 'Smith', family: { state: 'none' } },
    'provider-other': { firstName: 'Robin', lastName: 'Taylor', family: { state: 'none' } },
  },
  local: {
    '21': { firstName: 'Current', lastName: 'Person', matchEligible: false, family: { state: 'none' } },
    '22': {
      firstName: 'Eligible', lastName: 'Person', matchEligible: true,
      family: {
        state: 'known', name: 'Green family', totalOtherMembers: 5,
        members: [
          { firstName: 'Family', lastName: 'Member' },
          { firstName: 'Second', lastName: 'Member' },
          { firstName: 'Third', lastName: 'Member' },
          { firstName: 'Fourth', lastName: 'Member' },
        ],
      },
    },
    '23': { firstName: 'Durable', lastName: 'Person', matchEligible: false, family: { state: 'unavailable' } },
    '24': { firstName: 'Claimed', lastName: 'Person', matchEligible: true, family: { state: 'none' } },
  },
};

const defaultProps = {
  open: true,
  externalId: 'provider-alex',
  currentIndividualId: 21,
  originalIndividualId: 21,
  directory,
  availableIndividualIds: new Set([22, 24]),
  claimedBy: new Map([[24, 'provider-other']]),
  onRelink: vi.fn(),
  onUnlink: vi.fn(),
  onClose: vi.fn(),
};

function EstablishedHarness({ onRelink, onUnlink }: {
  onRelink: (individualId: number) => void;
  onUnlink: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Correct linked person for Alex Smith</button>
      <EstablishedLinkDialog
        {...defaultProps}
        open={open}
        onRelink={onRelink}
        onUnlink={onUnlink}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe('EstablishedLinkDialog', () => {
  it('offers correction actions and explains that unlinking holds unattended sync', async () => {
    render(<EstablishedLinkDialog {...defaultProps} />);
    const dialog = await screen.findByRole('dialog', { name: 'Correct linked person for Alex Smith' });

    expect(within(dialog).getByText('Current Person')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Change linked person' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Unlink and review again' })).toBeVisible();
    expect(within(dialog).getByText(/Unattended sync will be held/i)).toBeVisible();
    expect(within(dialog).queryByText('provider-alex')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('21')).not.toBeInTheDocument();
  });

  it('searches replacement names only and relinks from a compact person row', async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    render(<EstablishedLinkDialog {...defaultProps} onRelink={onRelink} />);
    const dialog = screen.getByRole('dialog', { name: 'Correct linked person for Alex Smith' });

    await user.click(within(dialog).getByRole('button', { name: 'Change linked person' }));
    const search = within(dialog).getByRole('searchbox', { name: 'Search LMPG people' });
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, 'Family');

    expect(within(dialog).getByText('No matching people found.')).toBeVisible();

    await user.clear(search);
    await user.type(search, 'Eligible');
    const eligible = within(dialog).getByRole('button', { name: 'Select Eligible Person' });
    expect(eligible).toHaveTextContent('Eligible Person');
    expect(eligible).toHaveTextContent('Green family');
    expect(within(dialog).queryByText('Family Member')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('2 more family members')).not.toBeInTheDocument();

    await user.click(eligible);

    expect(onRelink).toHaveBeenCalledOnce();
    expect(onRelink).toHaveBeenCalledWith(22);
  });

  it('disables durable and in-review claims while changing the linked person', async () => {
    const user = userEvent.setup();
    render(<EstablishedLinkDialog {...defaultProps} />);
    const dialog = screen.getByRole('dialog', { name: 'Correct linked person for Alex Smith' });

    await user.click(within(dialog).getByRole('button', { name: 'Change linked person' }));
    expect(within(dialog).queryByRole('button', { name: 'Select Current Person' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Select Durable Person' })).toBeDisabled();
    expect(within(dialog).getByText('Already linked to a provider person')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Select Claimed Person' })).toBeDisabled();
    expect(within(dialog).getByText('Already selected for another provider person')).toBeVisible();
  });

  it('emits unlink without closing or relinking on its own', async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    const onUnlink = vi.fn();
    const onClose = vi.fn();
    render(<EstablishedLinkDialog {...defaultProps} onRelink={onRelink} onUnlink={onUnlink} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Unlink and review again' }));
    expect(onUnlink).toHaveBeenCalledOnce();
    expect(onUnlink).toHaveBeenCalledWith();
    expect(onRelink).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reopens a successfully unlinked row and offers both relinking and explicit restoration', async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    const onRestore = vi.fn();
    render(<EstablishedLinkDialog
      {...defaultProps}
      currentIndividualId={null}
      originalIndividualId={21}
      availableIndividualIds={new Set([21, 22, 24])}
      onRelink={onRelink}
      onRestore={onRestore}
    />);
    const dialog = screen.getByRole('dialog', { name: 'Correct linked person for Alex Smith' });

    expect(within(dialog).getByText(/currently unlinked in this review/i)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Change linked person' }));
    await user.click(within(dialog).getByRole('button', { name: 'Select Eligible Person' }));
    expect(onRelink).toHaveBeenCalledWith(22);

    await user.click(within(dialog).getByRole('button', { name: 'Restore original link' }));
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it('unmounts on backdrop dismissal, leaves corrections untouched, and restores focus', async () => {
    const user = userEvent.setup();
    const onRelink = vi.fn();
    const onUnlink = vi.fn();
    render(<EstablishedHarness onRelink={onRelink} onUnlink={onUnlink} />);
    const trigger = screen.getByRole('button', { name: 'Correct linked person for Alex Smith' });

    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Correct linked person for Alex Smith' });
    const backdrop = dialog.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop!);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onRelink).not.toHaveBeenCalled();
    expect(onUnlink).not.toHaveBeenCalled();
  });
});
