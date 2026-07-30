export const RETIRED_LEGACY_BATCH_MESSAGE = 'This legacy batch has been retired. Reload the page to view or delete it.';

export function isRetiredLegacyBatchError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('response' in error)) return false;
  const response = error.response;
  if (typeof response !== 'object' || response === null || !('data' in response)) return false;
  const data = response.data;
  return typeof data === 'object' && data !== null && 'code' in data && data.code === 'PCO_LEGACY_BATCH_RETIRED';
}

export function planningCenterBatchErrorMessage(error: unknown, fallback: string): string {
  if (isRetiredLegacyBatchError(error)) return RETIRED_LEGACY_BATCH_MESSAGE;
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response;
    if (typeof response === 'object' && response !== null && 'data' in response) {
      const data = response.data;
      if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') return data.error;
    }
  }
  return fallback;
}
