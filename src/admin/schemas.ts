/** Admin request schemas (§9.2): content fields, the two create bodies and the list query. */
import { z } from 'zod';
import { validatePath } from '../lib/urls.js';

// Control characters, line breaks (incl. U+2028 LINE SEPARATOR, U+2029 PARAGRAPH SEPARATOR) and tabs, `<`, `>`
// and Unicode direction overrides U+202A–U+202E, U+2066–U+2069 (§3.3).
const FORBIDDEN_TEXT = /[<>\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/**
 * Ill-formed UTF-16 (a lone surrogate) cannot be stored as sent: the driver would replace it with U+FFFD.
 * `String.prototype.isWellFormed` is in Node 22 but not in the ES2023 lib the build targets, hence the cast.
 */
const wellFormed = (s: string) => (s as string & { isWellFormed(): boolean }).isWellFormed();

/** Plain-text headline/subheadline: trimmed, 1–255 characters, no markup, control or direction-override characters. */
export const plainText = (field: string) =>
  z
    .string({ message: `${field} must be a string` })
    .trim()
    .min(1, `${field} must be 1-255 characters`)
    .refine((s) => [...s].length <= 255, `${field} must be 1-255 characters`)
    .refine(wellFormed, `${field} contains forbidden characters`)
    .refine((s) => !FORBIDDEN_TEXT.test(s), `${field} contains forbidden characters`);

/** A site-relative path (§3.1) of at most `max` characters. */
export const pathField = (field: string, max: number) =>
  z
    .string({ message: `${field} must be a string` })
    .max(max, `${field} must be at most ${max} characters`)
    .refine(wellFormed, `${field} must be a relative path`)
    .refine(validatePath, `${field} must be a relative path`);

/** The content fields shared by every create (and, later, the update). */
export const contentFields = {
  image: pathField('image', 1024),
  headline: plainText('headline'),
  subheadline: plainText('subheadline'),
  link: pathField('link', 2048),
};

const enumArray = <T extends [string, ...string[]]>(values: T) =>
  z.array(z.enum(values)).transform((a) => [...new Set(a)]);

/** The accounts table's `credits` column is a signed INT, so a bound above its maximum is meaningless. */
const MAX_CREDITS = 2147483647;
const credit = z
  .number()
  .int('credits must be integers')
  .min(0, 'credits must be >= 0')
  .max(MAX_CREDITS, `credits must be <= ${MAX_CREDITS}`);

/** Filters (§5.4): every key optional; duplicates removed; empty arrays dropped so they are never stored. */
export const filtersSchema = z
  .strictObject({
    country: enumArray(['US', 'CA']).optional(),
    policy: enumArray(['monthly', 'annual']).optional(),
    relationshipStatus: enumArray(['newMember', 'friend', 'bff']).optional(),
    credits: z
      .strictObject({ minimum: credit.optional(), maximum: credit.optional() })
      .refine(
        (c) => c.minimum === undefined || c.maximum === undefined || c.maximum >= c.minimum,
        'credits.maximum must be >= credits.minimum',
      )
      .optional(),
  })
  .transform((f) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      out[k] = v;
    }
    return out;
  });

export type Filters = z.output<typeof filtersSchema>;

export const createFilterSchema = z.strictObject({
  ...contentFields,
  isActive: z.boolean({ message: 'isActive must be a boolean' }),
  filters: filtersSchema.optional(),
});

export const EVENT_TRIGGERS = ['shipped', 'enrolled', 'preenrollAudiobook'] as const;

export const createEventSchema = z.strictObject({
  ...contentFields,
  isActive: z.boolean({ message: 'isActive must be a boolean' }),
  eventTrigger: z.enum(EVENT_TRIGGERS),
  delay: z.number().int('delay must be an integer').min(0).max(365).optional(),
});

/** One query value: a repeated parameter (array) is rejected. */
const queryString = (field: string) => z.string({ message: `${field} must be given once` });

export const listQuerySchema = z.strictObject({
  limit: queryString('limit')
    .regex(/^[0-9]+$/, 'limit must be a positive integer')
    .transform(Number)
    .refine((n) => n >= 1, 'limit must be a positive integer')
    .transform((n) => Math.min(n, 25))
    .optional(),
  cursor: queryString('cursor').optional(),
  type: z.enum(['filter', 'event', 'csv']).optional(),
  createdFrom: queryString('createdFrom').optional(),
  createdTo: queryString('createdTo').optional(),
});

/** The `:id` route parameter: a positive integer within the INT UNSIGNED range. */
export const idParamSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,9}$/, 'id must be a positive integer')
  .transform(Number)
  .refine((n) => n <= 4294967295, 'id must be a positive integer');

const UPDATE_BODY_MESSAGE = 'body must be exactly one of {"isActive": boolean} or {"isRemoved": true}';

/**
 * PATCH /admin/notifications/:id: exactly one of `isActive` (boolean) or `isRemoved` (literal true).
 * Every bad shape reports UPDATE_BODY_MESSAGE: zod returns a strict object's unrecognized-keys issue
 * directly (not as a union failure), so each option carries the same error map as the union.
 */
const updateBodyErrors = { errorMap: () => ({ message: UPDATE_BODY_MESSAGE }) };
export const updateNotificationSchema = z.union(
  [
    z.strictObject({ isActive: z.boolean() }, updateBodyErrors),
    z.strictObject({ isRemoved: z.literal(true) }, updateBodyErrors),
  ],
  updateBodyErrors,
);

export type UpdateNotificationBody = z.output<typeof updateNotificationSchema>;
