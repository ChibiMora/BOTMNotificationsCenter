/** The one list page size (§9.6) and the query-value schemas shared by the admin and member list queries. */
import { z } from 'zod';

/** Default and maximum `limit` for every list endpoint; larger values are clamped. */
export const PAGE_SIZE = 25;

/** One query-string value: a repeated parameter (array) is rejected. */
export const queryValue = (field: string) => z.string({ message: `${field} must be given once` });

const LIMIT_MESSAGE = 'limit must be a positive integer';

/** `limit`: integer >= 1, default PAGE_SIZE, values above PAGE_SIZE clamped to PAGE_SIZE. */
export const limitQuery = queryValue('limit')
  .regex(/^[0-9]+$/, LIMIT_MESSAGE)
  .transform(Number)
  .refine((n) => n >= 1, LIMIT_MESSAGE)
  .transform((n) => Math.min(n, PAGE_SIZE))
  .default(String(PAGE_SIZE));
