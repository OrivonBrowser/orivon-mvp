// The tests for "this origin belongs to an app". `isAppOrigin` is the one the per-site content surfaces share (the
// permission asker, the content rules and the Settings and popover controller): an origin that holds grants has the
// manifest's permissions, never a prompt's, so they all have to agree on what holds them. An installed app that holds
// none is a website to these surfaces: it is asked, and the person's site rules apply to it. The media surfaces also
// count an origin the broker registered or the cache serves, and the person's own block still wins for it.
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import type { SubsystemContext } from '../registry.js'

/** An origin holding grants. */
export function isAppOrigin (ctx: Pick<SubsystemContext, 'broker'>, origin: string): boolean {
  return ctx.broker?.app.hasGrantsSync(origin) === true
}

/**
 * `isAppOrigin`, or an origin the broker registered or the cache serves. Registration happens before consent and a
 * declined origin stays registered, so this is for the screen and the media grants (an app is shown no picker and no
 * prompt of its own accord). It is not the question for the person's own site rules: site settings show a registered or
 * installed origin that holds no grant as a website, so the media surfaces check `isAppOrigin` too and let the
 * person's block win for it.
 */
export function isRegisteredAppOrigin (ctx: Pick<SubsystemContext, 'broker'>, origin: string): boolean {
  return ctx.broker?.app.isRegisteredSync(origin) === true || isOriginServedFromCacheSync(origin) || isAppOrigin(ctx, origin)
}
