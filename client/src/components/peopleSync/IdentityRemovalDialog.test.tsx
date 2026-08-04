import React, { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import IdentityRemovalDialog from './IdentityRemovalDialog';

function RemovalHarness({ onRejectPair, onSkip }: {
  onRejectPair: (individualId: number) => void;
  onSkip: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Remove matching decision for Alex Smith</button>
      <IdentityRemovalDialog
        open={open}
        externalName="Alex Smith"
        pairedIndividualId={42}
        onRejectPair={onRejectPair}
        onSkip={onSkip}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

describe('IdentityRemovalDialog', () => {
  it('offers rejecting the exact pair or deferring a paired decision with exact callback payloads', async () => {
    const user = userEvent.setup();
    const onRejectPair = vi.fn();
    const onSkip = vi.fn();
    render(
      <IdentityRemovalDialog
        open
        externalName="Alex Smith"
        pairedIndividualId={42}
        onRejectPair={onRejectPair}
        onSkip={onSkip}
        onClose={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Remove matching decision for Alex Smith' });

    expect(within(dialog).getByRole('button', { name: 'Reject this match' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Skip and ask again' })).toBeVisible();
    expect(within(dialog).queryByText('42')).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Reject this match' }));
    expect(onRejectPair).toHaveBeenCalledOnce();
    expect(onRejectPair).toHaveBeenCalledWith(42);
    expect(onSkip).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Skip and ask again' }));
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onSkip).toHaveBeenCalledWith();
  });

  it('keeps every decision action reachable when the dialog is taller than the viewport', async () => {
    render(
      <IdentityRemovalDialog
        open
        externalName="Sarah Wierenga"
        pairedIndividualId={42}
        onRejectPair={vi.fn()}
        onSkip={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = await screen.findByRole('dialog', { name: 'Remove matching decision for Sarah Wierenga' });
    const panel = dialog.querySelector('.rounded-xl');
    expect(panel).toHaveClass('overflow-y-auto');
    expect(panel).toHaveClass('max-h-[calc(100vh-2rem)]');
    expect(panel).toHaveClass('[@supports(height:100dvh)]:max-h-[calc(100dvh-2rem)]');
    expect(within(dialog).getByRole('button', { name: 'Reject this match' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Skip and ask again' })).toBeInTheDocument();
  });

  it('offers only deferral for a proposed addition', async () => {
    render(
      <IdentityRemovalDialog
        open
        externalName="Alex Smith"
        pairedIndividualId={null}
        onRejectPair={vi.fn()}
        onSkip={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Remove matching decision for Alex Smith' });

    expect(within(dialog).queryByRole('button', { name: 'Reject this match' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Skip and ask again' })).toBeVisible();
  });

  it('closes with the labelled close button without mutating the decision', async () => {
    const user = userEvent.setup();
    const onRejectPair = vi.fn();
    const onSkip = vi.fn();
    const onClose = vi.fn();
    render(
      <IdentityRemovalDialog
        open
        externalName="Alex Smith"
        pairedIndividualId={42}
        onRejectPair={onRejectPair}
        onSkip={onSkip}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Close remove matching decision' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith();
    expect(onRejectPair).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('unmounts on X, leaves decisions untouched, and restores focus to its trigger', async () => {
    const user = userEvent.setup();
    const onRejectPair = vi.fn();
    const onSkip = vi.fn();
    render(<RemovalHarness onRejectPair={onRejectPair} onSkip={onSkip} />);
    const trigger = screen.getByRole('button', { name: 'Remove matching decision for Alex Smith' });

    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Remove matching decision for Alex Smith' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close remove matching decision' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onRejectPair).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });
});
