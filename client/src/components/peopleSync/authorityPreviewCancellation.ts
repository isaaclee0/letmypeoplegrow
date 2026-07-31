import { peopleSyncAPI } from '../../services/api';
import type { SyncProvider } from './types';

export interface AuthorityPreviewCancellation {
  provider: SyncProvider;
  authorityPreviewId: string;
}

const RETRY_DELAYS_MS = [500, 5000, 15000] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const MAX_RETRY_WINDOW_MS = 45000;
const cancellationJobs = new Map<string, Promise<void>>();

const cancellationKey = ({ provider, authorityPreviewId }: AuthorityPreviewCancellation) =>
  `${provider}\u0000${authorityPreviewId}`;

const wait = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

function responseStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('response' in error)) return null;
  const response = error.response;
  if (!response || typeof response !== 'object' || !('status' in response)) return null;
  return typeof response.status === 'number' ? response.status : null;
}

function retryAfterMilliseconds(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('response' in error)) return null;
  const response = error.response;
  if (!response || typeof response !== 'object' || !('headers' in response)) return null;
  const headers = response.headers;
  let value: unknown;
  if (headers && typeof headers === 'object' && 'get' in headers && typeof headers.get === 'function') {
    value = headers.get('retry-after');
  } else if (headers && typeof headers === 'object') {
    value = (headers as Record<string, unknown>)['retry-after'];
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function isRetryable(error: unknown): boolean {
  const status = responseStatus(error);
  return status === null || status === 408 || status === 429 || status >= 500;
}

// Cancellation is an ownership obligation, not component UI state. Capture
// the exact immutable intent and retain it across navigation/unmount, but use
// finite retry ownership: the server endpoint is exact and idempotent, while
// its durable 30-minute intent expiry is the final fallback if this bounded
// client cleanup cannot be confirmed.
export function cancelAuthorityPreviewWithRetry(
  preview: AuthorityPreviewCancellation,
): Promise<void> {
  const key = cancellationKey(preview);
  const existing = cancellationJobs.get(key);
  if (existing) return existing;

  let job!: Promise<void>;
  job = (async () => {
    const startedAt = Date.now();
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        await peopleSyncAPI.cancelAuthorityPreview(
          preview.provider,
          preview.authorityPreviewId,
        );
        return;
      } catch (error) {
        if (!isRetryable(error) || attempts >= MAX_ATTEMPTS) throw error;
        const scheduledDelay = RETRY_DELAYS_MS[attempts - 1];
        const retryAfter = retryAfterMilliseconds(error);
        const delay = Math.max(scheduledDelay, retryAfter ?? 0);
        if (Date.now() - startedAt + delay > MAX_RETRY_WINDOW_MS) throw error;
        await wait(delay);
      }
    }
  })().finally(() => {
    if (cancellationJobs.get(key) === job) cancellationJobs.delete(key);
  });
  cancellationJobs.set(key, job);
  return job;
}
