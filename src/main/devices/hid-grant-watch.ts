// "Revoking the grant forgets every device" (ADR-0068). The broker says only that an origin's grants changed, not which
// one, so each change asks whether an app that has devices still holds `devices.hid`, live or on disk. The disk
// matters: an app not opened this session is revoked through its persisted record, with no live grant to read.
import type { Broker } from '../../broker/broker-contracts.js'
import type { HidApprovals } from './hid-approvals.js'

type WatchedBroker = Pick<Broker, 'onGrantsChanged'> & { readonly app: Pick<Broker['app'], 'heldSync' | 'isRegisteredSync' | 'persistedAppsSync'> }

/** Returns the unsubscribe. A website's devices are untouched: it has no grant to lose. */
export function forgetDevicesWhenGrantEnds (broker: WatchedBroker, approvals: Pick<HidApprovals, 'list' | 'forgetOrigin'>): () => void {
  return broker.onGrantsChanged((origin) => {
    if (approvals.list(origin).length === 0) return
    const persisted = broker.app.persistedAppsSync().find((app) => app.origin === origin)
    if (!broker.app.isRegisteredSync(origin) && persisted === undefined) return
    if (broker.app.heldSync(origin, 'devices.hid') || persisted?.grants['devices.hid'] !== undefined) return
    approvals.forgetOrigin(origin)
  })
}
