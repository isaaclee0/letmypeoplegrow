import { peopleSyncAPI } from '../../services/api';
import type { SyncProvider } from './types';

export interface AuthorityPreviewCancellation {
  provider: SyncProvider;
  authorityPreviewId: string;
}

const RETRY_DELAYS_MS = [50, 250, 1000, 5000] as const;
const cancellationJobs = new Map<string, Promise<void>>();

const cancellationKey = ({ provider, authorityPreviewId }: AuthorityPreviewCancellation) =>
  `${provider}\u0000${authorityPreviewId}`;

const wait = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

// Cancellation is an ownership obligation, not component UI state. Capture
// the exact immutable intent and keep retrying it after navigation/unmount;
// the server endpoint is exact and idempotent, so an old retry can never
// cancel a newer preview intent for the same provider.
export function cancelAuthorityPreviewUntilSuccess(
  preview: AuthorityPreviewCancellation,
): Promise<void> {
  const key = cancellationKey(preview);
  const existing = cancellationJobs.get(key);
  if (existing) return existing;

  let job!: Promise<void>;
  job = (async () => {
    let attempt = 0;
    for (;;) {
      try {
        await peopleSyncAPI.cancelAuthorityPreview(
          preview.provider,
          preview.authorityPreviewId,
        );
        return;
      } catch {
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        attempt += 1;
        await wait(delay);
      }
    }
  })().finally(() => {
    if (cancellationJobs.get(key) === job) cancellationJobs.delete(key);
  });
  cancellationJobs.set(key, job);
  return job;
}
