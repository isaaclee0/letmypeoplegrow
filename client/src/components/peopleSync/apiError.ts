const REFRESH_ONLY_REVIEW_CODES = new Set([
  'SYNC_PLAN_STALE',
  'SYNC_REVIEW_EXPIRED',
  'SYNC_REVIEW_ALREADY_APPLIED',
  // Compatibility with the immediately previous review API.
  'STALE_REVIEW',
]);

function responseData(cause: unknown): Record<string, unknown> | undefined {
  if (typeof cause !== 'object' || cause === null || !('response' in cause)) return undefined;
  const response = cause.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return undefined;
  const data = response.data;
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined;
}

export function peopleSyncErrorCode(cause: unknown): string | undefined {
  const serverCode = responseData(cause)?.code;
  if (typeof serverCode === 'string') return serverCode;
  if (typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string') {
    return cause.code;
  }
  return undefined;
}

export function peopleSyncErrorMessage(cause: unknown, fallback: string): string {
  const data = responseData(cause);
  if (typeof data?.error === 'string') return data.error;
  if (typeof data?.message === 'string') return data.message;
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string') {
    return cause.message;
  }
  return fallback;
}

export function toPeopleSyncDisplayError(cause: unknown, fallback: string): Error & { code?: string } {
  const error = new Error(peopleSyncErrorMessage(cause, fallback)) as Error & { code?: string };
  const code = peopleSyncErrorCode(cause);
  if (code) error.code = code;
  return error;
}

export function isRefreshOnlyReviewError(cause: unknown): boolean {
  const code = peopleSyncErrorCode(cause);
  return code !== undefined && REFRESH_ONLY_REVIEW_CODES.has(code);
}
