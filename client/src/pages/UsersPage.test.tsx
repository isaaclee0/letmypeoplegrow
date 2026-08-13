import { describe, expect, it } from 'vitest';
import { formatInstant } from '../utils/churchTime';

describe('UsersPage timestamp presentation', () => {
  it('formats a last-login instant in the church timezone, independent of the browser timezone', () => {
    expect(formatInstant('2026-08-13T02:15:00Z', 'Australia/Hobart', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }, 'en-AU')).toBe('13 Aug 2026, 12:15 pm');
  });
});
