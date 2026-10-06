import { describe, it, expect } from 'vitest';
import { emfMetrics } from '../../src/lib/metrics.js';
import { createLogger, type Logger } from '../../src/lib/logger.js';
import type { Clock } from '../../src/lib/clock.js';

const at = new Date('2026-10-01T12:00:00Z');
const clock: Clock = { now: () => at };
const capture = () => {
  const lines: any[] = [];
  const log = { info: (o: unknown) => lines.push(o) } as unknown as Logger;
  return { lines, log };
};
const emf = (name: string, unit: string, dims: string[]) => ({
  Timestamp: at.getTime(),
  CloudWatchMetrics: [
    { Namespace: 'NotificationCenter', Dimensions: [dims], Metrics: [{ Name: name, Unit: unit }] },
  ],
});
describe('emfMetrics', () => {
  it('count emits one EMF line with the clock timestamp', () => {
    const { lines, log } = capture();
    emfMetrics(log, clock).count('deliveries_inserted', 3, { job: 'fanout_filter' });
    expect(lines).toEqual([
      { _aws: emf('deliveries_inserted', 'Count', ['job']), job: 'fanout_filter', deliveries_inserted: 3 },
    ]);
  });
  it('count defaults to 1', () => {
    const { lines, log } = capture();
    emfMetrics(log, clock).count('x');
    expect(lines).toEqual([{ _aws: emf('x', 'Count', []), x: 1 }]);
  });
  it('timing emits Milliseconds', () => {
    const { lines, log } = capture();
    emfMetrics(log, clock).timing('job_ms', 250, { job: 'a' });
    expect(lines).toEqual([{ _aws: emf('job_ms', 'Milliseconds', ['job']), job: 'a', job_ms: 250 }]);
  });
  it('gauge emits None', () => {
    const { lines, log } = capture();
    emfMetrics(log, clock).gauge('queue_depth', 7, { queue: 'q', env: 'test' });
    expect(lines).toEqual([
      { _aws: emf('queue_depth', 'None', ['queue', 'env']), queue: 'q', env: 'test', queue_depth: 7 },
    ]);
  });
});
describe('createLogger', () => {
  it('honours LOG_LEVEL', () => {
    const warn = createLogger('warn');
    expect(warn.level).toBe('warn');
    expect(warn.isLevelEnabled('info')).toBe(false);
    expect(warn.isLevelEnabled('error')).toBe(true);
    expect(createLogger('silent').isLevelEnabled('fatal')).toBe(false);
    expect(createLogger('debug').isLevelEnabled('debug')).toBe(true);
  });
  it('a dimension named _aws or after the metric cannot overwrite the EMF fields', () => {
    const { lines, log } = capture();
    emfMetrics(log, clock).count('x', 2, { _aws: 'bad', x: 'bad', job: 'j' });
    expect(lines).toEqual([{ _aws: emf('x', 'Count', ['job']), job: 'j', x: 2 }]);
  });
});
