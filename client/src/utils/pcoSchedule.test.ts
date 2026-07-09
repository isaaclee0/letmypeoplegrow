import { describe, it, expect } from 'vitest';
import { ordinalDay } from './pcoSchedule';

describe('ordinalDay', () => {
  it('formats 1st, 2nd, 3rd, 4th correctly', () => {
    expect(ordinalDay(1)).toBe('1st');
    expect(ordinalDay(2)).toBe('2nd');
    expect(ordinalDay(3)).toBe('3rd');
    expect(ordinalDay(4)).toBe('4th');
  });

  it('formats 11th, 12th, 13th as "th" (not "st"/"nd"/"rd")', () => {
    expect(ordinalDay(11)).toBe('11th');
    expect(ordinalDay(12)).toBe('12th');
    expect(ordinalDay(13)).toBe('13th');
  });

  it('formats 21st, 22nd, 23rd correctly', () => {
    expect(ordinalDay(21)).toBe('21st');
    expect(ordinalDay(22)).toBe('22nd');
    expect(ordinalDay(23)).toBe('23rd');
  });

  it('formats 31st correctly', () => {
    expect(ordinalDay(31)).toBe('31st');
  });
});
