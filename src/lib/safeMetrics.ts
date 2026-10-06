import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

const SAFE = Symbol('safeMetrics');

/**
 * Wraps a metrics sink so a throwing emit is swallowed: metrics never fail or stall the caller (§9). The first failure
 * per metric name is logged; repeats are not. Idempotent: wrapping an already-safe sink returns it unchanged.
 */
export function safeMetrics(metrics: Metrics, log: Logger): Metrics {
  if ((metrics as Metrics & { [SAFE]?: true })[SAFE]) return metrics;
  const warned = new Set<string>();
  const guard =
    <A extends [string, ...unknown[]]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      try {
        fn(...a);
      } catch (err) {
        if (warned.has(a[0])) return;
        warned.add(a[0]);
        log.warn({ err, metric: a[0] }, 'metric emission failed');
      }
    };
  return {
    count: guard(metrics.count.bind(metrics)),
    timing: guard(metrics.timing.bind(metrics)),
    gauge: guard(metrics.gauge.bind(metrics)),
    [SAFE]: true,
  } as Metrics;
}
