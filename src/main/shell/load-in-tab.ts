// Where an address goes when a tab is told to open it: in the view the tab has, or in a view of
// the session the address needs. Shared by the address bar and a link followed inside a tab.
import { repartitionView } from './tab-parking.js'
import { gatewayRedirectFor } from './eth-gateway-rule.js'
import { appTabFlagChanged, partitionChanged } from './tab-partition.js'
import type { TabRecord } from './tab-types.js'

/** Moves the tab to a view of `target`'s session when the tab's own is not it, or its app-tab flag differs
 * (repartitionView's doc). False when the tab's view fits and the caller loads `target` in it. */
export function repartitionForTarget (id: string, record: TabRecord, target: string): boolean {
  const swap = partitionChanged(target, record.partition)
  if (swap === undefined && !appTabFlagChanged(target, record.view, record.host.broker)) return false
  // swap.to can itself be undefined (PartitionSwap's own doc) -- ??
  // would wrongly read that as "no swap" and keep the old partition.
  repartitionView(id, record, target, swap !== undefined ? swap.to : record.partition)
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
