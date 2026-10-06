/**
 * The one reader of import CSV files (§7.3, rule B12), shared by the upload check (admin/csvShape) and the
 * `process_import` job so both see exactly the same data rows with the same row numbers.
 */
import { parse } from 'csv-parse';

const CSV_HEADER = 'accountID';
const ID_RE = /^[1-9][0-9]*$/;

/** A shape violation; `message` is client-safe (the upload check maps it to a 400 VALIDATION_ERROR). */
export class CsvShapeError extends Error {
  override name = 'CsvShapeError';
}

/**
 * Yields each data row of a UTF-8 CSV file as `{ row, id }`, in file order, `row` being the 1-based data-row number.
 * Tolerates a UTF-8 BOM and LF, CRLF or CR line endings; the first line must be exactly the header `accountID`;
 * blank lines are skipped and are not data rows; every other line must be one positive integer that is a safe
 * integer. Throws CsvShapeError on the first violation. Callers check size, encoding and row caps themselves.
 */
export async function* readAccountIds(data: Buffer): AsyncGenerator<{ row: number; id: number }> {
  const parser = parse(data, { bom: true, quote: false, relax_column_count: true, skip_empty_lines: false });
  let line = 0;
  let row = 0;
  for await (const record of parser as AsyncIterable<string[]>) {
    line += 1;
    if (line === 1) {
      if (record.length !== 1 || record[0] !== CSV_HEADER)
        throw new CsvShapeError(`first line must be exactly ${CSV_HEADER}`);
      continue;
    }
    if (record.length === 1 && record[0] === '') continue;
    const value = record.length === 1 ? record[0]! : '';
    const id = Number(value);
    if (!ID_RE.test(value) || !Number.isSafeInteger(id)) {
      throw new CsvShapeError(`line ${line} must be one positive integer account id`);
    }
    row += 1;
    yield { row, id };
  }
  if (line === 0) throw new CsvShapeError('file is empty');
}
