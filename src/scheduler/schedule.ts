// Due-time maths (§8.3), no library: a standard 5-field UTC cron matcher (*, */n, a, a-b, a-b/n, comma lists;
// DOM/DOW ORed when both restricted), interval schedules, and the fixed month-start run (00:05 UTC on the 1st) used by rescan.

export interface Schedule {
  /** True when a run is due at `now`, given when this timer last started (undefined = never in this process). */
  isDue(now: Date, lastStarted: Date | undefined): boolean;
}

const RANGES: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7], // day of week: 0 and 7 are both Sunday (standard cron); 7 is folded to 0 below
];

/** One list item: `*`, `*\/n`, `a`, `a-b` or `a-b/n`. Anything else (names, L, W, #, ?, `a/n`) is rejected. */
const PART = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

function parseField(field: string, [min, max]: [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = PART.exec(part);
    if (!m) throw new Error(`invalid cron field: ${part}`);
    const [, star, a, b, stepText] = m;
    if (stepText !== undefined && !star && b === undefined) throw new Error(`invalid cron field: ${part}`);
    const lo = star ? min : Number(a);
    const hi = star ? max : b !== undefined ? Number(b) : lo;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (lo < min || hi > max || lo > hi)
      throw new Error(`invalid cron range: ${part} (allowed ${min}-${max})`);
    if (step < 1) throw new Error(`invalid cron step: ${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const minuteOf = (d: Date) => Math.floor(d.getTime() / 60_000);

export function cronSchedule(expr: string): Schedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`invalid cron expression: ${expr}`);
  const [mi, h, dom, mon, dowRaw] = fields.map((f, i) => parseField(f, RANGES[i]!));
  const dow = new Set([...dowRaw!].map((d) => (d === 7 ? 0 : d)));
  // Standard cron: when both day fields are restricted (neither starts with `*`), a day matches if EITHER does.
  const bothDaysRestricted = !fields[2]!.startsWith('*') && !fields[4]!.startsWith('*');
  const dayMatches = (d: Date) =>
    bothDaysRestricted
      ? dom!.has(d.getUTCDate()) || dow!.has(d.getUTCDay())
      : dom!.has(d.getUTCDate()) && dow!.has(d.getUTCDay());
  const matches = (d: Date) =>
    mi!.has(d.getUTCMinutes()) && h!.has(d.getUTCHours()) && mon!.has(d.getUTCMonth() + 1) && dayMatches(d);
  return {
    isDue: (now, last) => matches(now) && (last === undefined || minuteOf(last) < minuteOf(now)),
  };
}

export function intervalSchedule(seconds: number): Schedule {
  return {
    isDue: (now, last) => last === undefined || now.getTime() - last.getTime() >= seconds * 1000,
  };
}

export function anyOf(...schedules: Schedule[]): Schedule {
  return {
    isDue: (now, last) => schedules.some((s) => s.isDue(now, last)),
  };
}

/** Rescan's fixed extra run at the start of each month. */
export const MONTH_START: Schedule = cronSchedule('5 0 1 * *');
