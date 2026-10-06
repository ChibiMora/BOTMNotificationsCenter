// Standard 5-field UTC cron semantics (§8.3): *, */n, a, a-b, a-b/n, lists; DOM/DOW OR rule; others rejected.
import { describe, it, expect } from 'vitest';
import { cronSchedule } from '../../src/scheduler/schedule.js';

const due = (expr: string, iso: string) => cronSchedule(expr).isDue(new Date(iso), undefined);

describe('cron forms', () => {
  it('ranges', () => {
    expect(due('0 9 * * 1-5', '2026-10-05T09:00:00Z')).toBe(true); // Monday
    expect(due('0 9 * * 1-5', '2026-10-04T09:00:00Z')).toBe(false); // Sunday
    expect(due('10-20 * * * *', '2026-10-05T09:15:00Z')).toBe(true);
    expect(due('10-20 * * * *', '2026-10-05T09:21:00Z')).toBe(false);
  });

  it('stepped ranges', () => {
    expect(due('1-5/2 * * * *', '2026-10-05T09:03:00Z')).toBe(true);
    expect(due('1-5/2 * * * *', '2026-10-05T09:04:00Z')).toBe(false);
    expect(due('*/15 * * * *', '2026-10-05T09:45:00Z')).toBe(true);
  });

  it('comma lists mixing forms', () => {
    expect(due('0,30-31 * * * *', '2026-10-05T09:31:00Z')).toBe(true);
    expect(due('0,30-31 * * * *', '2026-10-05T09:29:00Z')).toBe(false);
  });

  it('DOM and DOW are ORed when both are restricted', () => {
    // 2026-10-05 is a Monday, not the 1st: matches via DOW.
    expect(due('0 0 1 * 1', '2026-10-05T00:00:00Z')).toBe(true);
    // 2026-10-01 is a Thursday: matches via DOM.
    expect(due('0 0 1 * 1', '2026-10-01T00:00:00Z')).toBe(true);
    expect(due('0 0 1 * 1', '2026-10-06T00:00:00Z')).toBe(false);
  });

  it('DOM and DOW are ANDed with * (only one restricted)', () => {
    expect(due('0 0 1 * *', '2026-10-05T00:00:00Z')).toBe(false);
    expect(due('0 0 * * 1', '2026-10-01T00:00:00Z')).toBe(false);
  });

  it('rejects anything else with a clear error', () => {
    for (const bad of [
      '5-1 * * * *',
      '*/0 * * * *',
      '60 * * * *',
      'L * * * *',
      '1-5/0 * * * *',
      '* * * *',
      'a b c d e',
    ]) {
      expect(() => cronSchedule(bad), bad).toThrow(/invalid cron/);
    }
  });
});
