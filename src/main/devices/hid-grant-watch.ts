// "Revoking the grant forgets every device" (ADR-0068). The broker says only that an origin's grants changed, not which
// one, so each change asks whether an app that has devices still holds `devices.hid`, live or on disk. The disk
// matters: an app not opened this session is revoked through its persisted record, with no live grant to read.
import type { Broker } from '../../broker/broker-contracts.js'
import type { HidApprovals } from './hid-approvals.js'
import { filtersFromPatterns } from './hid-policy.js'

type WatchedBroker = Pick<Broker, 'onGrantsChanged'> & { readonly app: Pick<Broker['app'], 'grantedPatternsSync' | 'heldSync' | 'isRegisteredSync' | 'persistedAppsSync'> }

/**
 * Returns the unsubscribe. A website's devices are untouched: it has no grant to lose. A grant that is replaced by
 * narrower or different filters keeps only the devices a filter's vendor and product still match; the usage fields
 * are not read, because a stored device does not carry its collections.
 */
export function forgetDevicesWhenGrantEnds (broker: WatchedBroker, approvals: Pick<HidApprovals, 'list' | 'forget' | 'forgetOrigin'>): () => void {
  return broker.onGrantsChanged((origin) => {
    const approved = approvals.list(origin)
    if (approved.length === 0) return
    const persisted = broker.app.persistedAppsSync().find((app) => app.origin === origin)
    if (!broker.app.isRegisteredSync(origin) && persisted === undefined) return
    const patterns = broker.app.grantedPatternsSync(origin, 'devices.hid') ?? persisted?.grants['devices.hid']?.patterns
    if (patterns === undefined) {
      approvals.forgetOrigin(origin)
      return
    }
    const filters = filtersFromPatterns(patterns)
    for (const device of approved) {
      if (!filters.some((filter) => filter.vendorId === device.vendorId && (filter.productId === undefined || filter.productId === device.productId))) approvals.forget(origin, device.key)
    }
  })
}
