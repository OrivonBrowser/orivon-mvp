// A routed app's page opens an address outside the app's own sessions -- a link, a script, a form, `window.open`: the
// person is asked each time whether the page loads through their proxy or directly, and nothing is remembered. The
// decision itself is `../route/leave-decision.ts`; this file asks, and moves the tab (or opens one) as the answer says.
// Tied to Electron through the events of the `WebContents` it guards.
import type { WebContents } from 'electron'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { isRoutedPage, leaveFor, openTemporaryRoute, routeAppToo } from '../route/leaving-routes.js'
import type { Leave } from '../route/leave-decision.js'
import { gatewayRedirectFor } from './eth-gateway-rule.js'
import { loadInTab } from './load-in-tab.js'
import { askToLeaveRoute } from './leaving-route-prompt.js'
import { holdNavigation, isNavigationHeld } from './navigation-hold.js'
import { repartitionView } from './tab-parking.js'
import type { TabRecord } from './tab-types.js'

/** What the person chose, with the partition a "through my tunnel" website opens in. */
export type LeaveChoice =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'direct' }
  | { readonly kind: 'app' }
  | { readonly kind: 'website', readonly partition: string }

/** The routed apps with a question open now. */
const asking = new Set<string>()

/**
 * Asks about `leave` for the page of `contents` (the tab asks in its own panel and its page is held where it is
 * meanwhile), and makes ready what the answer needs: the temporary session for a website, the other app's route for an
 * app. A failure to make it ready cancels the open: it is never turned into a direct one.
 */
export async function chooseLeave (contents: WebContents, leave: Leave): Promise<LeaveChoice> {
  // One question at a time for an app, in any of its tabs: what it asks meanwhile is cancelled as a blocked pop-up is,
  // and what it asks after the answer is asked again. Nothing is counted or remembered.
  if (asking.has(leave.app)) return { kind: 'cancel' }
  let release = (): void => {}
  try {
    asking.add(leave.app)
    release = holdNavigation(contents)
    const answer = await askToLeaveRoute({ contents }, leave)
    if (answer === 'cancel') return { kind: 'cancel' }
    if (answer === 'direct') return { kind: 'direct' }
    // A page Orivon loads itself has no proxy button, so nothing else can come back for it.
    if (leave.kind === 'served') return { kind: 'cancel' }
    if (leave.kind === 'app') return await routeAppToo(leave.origin) ? { kind: 'app' } : { kind: 'cancel' }
    return { kind: 'website', partition: await openTemporaryRoute() }
  } catch (error) {
    console.error('[route] could not make ready what the person chose:', error)
    return { kind: 'cancel' }
  } finally {
    release()
    asking.delete(leave.app)
  }
}

/** The address a page's link to `url` loads at, which is the one whose session counts. */
function loadedAt (record: TabRecord, url: string): string {
  return BUILTIN_ADDRESSES.servedUrl(url) ?? gatewayRedirectFor(record.host.services?.settings, url) ?? url
}

/**
 * What the page of `from` opening `url` asks the person, or undefined (route/leave-decision.ts). An address Orivon
 * loads from its own nodes (`ipfs://`, a `.eth` gateway address) is judged by the address it is served at: an
 * installed app is asked about as one, and any other is asked about with no proxy to offer, because Orivon's nodes
 * fetch it and a proxy has no say in that.
 */
export function leaveForOpen (record: TabRecord, from: string, url: string, partition: string | undefined): Leave | undefined {
  // Most pages are no routed app's: that is settled before any address is mapped.
  if (!isRoutedPage(from, partition)) return undefined
  const target = loadedAt(record, url)
  return leaveFor(from, target, partition)
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
    const from = wc.getURL()
    const leave = leaveForOpen(record, from, event.url, record.partition)
    if (leave === undefined) return
    const url = loadedAt(record, event.url)
    event.preventDefault()
    void chooseLeave(wc, leave).then((choice) => {
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
