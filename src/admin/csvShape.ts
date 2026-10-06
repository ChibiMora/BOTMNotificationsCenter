/** CSV shape validator for imports (§7.3 step 2, rule B12). Pure: no I/O beyond parsing the given bytes. */
import { validationError } from '../lib/errors.js';
import { readAccountIds, CsvShapeError } from '../lib/csvAccountIds.js';

export interface CsvLimits {
  maxBytes: number;
  maxRows: number;
}

/**
 * Validates the whole upload and returns the account ids of its data rows in file order (index + 1 = the 1-based
 * data-row number), as read by lib/csvAccountIds (the same reader the job uses). Ids above Number.MAX_SAFE_INTEGER are rejected (they cannot be represented exactly); larger-than-INT
 * ids are accepted and reported later as unknown accounts. Throws a 400 VALIDATION_ERROR on any violation.
 */
export async function checkCsvShape(data: Buffer, limits: CsvLimits): Promise<number[]> {
  if (data.length > limits.maxBytes) throw validationError(`file exceeds ${limits.maxBytes} bytes`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw validationError('file must be UTF-8 text');
  }
  const ids: number[] = [];
  try {
    for await (const { id } of readAccountIds(data)) {
      ids.push(id);
      if (ids.length > limits.maxRows) throw validationError(`file exceeds ${limits.maxRows} data rows`);
    }
  } catch (err) {
    if (err instanceof CsvShapeError) throw validationError(err.message);
    throw err;
  }
  if (ids.length === 0) throw validationError('file has no data rows');
  return ids;
}
