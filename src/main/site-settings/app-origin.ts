// The tests for "this origin belongs to an app". `isAppOrigin` is the one the per-site content surfaces share (the
// permission asker, the content rules and the Settings and popover controller): their permissions are the manifest's,
// never a prompt's, so they all have to agree on what an app is. The media surfaces also count an origin the broker
// registered, but the person's own site rules still apply to it until it holds a grant or is served from the cache.
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import type { SubsystemContext } from '../registry.js'

/** An origin holding grants, or one served from the cache. */
export function isAppOrigin (ctx: Pick<SubsystemContext, 'broker'>, origin: string): boolean {
  return ctx.broker?.app.hasGrantsSync(origin) === true || isOriginServedFromCacheSync(origin)
}

/**
 * `isAppOrigin`, or an origin the broker registered. Registration happens before consent and a declined origin stays
 * registered, so this is for the screen and the media grants (an app is shown no picker and no prompt of its own
 * accord). It is not the question for the person's own site rules: site settings show a registered origin that holds
 * no grant as a website, so the media surfaces check `isAppOrigin` too and let the person's block win for it.
 */
export function isRegisteredAppOrigin (ctx: Pick<SubsystemContext, 'broker'>, origin: string): boolean {
  return ctx.broker?.app.isRegisteredSync(origin) === true || isAppOrigin(ctx, origin)
}
