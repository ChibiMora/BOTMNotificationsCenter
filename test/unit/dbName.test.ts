import { describe, it, expect } from 'vitest';
import { checkDbCommand } from '../../scripts/db.js';
describe('db command name guard', () => {
  it('accepts the three commands with a [A-Za-z0-9_]+ name', () => {
    for (const cmd of ['create', 'migrate', 'drop'])
      expect(checkDbCommand(cmd, 'u0_fix_c')).toEqual({ ok: true, cmd, name: 'u0_fix_c' });
  });
  it('rejects unknown commands, missing names and invalid patterns', () => {
    for (const [cmd, name] of [
      ['wipe', 'x'],
      [undefined, 'x'],
      ['create', undefined],
      ['create', ''],
      ['create', 'bad-name'],
      ['drop', 'a`b'],
      ['drop', 'a b'],
    ])
      expect(checkDbCommand(cmd, name)).toMatchObject({ ok: false, reason: 'usage' });
  });
  it('refuses reserved schemas in any case', () => {
    for (const name of ['mysql', 'sys', 'information_schema', 'performance_schema', 'MySQL', 'SYS'])
      for (const cmd of ['create', 'migrate', 'drop'])
        expect(checkDbCommand(cmd, name)).toMatchObject({ ok: false, reason: 'reserved' });
  });
});
