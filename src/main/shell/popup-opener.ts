// Whether a popup keeps Chromium's own opener link across a navigation, and
// whether that link must be cut instead -- split out of tab-view.ts to keep
// that file under Rule 2's line limit (docs/development/code-guidelines.md),
// the same reason `./devtools-app-origin.ts` exists as its own file.
import type { WebContents } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import type { PartitionSwap } from './tab-view.js'

/** `./popups.ts`'s `routePopup`'s own `isApp`: unlike `partitionForTarget` (tab-view.ts), a held grant DOES count here -- popups.ts's README.md Design notes. */
export function popupTargetIsApp (target: string, broker: Broker | undefined): boolean {
  const origin = originFromUrl(target)
  return origin !== null && (isOriginServedFromCacheSync(origin) || broker?.app.hasGrantsSync(origin) === true)
}

/** A popup whose opener still exists stays in its opener's session on the
 * open web: moving it to the default session would sever `window.opener`,
 * which is what the page opened it for. A move INTO an isolated app still
 * happens, since that is the only session serving the app's pinned bundle. */
export function keepsOpenerSession (wc: WebContents, swap: PartitionSwap): boolean {
  return swap.to === undefined && wc.opener !== null && wc.opener !== undefined
}

/** Whether `wc`'s still-attached opener frame must be cut on this
 * navigation: `routePopup` (popups.ts) only ever asks its own `isApp`
 * question of the URL window.open() was given, at the moment it was given
 * it -- a same-origin popup that later moves ITSELF (`w.location = ...`)
 * into a different, granted or cache-served app never goes through
 * `routePopup` again, so this re-asks the identical question
 * (`popupTargetIsApp`) here, the only other place Chromium ever hands this
 * webContents a new origin to run. Reading the opener's `.url` on an
 * already-destroyed opener throws (Electron, same as `appOrigin` in
 * `./devtools-app-origin.ts`); treated the same as no opener at all rather
 * than a reason to fall through. */
export function openerCutNeeded (wc: WebContents, navigatedUrl: string, broker: Broker | undefined): boolean {
  if (wc.opener === null || wc.opener === undefined) return false
  let openerUrl: string
  try {
    openerUrl = wc.opener.url
  } catch {
    return false
  }
  return originFromUrl(navigatedUrl) !== originFromUrl(openerUrl) && popupTargetIsApp(navigatedUrl, broker)
}

/**
 * Whether any frame of `wc` is an http(s) page. A window-open handler cannot tell which frame is
 * opening, so a local file's request to open another file is refused while one is present.
 * A frame that cannot be read counts as a web frame.
 */
export function hasWebFrame (wc: WebContents): boolean {
  try {
    return wc.mainFrame.framesInSubtree.some((frame) => /^https?:/i.test(frame.url))
  } catch {
    return true
  }
}
