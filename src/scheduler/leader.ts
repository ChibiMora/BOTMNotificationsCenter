// Single-leader election (§8.3): MySQL GET_LOCK held on a DEDICATED connection; released when it dies.
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';

const MAX_LOCK_NAME = 64;
/** A lock probe that takes longer than this is treated as a dead connection: leadership is lost at once. */
export const PROBE_TIMEOUT_MS = 5_000;

export interface LeaderOptions {
  probeTimeoutMs?: number;
  /** Opens the dedicated connection (tests inject a fake). */
  connect?: (databaseUrl: string) => Promise<mysql.Connection>;
  /** Schedules `fn` after `ms`; returns a cancel function (tests inject one to fire timeouts without sleeping). */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const defaultConnect = (databaseUrl: string) =>
  mysql.createConnection({
    uri: databaseUrl,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });

const defaultSetTimer = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};

class ProbeTimeout extends Error {}

/** `${namespace}:scheduler`, shortened with a hash when it would exceed MySQL's 64-char lock-name limit. */
export function lockName(namespace: string): string {
  const name = `${namespace}:scheduler`;
  if (name.length <= MAX_LOCK_NAME) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 40);
  return `${namespace.slice(0, MAX_LOCK_NAME - 52)}:sched:${hash}`.slice(0, MAX_LOCK_NAME);
}

export class Leader {
  private conn?: mysql.Connection;
  private held = false;
  private closed = false;
  private pending?: Promise<boolean>;
  private readonly name: string;

  constructor(
    private readonly databaseUrl: string,
    namespace: string,
    private readonly opts: LeaderOptions = {},
  ) {
    this.name = lockName(namespace);
  }

  /** Races `p` against the probe timeout; a half-open connection can never leave a probe pending forever. */
  private withTimeout<T>(p: Promise<T>): Promise<T> {
    const setTimer = this.opts.setTimer ?? defaultSetTimer;
    let cancel = () => undefined as void;
    const timeout = new Promise<never>((_, reject) => {
      cancel = setTimer(
        () => reject(new ProbeTimeout('leader probe timed out')),
        this.opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      );
    });
    return Promise.race([p, timeout]).finally(() => cancel());
  }

  isLeader(): boolean {
    return this.held;
  }

  /** One non-blocking attempt; true while this process holds the lock. Re-run periodically: a dead connection is
   * noticed here (or by its error/end events) and leadership is dropped. Never runs after close(). */
  tryAcquire(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (!this.pending) this.pending = this.attempt().finally(() => (this.pending = undefined));
    return this.pending;
  }

  private async attempt(): Promise<boolean> {
    try {
      if (!this.conn) {
        const connecting = (this.opts.connect ?? defaultConnect)(this.databaseUrl);
        const conn = await this.withTimeout(connecting).catch((e: unknown) => {
          // Timed out: a connection that opens later would otherwise leak, so destroy it when it arrives.
          if (e instanceof ProbeTimeout)
            connecting.then(
              (late) => late.destroy(),
              () => undefined,
            );
          throw e;
        });
        if (this.closed) {
          conn.destroy();
          return false;
        }
        conn.on('error', () => this.drop(conn));
        conn.on('end', () => this.drop(conn));
        this.conn = conn;
      }
      if (this.held) {
        // GET_LOCK is re-entrant: re-acquiring while held would raise the hold count. Verify ownership instead.
        const [rows] = await this.withTimeout(
          this.conn.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS mine', [this.name]),
        );
        this.held = !this.closed && Number((rows as Array<{ mine: number | null }>)[0]?.mine) === 1;
      } else {
        const [rows] = await this.withTimeout(this.conn.query('SELECT GET_LOCK(?, 0) AS got', [this.name]));
        this.held = !this.closed && Number((rows as Array<{ got: number | null }>)[0]?.got) === 1;
      }
    } catch {
      // Error or timeout: leadership is lost now; the connection is destroyed and re-opened on the next attempt.
      this.drop(this.conn);
    }
    return this.held;
  }

  private drop(conn: mysql.Connection | undefined) {
    if (!conn || conn !== this.conn) return;
    this.held = false;
    this.conn = undefined;
    conn.destroy();
  }

  /** Releases the lock and closes the dedicated connection; waits for an in-flight attempt first. */
  async close(): Promise<void> {
    this.closed = true;
    await this.pending?.catch(() => undefined);
    const conn = this.conn;
    this.held = false;
    this.conn = undefined;
    if (!conn) return;
    // Release explicitly so a successor acquires at once; a crashed process releases when its connection dies.
    await this.withTimeout(conn.query('SELECT RELEASE_ALL_LOCKS()')).catch(() => undefined);
    await this.withTimeout(conn.end()).catch(() => conn.destroy());
  }

  /** Server-side id of the dedicated connection (tests use it to KILL the holder). */
  get connectionId(): number | undefined {
    return this.conn?.threadId ?? undefined;
  }
}
