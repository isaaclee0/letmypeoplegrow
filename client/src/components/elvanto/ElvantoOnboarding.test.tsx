import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { elvantoSyncAPI, integrationsAPI, peopleSyncAPI } from '../../services/api';
import ElvantoOnboarding, { reduceElvantoConnection } from './ElvantoOnboarding';

vi.mock('../../services/api', () => ({
  integrationsAPI: { connectElvanto: vi.fn() },
  elvantoSyncAPI: { createBatch: vi.fn(), applyBatch: vi.fn() },
  peopleSyncAPI: { previewAuthority: vi.fn(), applyAuthority: vi.fn() },
}));

vi.mock('../peopleImport/OnboardingPeopleImport', () => ({
  default: ({ provider, onComplete, onSkip }: {
    provider: string;
    onComplete: () => void;
    onSkip: () => void;
  }) => (
    <section aria-label="Elvanto one-time people import">
      <p>Import provider: {provider}</p>
      <button type="button" onClick={onComplete}>Apply one-time Elvanto import</button>
      <button type="button" onClick={onSkip}>Skip one-time Elvanto import</button>
    </section>
  ),
}));

describe('ElvantoOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(integrationsAPI.connectElvanto).mockResolvedValue({ data: {
      success: true,
      status: {
        provider: 'elvanto', authType: 'api_key', connectionStatus: 'connected',
        connectedAt: '2026-08-04T00:00:00.000Z', lastValidatedAt: '2026-08-04T00:00:00.000Z',
        lastErrorCode: null, metadata: { accountName: 'Example Church' }, metadataCachedAt: null,
      },
    } } as never);
  });

  it('clears the API key after connecting', () => {
    expect(reduceElvantoConnection({ apiKey: 'secret', connected: false }, { type: 'connected' }))
      .toEqual({ apiKey: '', connected: true });
  });

  it('connects, renders one-time import, and continues after apply without sync or authority calls', async () => {
    const onContinue = vi.fn();
    render(<ElvantoOnboarding onContinueToGatherings={onContinue} />);

    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'elvanto-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));

    expect(await screen.findByText('Import provider: elvanto')).toBeInTheDocument();
    expect(integrationsAPI.connectElvanto).toHaveBeenCalledWith('elvanto-secret');
    expect(screen.queryByText(/source of truth/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply one-time Elvanto import' }));

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(elvantoSyncAPI.createBatch).not.toHaveBeenCalled();
    expect(elvantoSyncAPI.applyBatch).not.toHaveBeenCalled();
    expect(peopleSyncAPI.previewAuthority).not.toHaveBeenCalled();
    expect(peopleSyncAPI.applyAuthority).not.toHaveBeenCalled();
  });

  it('keeps skip available before and after connection', async () => {
    const onContinue = vi.fn();
    const { rerender } = render(<ElvantoOnboarding onContinueToGatherings={onContinue} />);

    fireEvent.click(screen.getByRole('button', { name: 'Skip Elvanto' }));
    expect(onContinue).toHaveBeenCalledTimes(1);

    rerender(<ElvantoOnboarding onContinueToGatherings={onContinue} />);
    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'elvanto-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip one-time Elvanto import' }));

    expect(onContinue).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed connection recoverable', async () => {
    vi.mocked(integrationsAPI.connectElvanto).mockRejectedValue({
      response: { data: { error: 'The Elvanto API key was rejected.' } },
    });
    render(<ElvantoOnboarding onContinueToGatherings={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Elvanto API key'), { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Elvanto' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The Elvanto API key was rejected.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Elvanto' })).toBeEnabled());
  });
});
