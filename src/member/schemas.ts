/** Zod schemas for the member operations (§9.2): params, list query, decoded list cursor, PATCH body. All `.strict()`. */
import { z } from 'zod';

export const MAX_LIMIT = 25;

/**
 * What a public_id can possibly be: exactly 15 printable ASCII characters (the column is CHAR(15) ascii_bin).
 * Anything else can never match a row; comparing it in SQL would raise a collation error or hit PAD SPACE aliasing.
 */
export const PUBLIC_ID_SHAPE = /^[\x21-\x7e]{15}$/;

/** `:id` is a delivery public_id; never shape-validated (B14) — any string is looked up. */
export const idParams = z.object({ id: z.string() }).strict();

/** GET /notifications query. `limit`: integer >= 1, default 25, values above 25 clamped to 25. */
export const listQuery = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/, 'limit must be an integer between 1 and 25')
      .transform(Number)
      .refine((n) => n >= 1, 'limit must be an integer between 1 and 25')
      .transform((n) => Math.min(n, MAX_LIMIT))
      .default(String(MAX_LIMIT)),
    cursor: z.string().optional(),
  })
  .strict();

/** Decoded list cursor (§7.5): `s` = sent_at of the last item (whole-second ISO-8601 UTC `Z`), `p` = its public_id. */
export const listCursor = z
  .object({
    s: z.string().datetime({ precision: 0, message: 'malformed cursor' }),
    p: z.string({ message: 'malformed cursor' }).regex(PUBLIC_ID_SHAPE, 'malformed cursor'),
  })
  .strict();

/** PATCH /notifications/:id body: exactly `{ "isClicked": true }`. */
export const patchBody = z.object({ isClicked: z.literal(true) }).strict();

export type ListQuery = z.infer<typeof listQuery>;
