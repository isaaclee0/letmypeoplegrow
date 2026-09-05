import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultReportLayout } from './reportLayout';
import { useReportLayout } from './useReportLayout';

const api = vi.hoisted(() => ({ fetch: vi.fn(), save: vi.fn(), cache: vi.fn(), readCache: vi.fn() }));

vi.mock('../../services/reportLayoutPreferences', () => ({
  fetchReportLayout: api.fetch,
  saveReportLayout: api.save,
  cacheReportLayout: api.cache,
  readCachedReportLayout: api.readCache,
}));

describe('useReportLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.readCache.mockReturnValue(null);
    api.fetch.mockResolvedValue(defaultReportLayout());
    api.save.mockResolvedValue(undefined);
  });

  it('keeps hide changes as a draft until save', async () => {
    const { result } = renderHook(() => useReportLayout({ userId: 7, churchId: 'church-a' }));
    await waitFor(() => expect(result.current.canEdit).toBe(true));

    act(() => result.current.beginEditing());
    act(() => result.current.setVisible('recent-visitors', false));

    expect(result.current.layout.hidden).toEqual(['recent-visitors']);
    expect(api.save).not.toHaveBeenCalled();

    await act(async () => { await result.current.save(); });
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ hidden: ['recent-visitors'] }));
    expect(api.cache).toHaveBeenCalled();
    expect(result.current.editing).toBe(false);
  });

  it('restores the saved layout when editing is cancelled', async () => {
    const { result } = renderHook(() => useReportLayout({ userId: 7, churchId: 'church-a' }));
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    act(() => result.current.beginEditing());
    act(() => result.current.setVisible('summary', false));
    act(() => result.current.cancel());

    expect(result.current.layout.hidden).toEqual([]);
  });

  it('keeps the draft available after a save failure', async () => {
    api.save.mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useReportLayout({ userId: 7, churchId: 'church-a' }));
    await waitFor(() => expect(result.current.canEdit).toBe(true));
    act(() => result.current.beginEditing());
    act(() => result.current.setVisible('regularity', false));
    await act(async () => { await result.current.save(); });

    expect(result.current.editing).toBe(true);
    expect(result.current.layout.hidden).toEqual(['regularity']);
    expect(result.current.error).toBe('Could not save your layout. Try again.');
  });
});
