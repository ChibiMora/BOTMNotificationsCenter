import type { Clock } from '../../src/lib/clock.js';
export class FixedClock implements Clock {
  constructor(private t: Date = new Date('2026-10-04T14:30:00Z')) {}
  now() {
    return new Date(this.t);
  }
  set(t: Date | string) {
    this.t = new Date(t);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}
