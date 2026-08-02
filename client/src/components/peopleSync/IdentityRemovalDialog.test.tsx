import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import IdentityRemovalDialog from './IdentityRemovalDialog';

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
});
