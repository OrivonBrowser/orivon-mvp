// Where an address goes when a tab is told to open it: in the view the tab has, or in a view of
// the session the address needs. Shared by the address bar and a link followed inside a tab.
import { repartitionView } from './tab-parking.js'
import { gatewayRedirectFor } from './eth-gateway-rule.js'
import { startNavigation } from './leave-page-prompt.js'
import { listOf } from './tab-history.js'
import { EMPTY_OUTER, stepBack, stepForward } from './tab-outer-history.js'
import { appTabFlagChanged, partitionChanged } from './tab-partition.js'
import type { TabRecord } from './tab-types.js'

/** Moves the tab to a view of `target`'s session when the tab's own is not it, or its app-tab flag differs
 * (repartitionView's doc). False when the tab's view fits and the caller loads `target` in it. */
export function repartitionForTarget (id: string, record: TabRecord, target: string, step = false): boolean {
  const swap = partitionChanged(target, record.partition)
  if (swap === undefined && !appTabFlagChanged(target, record.view, record.host.broker)) return false
  // swap.to can itself be undefined (PartitionSwap's own doc) -- ??
  // would wrongly read that as "no swap" and keep the old partition.
  repartitionView(id, record, target, swap !== undefined ? swap.to : record.partition, step)
  return true
}

/** Back from the first page of the tab's view, or Forward from its last, to the page of the tab's outer history
 * beyond it (tab-outer-history.ts). It loads in a view of its own session, as an address typed into the bar would;
 * in the tab's own view when that is one. False when there is no such page.
 *
 * A swap asks the page nothing, so it moves the lists at once. A load in the tab's own view can be refused by the
 * page's leave question, so the moved lists wait as `pending` for the page to commit (tab-history.ts's
 * `settleOuterHistory`), and a load that ends without committing leaves the lists as they were. */
export function stepOutOfView (id: string, record: TabRecord, direction: 'back' | 'forward'): boolean {
  const wc = record.view.webContents
  if (wc.isDestroyed()) return false
  const { entries, index } = listOf(wc)
  const outer = record.outer ?? EMPTY_OUTER
  const step = direction === 'back' ? stepBack(outer, entries, index) : stepForward(outer, entries, index)
  if (step === null) return false
  const target = step.target.url
  record.outer = step.outer
  if (!repartitionForTarget(id, record, target, true)) {
    record.outer = outer
    const next = step.outer
    startNavigation(wc, () => {
      record.outer = { ...(record.outer ?? EMPTY_OUTER), pending: next }
      wc.loadURL(target).catch(() => {
        if (record.outer?.pending !== next) return
        const { pending: _ended, ...kept } = record.outer
        record.outer = kept
      })
    })
  }
  record.host.emitState()
  return true
}

/** Opens `target` in the tab: a view of its session, or the tab's own. */
export function loadInTab (id: string, record: TabRecord, target: string): void {
  if (!repartitionForTarget(id, record, target)) void record.view.webContents.loadURL(target)
}

/** The `.eth` address a link to a gateway address is replaced by before the tab loads it, or undefined to leave the link to the web-request redirect (./eth-gateway-redirect.ts), which keeps a `location.replace`, a form's POST body and the referrer. Only a tab in an app's own session, or one that must move to the mapped address's session or app-tab flag, needs the replacement: an app's own session has no web-request handler, so the gateway request would reach the network. */
export function gatewayLinkTarget (record: TabRecord, url: string): string | undefined {
  const mapped = gatewayRedirectFor(record.host.services?.settings, url)
  if (mapped === undefined) return undefined
  const moves = record.partition !== undefined || partitionChanged(mapped, record.partition) !== undefined || appTabFlagChanged(mapped, record.view, record.host.broker)
  return moves ? mapped : undefined
}
