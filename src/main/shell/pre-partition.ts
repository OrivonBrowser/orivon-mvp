// Tied to Electron through the events of the `WebContents` it wires.
import type { WebContents } from 'electron'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { isNavigationHeld } from './navigation-hold.js'
import { appTabFlagGained, partitionAfterFileBlock, partitionChanged } from './tab-partition.js'
import { repartitionView } from './tab-parking.js'
import { sessionRoutesLike } from '../route/site-routes.js'
import { isTemporaryRoutePartition } from '../route/temporary-routes.js'
import { referrerOfInitiator, topInitiatorUrl } from './initiator-referrer.js'
import type { InitiatorFrame } from './initiator-referrer.js'
import type { TabRecord } from './tab-types.js'

interface NavigationEvent {
  readonly url: string
  readonly isMainFrame: boolean
  readonly defaultPrevented: boolean
  /** The frame that started the navigation: absent on a redirect, null for one no frame started. */
  readonly initiator?: InitiatorFrame | null | undefined
  preventDefault: () => void
}

/**
 * A link or redirect into an app that has a partition of its own loads that address in the
 * partition the tab is in until `did-navigate` swaps it, and for that moment a document can
 * commit from the network, so a name that moved would show its new content before anyone
 * accepted it. This stops the navigation before it starts and loads the address in its own
 * partition, where the pinned files answer (ADR-0056). Typed addresses already do the same
 * (`./tab-navigation.ts`). An app the verifier hands to the shell needs none of this: every
 * session's request for it is answered by the app's own handler.
 *
 * A move INTO a session of its own is made here. A move to the shared session still swaps at
 * `did-navigate`, where nothing of the app's is exposed to the page it reaches, unless the tab's session
 * would send the address less tunnelled than the shared one: then the first request must not
 * commit there either. So is the move of a tab that stays in its session into an app that runs
 * there, as a website does: the view is rebuilt with the app-tab flag before the app's first request.
 *
 * Stopping a navigation loses the referrer Chromium would have sent with it, so a page's link, form or
 * script navigation is re-issued with the one the initiating page would have sent (`./initiator-referrer.ts`):
 * never more than Chromium would have, and none when the page cannot say. A redirect carries none, since the
 * `Referrer-Policy` of the response that redirected is not visible here.
 */
export function repartitionBeforeCommit (wc: WebContents, id: string, record: TabRecord, shown: () => boolean): void {
  const view = record.view
  const handle = (event: NavigationEvent, withReferrer: boolean): void => {
    // A new-tab page moves with its first address, unless the tab has a tunnel choice: then even a link of the page itself is a first request.
    if (!event.isMainFrame || event.defaultPrevented || !shown() || (record.isDashboardTab && record.tunnelChoice === undefined) || record.internalPage !== null) return
    if (isNavigationHeld(wc)) return
    // A link written the way the address bar shows an address (`ipfs://app.eth/`) loads at the URL
    // that scheme is served at (`./served-address.ts`), and that URL is the one whose partition counts.
    const url = BUILTIN_ADDRESSES.servedUrl(event.url) ?? event.url
    const swap = partitionChanged(url, record.partition, record.tunnelChoice)
    // An app that runs in the session the tab is in still needs a view built with the app-tab flag, and the first request must not commit in one built without it.
    const flagOnly = swap === undefined && appTabFlagGained(url, record.view, record.host.broker)
    if (swap === undefined && !flagOnly) return
    // A move to the shared session waits for `did-navigate` when the tab's session sends the address as the shared one would (a popup then keeps its opener); when it would send it differently, as a direct profile or an app set to off does for an address on the tunnel, the first request must not commit there, so the tab moves now and a popup's opener is cut.
    if (swap !== undefined && swap.to === undefined && (isTemporaryRoutePartition(record.partition) || sessionRoutesLike(record.partition, url))) return
    const nextPartition = swap === undefined ? record.partition : swap.to
    event.preventDefault()
    const initiatorUrl = withReferrer ? topInitiatorUrl(event.initiator) : undefined
    const target = event.url
    // Not in the event: a view closed from inside its own navigation event is not safe to close. The page's note of the navigation was sent before it began, so it is here by this turn.
    setImmediate(() => {
      if (record.view === view && !wc.isDestroyed()) repartitionView(id, record, url, nextPartition, false, referrerOfInitiator(wc, initiatorUrl, target))
    })
  }
  wc.on('will-navigate', (event) => { handle(event, true) })
  wc.on('will-redirect', (event) => { handle(event, false) })
}

/**
 * A `file:` document the tab's session does not serve is cancelled by the local-files fence
 * (`../local-files/local-file-fence.ts`), which reports a failed main-frame load with -20. The
 * tab then moves to the session the file belongs in and loads it there: the case the pre-commit
 * check above cannot see, such as a reload after the file was recorded or Back to an old entry.
 */
export function repartitionOnFileBlock (wc: WebContents, id: string, record: TabRecord, shown: () => boolean): void {
  const view = record.view
  wc.on('did-fail-load', (_event, errorCode, _description, failedUrl, isMainFrame) => {
    if (!shown() || record.isDashboardTab || record.internalPage !== null) return
    const swap = partitionAfterFileBlock(failedUrl, errorCode, isMainFrame, record.partition)
    if (swap?.to === undefined) return
    const nextPartition = swap.to
    setImmediate(() => {
      if (record.view === view && !wc.isDestroyed()) repartitionView(id, record, failedUrl, nextPartition)
    })
  })
}
