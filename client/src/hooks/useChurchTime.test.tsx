import React from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AuthContext } from '../contexts/AuthContext';
import { useChurchTime } from './useChurchTime';

describe('useChurchTime', () => {
  it('falls back to UTC when rendered outside AuthProvider', () => {
    const { result } = renderHook(() => useChurchTime());

    expect(result.current.timeZone).toBe('UTC');
    expect(result.current.today(new Date('2026-08-13T02:15:00Z'))).toBe('2026-08-13');
  });

  it('uses the authenticated church timezone when a provider is present', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthContext.Provider value={{ user: { timezone: 'Australia/Hobart' } } as never}>
        {children}
      </AuthContext.Provider>
    );
    const { result } = renderHook(() => useChurchTime(), { wrapper });

    expect(result.current.timeZone).toBe('Australia/Hobart');
    expect(result.current.today(new Date('2026-08-13T02:15:00Z'))).toBe('2026-08-13');
  });
});
