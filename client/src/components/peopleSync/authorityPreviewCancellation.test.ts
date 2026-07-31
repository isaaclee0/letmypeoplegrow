import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { peopleSyncAPI } from '../../services/api';
import { cancelAuthorityPreviewWithRetry } from './authorityPreviewCancellation';

vi.mock('../../services/api', () => ({
  peopleSyncAPI: {
    cancelAuthorityPreview: vi.fn(),
  },
}));

const preview = { provider: 'elvanto' as const, authorityPreviewId: 'preview-bounded-retry' };

describe('authority preview cancellation retry ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bounds retryable failures and releases the exact job for later recovery', async () => {
    const outage = new Error('network unavailable');
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockRejectedValue(outage);

    const failed = cancelAuthorityPreviewWithRetry(preview).catch((error) => error);
    await vi.advanceTimersByTimeAsync(499);
    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(2);
    await vi.runAllTimersAsync();

    expect(await failed).toBe(outage);
    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(4);

    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockResolvedValueOnce({
      data: { success: true, authority: { active: 'none', pending: null } },
    });
    await expect(cancelAuthorityPreviewWithRetry(preview)).resolves.toBeUndefined();
    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(5);
  });

  it('does not retry terminal client failures', async () => {
    const rejected = { response: { status: 403 } };
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockRejectedValue(rejected);

    await expect(cancelAuthorityPreviewWithRetry({
      provider: 'elvanto', authorityPreviewId: 'preview-terminal',
    })).rejects.toBe(rejected);
    await vi.runAllTimersAsync();

    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(1);
  });

  it('does not outlive its retry window when Retry-After exceeds the cleanup budget', async () => {
    const throttled = { response: { status: 429, headers: { 'retry-after': '120' } } };
    vi.mocked(peopleSyncAPI.cancelAuthorityPreview).mockRejectedValue(throttled);

    await expect(cancelAuthorityPreviewWithRetry({
      provider: 'elvanto', authorityPreviewId: 'preview-throttled',
    })).rejects.toBe(throttled);
    await vi.runAllTimersAsync();

    expect(peopleSyncAPI.cancelAuthorityPreview).toHaveBeenCalledTimes(1);
  });
});
