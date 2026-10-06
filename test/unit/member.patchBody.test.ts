/** Unit: member PATCH body errors follow the admin wording convention (one "body must be exactly ..." message). */
import { describe, it, expect } from 'vitest';
import { patchBody } from '../../src/member/schemas.js';

describe('member patchBody messages', () => {
  it.each([{}, { isClicked: false }, { isClicked: 'true' }, { isClicked: true, x: 1 }, null, []])(
    'rejects %j with the one body message',
    (body) => {
      const r = patchBody.safeParse(body);
      expect(r.error?.issues[0]?.message).toBe('body must be exactly {"isClicked": true}');
    },
  );
});
