import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosHarness = vi.hoisted(() => {
  const requestUse = vi.fn();
  const responseUse = vi.fn();
  const instance = Object.assign(vi.fn(), {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors: {
      request: { use: requestUse },
      response: { use: responseUse },
    },
  });
  return { instance, requestUse, responseUse };
});

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => axiosHarness.instance),
  },
}));

import './api';

type RejectedInterceptor = (error: {
  config: { url: string; _retry?: boolean };
  response: { status: number; data?: { code?: string; error?: string } };
}) => Promise<unknown>;

const responseRejected = axiosHarness.responseUse.mock.calls[0][1] as RejectedInterceptor;

describe('API authentication response handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('user', JSON.stringify({ id: 1 }));
  });

  it('surfaces provider SYNC_SOURCE_AUTH 401 without refreshing or replaying the request', async () => {
    const providerError = {
      config: { url: '/integrations/people-sync/people-authority/preview' },
      response: {
        status: 401,
        data: { code: 'SYNC_SOURCE_AUTH', error: 'Reconnect Elvanto to continue.' },
      },
    };

    await expect(responseRejected(providerError)).rejects.toBe(providerError);

    expect(axiosHarness.instance.post).not.toHaveBeenCalled();
    expect(axiosHarness.instance).not.toHaveBeenCalled();
    expect(localStorage.getItem('user')).not.toBeNull();
  });

  it('still refreshes and replays an ordinary expired-session 401 once', async () => {
    const sessionError = {
      config: { url: '/individuals' },
      response: { status: 401 },
    };
    const replayed = { status: 200, data: { success: true } };
    axiosHarness.instance.post.mockResolvedValueOnce({ status: 200 });
    axiosHarness.instance.mockResolvedValueOnce(replayed);

    await expect(responseRejected(sessionError)).resolves.toBe(replayed);

    expect(axiosHarness.instance.post).toHaveBeenCalledWith('/auth/refresh');
    expect(sessionError.config._retry).toBe(true);
    expect(axiosHarness.instance).toHaveBeenCalledWith(sessionError.config);
  });
});
