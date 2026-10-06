// Due-time maths (§8.3): minimal UTC cron matcher, interval schedules, month-start rescan run.
import { describe, it, expect } from 'vitest';
import { cronSchedule, intervalSchedule, anyOf, MONTH_START } from '../../src/scheduler/schedule.js';

const at = (s: string) => new Date(s);

describe('schedule', () => {
  it('day-of-week 7 is Sunday (standard cron), alone and in ranges; 8 is invalid', () => {
    expect(cronSchedule('0 6 * * 7').isDue(at('2026-10-04T06:00:00Z'), undefined)).toBe(true); // Sunday
    expect(cronSchedule('0 6 * * 7').isDue(at('2026-10-05T06:00:00Z'), undefined)).toBe(false); // Monday
    expect(cronSchedule('0 6 * * 5-7').isDue(at('2026-10-04T06:00:00Z'), undefined)).toBe(true);
    expect(() => cronSchedule('0 6 * * 8')).toThrow(/invalid cron/);
  });
  it('rescan default 0 6 * * * fires at 06:00 UTC only', () => {
    const s = cronSchedule('0 6 * * *');
    expect(s.isDue(at('2026-10-04T06:00:30Z'), undefined)).toBe(true);
    expect(s.isDue(at('2026-10-04T06:01:00Z'), undefined)).toBe(false);
    expect(s.isDue(at('2026-10-04T06:00:40Z'), at('2026-10-04T06:00:30Z'))).toBe(false);
    expect(s.isDue(at('2026-10-05T06:00:00Z'), at('2026-10-04T06:00:30Z'))).toBe(true);
  });
  it('expiry default 0 1 * * * and housekeeping */5', () => {
    expect(cronSchedule('0 1 * * *').isDue(at('2026-10-04T01:00:00Z'), undefined)).toBe(true);
    const hk = cronSchedule('*/5 * * * *');
    expect(hk.isDue(at('2026-10-04T14:35:00Z'), undefined)).toBe(true);
    expect(hk.isDue(at('2026-10-04T14:36:00Z'), undefined)).toBe(false);
  });
  it('comma lists', () => {
    const s = cronSchedule('0,30 * * * *');
    expect(s.isDue(at('2026-10-04T14:30:00Z'), undefined)).toBe(true);
    expect(s.isDue(at('2026-10-04T14:15:00Z'), undefined)).toBe(false);
  });
  it('month start is 00:05 UTC on the 1st', () => {
    expect(MONTH_START.isDue(at('2026-11-01T00:05:00Z'), undefined)).toBe(true);
    expect(MONTH_START.isDue(at('2026-11-02T00:05:00Z'), undefined)).toBe(false);
    expect(anyOf(cronSchedule('0 6 * * *'), MONTH_START).isDue(at('2026-11-01T00:05:10Z'), undefined)).toBe(
      true,
    );
  });
  it('interval schedules', () => {
    const s = intervalSchedule(60);
    expect(s.isDue(at('2026-10-04T14:00:00Z'), undefined)).toBe(true);
    expect(s.isDue(at('2026-10-04T14:00:59Z'), at('2026-10-04T14:00:00Z'))).toBe(false);
    expect(s.isDue(at('2026-10-04T14:01:00Z'), at('2026-10-04T14:00:00Z'))).toBe(true);
  });
  it('rejects invalid expressions', () => {
    for (const e of ['* * * *', '61 * * * *', 'x * * * *', '*/0 * * * *'])
      expect(() => cronSchedule(e)).toThrow();
  });
  describe('previousDue (catch-up, §8.3)', () => {
    it('cron: the most recent matching minute at or before now', () => {
      const s = cronSchedule('0 1 * * *');
      expect(s.previousDue(at('2026-10-06T13:00:00Z'))).toEqual(at('2026-10-06T01:00:00Z'));
      expect(s.previousDue(at('2026-10-06T00:30:00Z'))).toEqual(at('2026-10-05T01:00:00Z'));
      expect(s.previousDue(at('2026-10-06T01:00:45Z'))).toEqual(at('2026-10-06T01:00:00Z'));
    });
    it('cron: undefined when nothing matched within the bounded walk', () => {
      expect(cronSchedule('0 0 31 2 *').previousDue(at('2026-10-06T13:00:00Z'))).toBeUndefined();
    });
    it('month start: the latest 00:05 UTC on the 1st', () => {
      expect(MONTH_START.previousDue(at('2026-10-06T13:00:00Z'))).toEqual(at('2026-10-01T00:05:00Z'));
      expect(MONTH_START.previousDue(at('2026-10-01T00:04:00Z'))).toEqual(at('2026-09-01T00:05:00Z'));
    });
    it('anyOf: the latest defined previousDue of its parts', () => {
      const s = anyOf(cronSchedule('0 6 * * *'), MONTH_START, intervalSchedule(60));
      expect(s.previousDue(at('2026-10-06T13:00:00Z'))).toEqual(at('2026-10-06T06:00:00Z'));
      expect(s.previousDue(at('2026-10-01T03:00:00Z'))).toEqual(at('2026-10-01T00:05:00Z'));
      expect(anyOf(intervalSchedule(60)).previousDue(at('2026-10-06T13:00:00Z'))).toBeUndefined();
    });
    it('interval: undefined (interval timers need no catch-up)', () => {
      expect(intervalSchedule(60).previousDue(at('2026-10-06T13:00:00Z'))).toBeUndefined();
    });
  });
});
