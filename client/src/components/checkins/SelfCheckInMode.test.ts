import { describe, expect, it } from 'vitest';
import { defaultKioskMode } from './SelfCheckInMode';

describe('defaultKioskMode', () => {
  it('switches to checkout fifteen minutes before the gathering end time', () => {
    expect(defaultKioskMode(10 * 60 + 45, '11:00')).toBe('checkout');
  });
});
