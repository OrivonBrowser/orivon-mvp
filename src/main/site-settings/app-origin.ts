// The one test for "this origin belongs to a registered app", which every per-site surface shares: the permission
// asker, the content rules and the Settings and popover controller. Their permissions are the manifest's, never a
// prompt's, so they all have to agree on what an app is.
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import type { SubsystemContext } from '../registry.js'

/** An origin the broker registered, one holding grants, or one served from the cache. */
export function isAppOrigin (ctx: Pick<SubsystemContext, 'broker'>, origin: string): boolean {
  return ctx.broker?.app.isRegisteredSync(origin) === true || ctx.broker?.app.hasGrantsSync(origin) === true || isOriginServedFromCacheSync(origin)
}
