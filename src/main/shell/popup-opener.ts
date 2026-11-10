// Whether a popup keeps Chromium's own opener link across a navigation, and
// whether that link must be cut instead -- split out of tab-view.ts to keep
// that file under Rule 2's line limit (docs/development/code-guidelines.md),
// the same reason `./devtools-app-origin.ts` exists as its own file.
import { webContents } from 'electron'
import type { WebContents, WebFrameMain } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { sessionRoutesLike } from '../route/site-routes.js'
import { isWebsitePageOfApp } from './app-session.js'
import { appTabContents } from './tab-partition.js'
import type { PartitionSwap } from './tab-view.js'

/** `./popups.ts`'s `routePopup`'s own `isApp`: unlike `partitionForTarget` (tab-view.ts), a held grant DOES count here -- popups.ts's README.md Design notes. */
export function popupTargetIsApp (target: string, broker: Broker | undefined): boolean {
  const origin = originFromUrl(target)
  return origin !== null && (isOriginServedFromCacheSync(origin) || broker?.app.hasGrantsSync(origin) === true)
}

/** A popup whose opener still exists stays in its opener's session on the open web: moving it to the default session would
 * sever `window.opener`, which is what the page opened it for. A move INTO an isolated app still happens, since that is the
 * only session serving the app's pinned bundle. It does not stay when its opener's session would send the address less tunnelled
 * than the shared one (not through the tunnel for an address that is): `window.opener` is cut, and the popup moves. */
export function keepsOpenerSession (wc: WebContents, swap: PartitionSwap, partition: string | undefined, url: string): boolean {
  return swap.to === undefined && wc.opener !== null && wc.opener !== undefined && sessionRoutesLike(partition, url)
}

/** Whether `frame` is a page of a view built as an app's tab (`./tab-partition.ts`'s `appTabContents`); a frame whose page is gone is none. */
export function frameIsInAppTab (frame: WebFrameMain): boolean {
  const page = webContents.fromFrame(frame)
  return page !== undefined && appTabContents.has(page)
}

/** Whether `wc`'s still-attached opener frame must be cut on this
 * navigation: `routePopup` (popups.ts) only ever asks its own `isApp`
 * question of the URL window.open() was given, at the moment it was given
 * it -- a same-origin popup that later moves ITSELF (`w.location = ...`)
 * into a different, granted or cache-served app never goes through
 * `routePopup` again, so this re-asks the identical question
 * (`popupTargetIsApp`) here, the only other place Chromium ever hands this
 * webContents a new origin to run.
 *
 * A link between two pages of the SAME origin is cut as well when the opener is a website's page of an app the shell now
 * serves (`isWebsitePageOfApp`): the page the person allowed the site over, left open, must not keep a handle on a page that
 * runs with the app's grants, which scripting it needs no more than the same origin.
 *
 * Reading the opener's `.url` on an already-destroyed opener throws (Electron, same as `appOrigin` in
 * `./devtools-app-origin.ts`); treated the same as no opener at all rather than a reason to fall through. */
export function openerCutNeeded (wc: WebContents, navigatedUrl: string, broker: Broker | undefined, openerIsInAppTab: (opener: WebFrameMain) => boolean = frameIsInAppTab): boolean {
  try {
    const opener = wc.opener
    if (opener === null || opener === undefined) return false
    const openerUrl = opener.url
    if (originFromUrl(navigatedUrl) !== originFromUrl(openerUrl)) return popupTargetIsApp(navigatedUrl, broker)
    return isWebsitePageOfApp(openerUrl, openerIsInAppTab(opener))
  } catch {
    return false
  }
}
