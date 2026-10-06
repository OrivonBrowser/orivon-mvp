// Tied to Electron through the events of the `WebContents` it wires.
import type { WebContents } from 'electron'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { isNavigationHeld } from './navigation-hold.js'
import { partitionAfterFileBlock, partitionChanged } from './tab-partition.js'
import { repartitionView } from './tab-parking.js'
import type { TabRecord } from './tab-types.js'

interface NavigationEvent {
  readonly url: string
  readonly isMainFrame: boolean
  readonly defaultPrevented: boolean
  preventDefault: () => void
}

/**
 * A link or redirect into an address Orivon serves from its cache loads that address in the
 * partition the tab is in until `did-navigate` swaps it, and for that moment a document can
 * commit from the network, so a name that moved would show its new content before anyone
 * accepted it. This stops the navigation before it starts and loads the address in its own
 * partition, where the pinned files answer (ADR-0056). Typed addresses already do the same
 * (`./tab-navigation.ts`).
 *
 * Only a move INTO a cache-served partition: leaving one for the open web still swaps at
 * `did-navigate`, where nothing of the app's is exposed to the page it reaches.
 */
export function repartitionBeforeCommit (wc: WebContents, id: string, record: TabRecord, shown: () => boolean): void {
  const view = record.view
  const handle = (event: NavigationEvent): void => {
    if (!event.isMainFrame || event.defaultPrevented || !shown() || record.isDashboardTab || record.internalPage !== null) return
    if (isNavigationHeld(wc)) return
    // A link written the way the address bar shows an address (`ipfs://app.eth/`) loads at the URL
    // that scheme is served at (`./served-address.ts`), and that URL is the one whose partition counts.
    const url = BUILTIN_ADDRESSES.servedUrl(event.url) ?? event.url
    const swap = partitionChanged(url, record.partition)
    if (swap?.to === undefined) return
    const nextPartition = swap.to
    event.preventDefault()
    // Not in the event: a view closed from inside its own navigation event is not safe to close.
    setImmediate(() => {
      if (record.view === view && !wc.isDestroyed()) repartitionView(id, record, url, nextPartition)
    })
  }
  wc.on('will-navigate', handle)
  wc.on('will-redirect', handle)
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
