import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

/** Wraps a metrics sink so a throwing emit is logged and swallowed: metrics never fail or stall the caller (§9). */
export function safeMetrics(metrics: Metrics, log: Logger): Metrics {
  const guard =
    <A extends unknown[]>(fn: (...a: A) => void) =>
    (...a: A): void => {
      try {
        fn(...a);
      } catch (err) {
        log.warn({ err, metric: a[0] }, 'metric emission failed');
      }
    };
  return {
    count: guard(metrics.count.bind(metrics)),
    timing: guard(metrics.timing.bind(metrics)),
    gauge: guard(metrics.gauge.bind(metrics)),
  };
}
