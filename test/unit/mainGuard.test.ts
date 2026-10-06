import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isMainModule } from '../../src/api.js';

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mainguard-')));
const real = path.join(dir, 'api.js');
fs.writeFileSync(real, '');
const link = path.join(dir, 'link.js');
fs.symlinkSync(real, link);
const linkDir = path.join(dir, 'linkdir');
fs.symlinkSync(dir, linkDir);
const url = pathToFileURL(real).href;
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('api main guard (isMainModule)', () => {
  it('true for the exact path', () => expect(isMainModule(real, url)).toBe(true));
  it('true for a symlinked file', () => expect(isMainModule(link, url)).toBe(true));
  it('true through a symlinked directory', () =>
    expect(isMainModule(path.join(linkDir, 'api.js'), url)).toBe(true));
  it('true without the .js extension (node dist/api)', () =>
    expect(isMainModule(path.join(dir, 'api'), url)).toBe(true));
  it('false for another module', () => expect(isMainModule(path.join(dir, 'worker.js'), url)).toBe(false));
  it('false when argv[1] is undefined', () => expect(isMainModule(undefined, url)).toBe(false));
});

describe('shared main guard (src/lib/mainModule)', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  it('src/lib/mainModule exports the same isMainModule the API uses', async () => {
    const lib = await import('../../src/lib/mainModule.js');
    expect(lib.isMainModule).toBe(isMainModule);
  });
  it.each(['src/api.ts', 'src/worker.ts', 'scripts/db.ts'])(
    '%s decides "run as main" with isMainModule',
    (f) => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src).toMatch(/from '\.\.?\/(src\/)?lib\/mainModule\.js'/);
      expect(src).toContain('isMainModule(process.argv[1], import.meta.url)');
      expect(src).not.toContain('pathToFileURL(process.argv[1])');
    },
  );
  it('scripts/db.ts run through a symlink still runs (prints usage, exit 2)', () => {
    const link = path.join(dir, 'db.ts');
    fs.symlinkSync(path.join(root, 'scripts/db.ts'), link);
    const r = spawnSync(path.join(root, 'node_modules/.bin/tsx'), [link], { encoding: 'utf8', cwd: root });
    expect(r.stderr).toContain('usage: db create|migrate|drop');
    expect(r.status).toBe(2);
  }, 20000);
});
