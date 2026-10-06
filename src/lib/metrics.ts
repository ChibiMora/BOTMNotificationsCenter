import type { Clock } from './clock.js';
import type { Logger } from './logger.js';
export type Dims = Record<string, string>;
export interface Metrics {
  count(name: string, value?: number, dims?: Dims): void;
  timing(name: string, ms: number, dims?: Dims): void;
  gauge(name: string, value: number, dims?: Dims): void;
}
/** CloudWatch Embedded Metric Format written through the logger; Timestamp comes from the injected clock. */
export function emfMetrics(log: Logger, clock: Clock, namespace = 'NotificationCenter'): Metrics {
  const emit = (name: string, value: number, unit: string, dims: Dims = {}) => {
    // '_aws' and the metric's own name are EMF fields; a dimension with either name is dropped, never written over them.
    const safe = Object.fromEntries(Object.entries(dims).filter(([k]) => k !== '_aws' && k !== name));
    log.info({
      ...safe,
      _aws: {
        Timestamp: clock.now().getTime(),
        CloudWatchMetrics: [
          { Namespace: namespace, Dimensions: [Object.keys(safe)], Metrics: [{ Name: name, Unit: unit }] },
        ],
      },
      [name]: value,
    });
  };
  return {
    count: (n, v = 1, d) => emit(n, v, 'Count', d),
    timing: (n, ms, d) => emit(n, ms, 'Milliseconds', d),
    gauge: (n, v, d) => emit(n, v, 'None', d),
  };
}
