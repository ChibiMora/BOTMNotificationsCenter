import { describe, it, expect } from 'vitest';
import {
  windowStart,
  monthKey,
  truncateToSecond,
  formatTimestamp,
  parseRequestTimestamp,
} from '../../src/lib/time.js';
import { AppError } from '../../src/lib/errors.js';

const d = (s: string) => new Date(s);
describe('window and month', () => {
  it('window at month/year boundaries', () => {
    const now = d('2026-10-01T00:00:00Z');
    expect(d('2026-08-31T23:59:59Z') < windowStart(now)).toBe(true);
    expect(d('2026-09-01T00:00:00Z') >= windowStart(now)).toBe(true);
    expect(windowStart(d('2027-01-15T10:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
  it('monthKey', () => {
    expect(monthKey(d('2026-12-31T23:59:59Z'))).toBe('2026-12');
    expect(monthKey(d('2027-01-01T00:00:00Z'))).toBe('2027-01');
  });
});
describe('formatting', () => {
  it('truncates and formats with Z, second precision', () => {
    expect(truncateToSecond(d('2026-10-04T14:30:00.999Z')).toISOString()).toBe('2026-10-04T14:30:00.000Z');
    expect(formatTimestamp(d('2026-10-04T14:30:00.999Z'))).toBe('2026-10-04T14:30:00Z');
  });
});
describe('parseRequestTimestamp', () => {
  const tz = 'America/New_York';
  it('Z and offset', () => {
    expect(formatTimestamp(parseRequestTimestamp('2026-10-04T14:30:00Z', tz))).toBe('2026-10-04T14:30:00Z');
    expect(formatTimestamp(parseRequestTimestamp('2026-10-04T10:30:00-04:00', tz))).toBe(
      '2026-10-04T14:30:00Z',
    );
  });
  it('fractional seconds floored', () => {
    expect(formatTimestamp(parseRequestTimestamp('2026-10-04T14:30:00.987Z', tz))).toBe(
      '2026-10-04T14:30:00Z',
    );
  });
  it('date-only is business-timezone midnight across DST', () => {
    expect(formatTimestamp(parseRequestTimestamp('2026-11-01', tz))).toBe('2026-11-01T04:00:00Z');
    expect(formatTimestamp(parseRequestTimestamp('2026-11-02', tz))).toBe('2026-11-02T05:00:00Z');
    expect(formatTimestamp(parseRequestTimestamp('2026-03-08', tz))).toBe('2026-03-08T05:00:00Z');
    expect(formatTimestamp(parseRequestTimestamp('2026-03-09', tz))).toBe('2026-03-09T04:00:00Z');
  });
  it('garbage rejected', () => {
    for (const s of [
      '',
      'tomorrow',
      '2026-13-01',
      '2026-02-30',
      '2026-10-04T14:30:00',
      '2026-10-04 14:30:00Z',
      '1700000000',
    ]) {
      expect(() => parseRequestTimestamp(s, tz), s).toThrow(AppError);
    }
  });
});
describe('parseRequestTimestamp DST gap at midnight', () => {
  it('returns the first instant of the local date (America/Santiago 2025-09-07)', () => {
    expect(parseRequestTimestamp('2025-09-07', 'America/Santiago').toISOString()).toBe(
      '2025-09-07T04:00:00.000Z',
    );
  });
  it('ordinary Santiago dates are local midnight', () => {
    expect(parseRequestTimestamp('2025-09-08', 'America/Santiago').toISOString()).toBe(
      '2025-09-08T03:00:00.000Z',
    );
    expect(parseRequestTimestamp('2025-09-06', 'America/Santiago').toISOString()).toBe(
      '2025-09-06T04:00:00.000Z',
    );
  });
});
