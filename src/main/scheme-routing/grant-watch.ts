// "Revoking the app's grant ends its default" (d-0596). Routing already refuses an app that holds no grant, but a
// default left standing would come back on its own the day the app is granted again, which the person never asked for.
// The broker says only that an origin's grants changed, so each change asks whether an app that is a default still
// holds a grant, live or on disk (an app not opened this session is revoked through its persisted record).
import type { Broker } from '../../broker/broker-contracts.js'
import type { SchemeChoices } from './scheme-choices.js'

type WatchedBroker = Pick<Broker, 'onGrantsChanged'> & { readonly app: Pick<Broker['app'], 'hasGrantsSync' | 'isRegisteredSync' | 'persistedAppsSync'> }

/** Returns the unsubscribe. */
export function forgetChoicesWhenGrantEnds (broker: WatchedBroker, choices: Pick<SchemeChoices, 'schemesOf' | 'forget'>): () => void {
  return broker.onGrantsChanged((origin) => {
    const schemes = choices.schemesOf(origin)
    if (schemes.length === 0) return
    const persisted = broker.app.persistedAppsSync().find((app) => app.origin === origin)
    if (!broker.app.isRegisteredSync(origin) && persisted === undefined) return
    if (broker.app.hasGrantsSync(origin) || Object.keys(persisted?.grants ?? {}).length > 0) return
    for (const scheme of schemes) choices.forget(scheme)
  })
}
