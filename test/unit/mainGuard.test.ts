import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
