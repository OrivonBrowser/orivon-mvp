// A routed app's page opens an address outside the app's own sessions -- a link, a script, a form, `window.open`: the
// person is asked each time whether the page loads through their proxy or directly, and nothing is remembered. The
// decision itself is `../route/leave-decision.ts`; this file asks, and moves the tab (or opens one) as the answer says.
// Tied to Electron through the events of the `WebContents` it guards.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { leaveFor, openTemporaryRoute, routeAppToo } from '../route/leaving-routes.js'
import type { Leave } from '../route/leave-decision.js'
import { gatewayRedirectFor } from './eth-gateway-rule.js'
import { loadInTab } from './load-in-tab.js'
import { askToLeaveRoute } from './leaving-route-prompt.js'
import { holdNavigation, isNavigationHeld } from './navigation-hold.js'
import { repartitionView } from './tab-parking.js'
import type { TabRecord } from './tab-types.js'

/** What the person chose, with the partition a "through my proxy" website opens in. */
export type LeaveChoice =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'direct' }
  | { readonly kind: 'app' }
  | { readonly kind: 'website', readonly partition: string }

/**
 * Asks about `leave` for the page of `contents` (the tab asks in its own panel and its page is held where it is
 * meanwhile), and makes ready what the answer needs: the temporary session for a website, the other app's route for an
 * app. A failure to make it ready cancels the open: it is never turned into a direct one.
 */
export async function chooseLeave (contents: WebContents, openerUrl: string, leave: Leave): Promise<LeaveChoice> {
  const app = originFromUrl(openerUrl)
  if (app === null) return { kind: 'cancel' }
  const release = holdNavigation(contents)
  try {
    const answer = await askToLeaveRoute({ contents }, app, leave)
    if (answer === 'cancel') return { kind: 'cancel' }
    if (answer === 'direct') return { kind: 'direct' }
    if (leave.kind === 'app') return await routeAppToo(leave.origin) ? { kind: 'app' } : { kind: 'cancel' }
    return { kind: 'website', partition: await openTemporaryRoute() }
  } catch (error) {
    console.error('[route] could not make ready what the person chose:', error)
    return { kind: 'cancel' }
  } finally {
    release()
  }
}

/** The address a page's link to `url` loads at, which is the one whose session counts. */
function loadedAt (record: TabRecord, url: string): string {
  return BUILTIN_ADDRESSES.servedUrl(url) ?? gatewayRedirectFor(record.host.services?.settings, url) ?? url
}

/** What a window the page of `from` opens at `url` asks the person, or undefined (route/leave-decision.ts). */
export function leaveForOpen (record: TabRecord, from: string, url: string): Leave | undefined {
  return leaveFor(from, loadedAt(record, url))
}

interface NavigationEvent {
  readonly url: string
  readonly isMainFrame: boolean
  readonly defaultPrevented: boolean
  preventDefault: () => void
}

/**
 * Stops a main-frame navigation or redirect that the page of a routed app starts toward an address outside its sessions,
 * and asks. The tab moves into the session the answer names, keeping the app's view parked for Back
 * (`repartitionView`); a shell-started load (the address bar, history) fires neither event and is never asked.
 */
export function askBeforeLeavingRoute (wc: WebContents, id: string, record: TabRecord, shown: () => boolean): void {
  const view = record.view
  const handle = (event: NavigationEvent): void => {
    if (!event.isMainFrame || event.defaultPrevented || !shown() || record.isDashboardTab || record.internalPage !== null) return
    // A question about this page is already open: the hold drops this navigation.
    if (isNavigationHeld(wc)) return
    const url = loadedAt(record, event.url)
    const from = wc.getURL()
    const leave = leaveFor(from, url)
    if (leave === undefined) return
    event.preventDefault()
    void chooseLeave(wc, from, leave).then((choice) => {
      // The tab moved, closed or went to another page while the question was open: the answer was about a page that is gone.
      if (choice.kind === 'cancel' || record.view !== view || wc.isDestroyed() || !shown()) return
      if (choice.kind === 'website') {
        record.routedAway = choice.partition
        repartitionView(id, record, url, choice.partition)
        return
      }
      loadInTab(id, record, url)
    }).catch((error: unknown) => { console.error('[route] leaving a routed app failed:', error) })
  }
  wc.on('will-navigate', handle)
  wc.on('will-redirect', handle)
}
