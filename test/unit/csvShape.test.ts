import { describe, expect, it } from 'vitest';
import { checkCsvShape } from '../../src/admin/csvShape.js';

const limits = { maxBytes: 1000, maxRows: 5 };
const check = (text: string | Buffer, l = limits) =>
  checkCsvShape(typeof text === 'string' ? Buffer.from(text, 'utf8') : text, l);
const rejects = async (text: string | Buffer, l = limits) =>
  expect(check(text, l)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

describe('checkCsvShape', () => {
  it('accepts a valid file and returns ids in order', async () => {
    expect(await check('accountID\n3\n1\n3\n')).toEqual([3, 1, 3]);
  });
  it('accepts a file without a trailing newline', async () => {
    expect(await check('accountID\n9')).toEqual([9]);
  });
  it('tolerates a UTF-8 BOM', async () => {
    expect(await check('﻿accountID\n5\n')).toEqual([5]);
  });
  it('tolerates CRLF line endings', async () => {
    expect(await check('accountID\r\n5\r\n6\r\n')).toEqual([5, 6]);
  });
  it('tolerates trailing blank lines', async () => {
    expect(await check('accountID\n5\n\n\n')).toEqual([5]);
  });
  it('skips blank lines in the middle (only non-empty lines are data rows)', async () => {
    expect(await check('accountID\n5\n\n6\n')).toEqual([5, 6]);
  });
  it('accepts an id larger than INT (reported later as unknown)', async () => {
    expect(await check('accountID\n4294967296\n')).toEqual([4294967296]);
  });
  it.each(['accountId\n1\n', 'accountID,x\n1\n', '1\n2\n', '"accountID"\n1\n', ' accountID\n1\n', '\n1\n'])(
    'rejects a bad header %j',
    (text) => rejects(text),
  );
  it.each(['abc', '1.5', '-3', '0', '1e3', '+5', ' 7 ', '"7"', '1,2', '07', '12345678901234567890'])(
    'rejects data row %j',
    (row) => rejects(`accountID\n1\n${row}\n`),
  );
  it('rejects non-UTF-8 bytes', () => rejects(Buffer.from([0x61, 0x0a, 0xff, 0xfe, 0x0a])));
  it('rejects an empty file', () => rejects(''));
  it('rejects a header-only file', async () => {
    await rejects('accountID\n');
    await rejects('accountID\n\n\n');
  });
  it('enforces the row cap', async () => {
    expect(await check('accountID\n1\n2\n3\n4\n5\n')).toHaveLength(5);
    await rejects('accountID\n1\n2\n3\n4\n5\n6\n');
  });
  it('enforces the byte cap', async () => {
    const text = 'accountID\n1\n';
    expect(await check(text, { maxBytes: text.length, maxRows: 5 })).toEqual([1]);
    await rejects(text, { maxBytes: text.length - 1, maxRows: 5 });
  });
});
