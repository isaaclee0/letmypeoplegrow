import { describe, expect, it } from 'vitest';
import { sourceFreshness } from './sourceFreshness';

const now = new Date('2026-07-29T12:00:00.000Z');
const days = (count: number) => count * 24 * 60 * 60 * 1000;
const nowMinusDays = (count: number) => new Date(now.getTime() - days(count)).toISOString();
const nowMinusMs = (count: number) => new Date(now.getTime() - count).toISOString();

describe('sourceFreshness', () => {
  it('classifies the exact seven and thirty day boundaries with a fixed clock', () => {
    expect(sourceFreshness(nowMinusDays(7), now).band).toBe('green');
    expect(sourceFreshness(nowMinusMs(days(7) + 1), now).band).toBe('orange');
    expect(sourceFreshness(nowMinusDays(30), now).band).toBe('orange');
    expect(sourceFreshness(nowMinusMs(days(30) + 1), now).band).toBe('red');
  });

  it('marks absent and malformed refresh times as unknown', () => {
    expect(sourceFreshness(null, now).band).toBe('unknown');
    expect(sourceFreshness('not-a-date', now).band).toBe('unknown');
  });

  it('includes a relative age and localized timestamp for a valid refresh time', () => {
    const refreshedAt = nowMinusDays(2);
    const result = sourceFreshness(refreshedAt, now);

    expect(result.text).toContain('2 days ago');
    expect(result.title).toContain(new Date(refreshedAt).toLocaleString());
  });
});
