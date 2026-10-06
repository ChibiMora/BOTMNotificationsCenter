// "Run as main" check shared by the entry points (src/api.ts, src/worker.ts, scripts/db.ts).
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Real path of p, or undefined when it does not exist. */
function realpathOrUndefined(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * True when argv1 (process.argv[1]) names the module at moduleUrl: compares real paths, so symlinked files or
 * directories match, and tolerates a missing `.js` extension (`node dist/api`).
 */
export function isMainModule(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) {
    return false;
  }
  const modulePath = realpathOrUndefined(fileURLToPath(moduleUrl)) ?? fileURLToPath(moduleUrl);
  const candidates = [argv1, `${argv1}.js`];
  return candidates.some((c) => {
    const real = realpathOrUndefined(c);
    return real !== undefined && pathToFileURL(real).href === pathToFileURL(modulePath).href;
  });
}
