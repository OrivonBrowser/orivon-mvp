// An app taken away leaves no route behind. The broker says only that an origin's grants changed, so each change asks
// whether the app is still known here, live or on disk; once it is not, its route entry, front and sessions go.
import type { Broker } from '../../broker/broker-contracts.js'
import type { RouteService } from './route-service.js'

type WatchedBroker = Pick<Broker, 'onGrantsChanged'> & { readonly app: Pick<Broker['app'], 'isRegisteredSync' | 'persistedAppsSync'> }

/** Returns the unsubscribe. */
export function forgetRoutesOfGoneApps (broker: WatchedBroker, routes: Pick<RouteService, 'forget' | 'hub'>): () => void {
  return broker.onGrantsChanged((origin) => {
    if (!routes.hub.isRouted(origin)) return
    if (broker.app.isRegisteredSync(origin) || broker.app.persistedAppsSync().some((app) => app.origin === origin)) return
    routes.forget(origin)
  })
}
