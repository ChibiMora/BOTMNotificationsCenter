/** POST /admin/notifications/event (§3.4, §9.4). No job: event deliveries are made by the trigger endpoint. */
import type Koa from 'koa';
import type { Deps } from '../lib/deps.js';
import { createEventSchema } from './schemas.js';
import { insertIdempotent } from './idempotentInsert.js';
import { presentDetail } from './presenter.js';

export async function createEvent(deps: Deps, ctx: Koa.Context) {
  const body = createEventSchema.parse(ctx.request.body);
  // Hashed as stored: an absent delay is the stored null.
  const { row } = await insertIdempotent(
    deps,
    ctx,
    'event',
    { ...body, delay: body.delay ?? null },
    {
      image_key: body.image,
      headline: body.headline,
      subheadline: body.subheadline,
      link_path: body.link,
      active: body.isActive,
      event_trigger: body.eventTrigger,
      delay: body.delay ?? null,
    },
  );
  ctx.status = 201;
  ctx.body = presentDetail(deps.config, row);
}
