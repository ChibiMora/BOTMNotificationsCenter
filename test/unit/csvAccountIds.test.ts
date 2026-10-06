import { describe, expect, it } from 'vitest';
import { readAccountIds, CsvShapeError } from '../../src/lib/csvAccountIds.js';
import { checkCsvShape } from '../../src/admin/csvShape.js';

const awkward = [
  'accountID\n3\n1\n3\n',
  'accountID\n9',
  '﻿accountID\r\n5\r\n\r\n6\r\n5\r\n\r\n\r\n',
  'accountID\r5\r7\r',
  'accountID\n\n\n4\n\n2\n\n',
];

describe('readAccountIds', () => {
  it.each(awkward)('yields the ids the upload check returns, in order (%j)', async (text) => {
    const buf = Buffer.from(text, 'utf8');
    const ids = await checkCsvShape(buf, { maxBytes: 1000, maxRows: 100 });
    const rows: Array<{ row: number; id: number }> = [];
    for await (const r of readAccountIds(buf)) rows.push(r);
    expect(rows).toEqual(ids.map((id, i) => ({ row: i + 1, id })));
  });
  it('skips blank lines without counting them as rows', async () => {
    const rows: Array<{ row: number; id: number }> = [];
    for await (const r of readAccountIds(Buffer.from('accountID\n\n4\n\n2\n'))) rows.push(r);
    expect(rows).toEqual([
      { row: 1, id: 4 },
      { row: 2, id: 2 },
    ]);
  });
  it.each([
    'id\n1\n',
    'accountID\n 1\n',
    'accountID\n1 \n',
    'accountID\n"1"\n',
    'accountID\n0\n',
    'accountID\n1,2\n',
  ])('throws CsvShapeError on %j', async (text) => {
    const drain = async () => {
      for await (const _ of readAccountIds(Buffer.from(text))) void _;
    };
    await expect(drain()).rejects.toBeInstanceOf(CsvShapeError);
  });
});
