// safeMetrics (§9 metrics): a throwing sink is swallowed, warned once per metric name, and wrapping is idempotent.
import { describe, it, expect } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';
import { safeMetrics } from '../../src/lib/safeMetrics.js';
import type { Metrics } from '../../src/lib/metrics.js';

const boom = () => {
  throw new Error('sink down');
};
const throwing = { count: boom, timing: boom, gauge: boom } as unknown as Metrics;

function capturingLog() {
  const log = createLogger('silent');
  const warns: Array<[unknown, unknown]> = [];
  log.warn = ((obj: unknown, msg?: unknown) => void warns.push([obj, msg])) as typeof log.warn;
  return { log, warns };
}

describe('safeMetrics', () => {
  it('warns only on the first failure per metric name', () => {
    const { log, warns } = capturingLog();
    const m = safeMetrics(throwing, log);
    expect(() => {
      m.count('a', 1);
      m.count('a', 1);
      m.timing('a', 5);
      m.gauge('b', 2);
      m.gauge('b', 3);
    }).not.toThrow();
    expect(warns.map(([o]) => (o as { metric: string }).metric)).toEqual(['a', 'b']);
    expect(warns.every(([, msg]) => msg === 'metric emission failed')).toBe(true);
  });

  it('is idempotent: wrapping an already-safe sink returns it unchanged', () => {
    const { log, warns } = capturingLog();
    const once = safeMetrics(throwing, log);
    const twice = safeMetrics(once, log);
    expect(twice).toBe(once);
    twice.count('x', 1);
    expect(warns).toHaveLength(1);
  });

  it('passes emissions through to a working sink', () => {
    const { log } = capturingLog();
    const seen: string[] = [];
    const ok: Metrics = {
      count: (n: string) => void seen.push(`c:${n}`),
      timing: (n: string) => void seen.push(`t:${n}`),
      gauge: (n: string) => void seen.push(`g:${n}`),
    } as unknown as Metrics;
    const m = safeMetrics(ok, log);
    m.count('a', 1);
    m.timing('b', 1);
    m.gauge('c', 1);
    expect(seen).toEqual(['c:a', 't:b', 'g:c']);
  });
});
