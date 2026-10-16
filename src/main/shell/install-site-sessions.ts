// Registered in `./shell-installers.ts`: when a website's tunnel is turned on or off, its open tabs move to the session
// that state calls for (`./site-session-move.ts`), once the sessions follow the switch so that nothing loads in one that
// is not yet pointed. The moving itself is `repartitionView`, the same cross-session move Back across sessions uses.
import type { ShellInstaller } from './shell-installers.js'
import { tabMovesFor } from './site-session-move.js'
import { repartitionView } from './tab-parking.js'
import { partitionForTarget } from './tab-partition.js'

export const installSiteSessions: ShellInstaller = {
  name: 'site-sessions',
  install: (_app, services, ctx) => {
    const routes = ctx.routes
    if (routes === undefined) return
    const move = (origin: string): void => {
      for (const window of services.windows.all()) {
        const { tabs } = window
        const inWindow = tabs.ids().flatMap((id) => {
          const record = tabs.record(id)
          const contents = tabs.liveWebContents(id)
          if (record === undefined || contents === undefined) return []
          return [{ id, url: contents.getURL(), partition: record.partition, showsPage: !record.isDashboardTab && record.internalPage === null && (record.sleeping ?? null) === null }]
        })
        for (const { id, url, to } of tabMovesFor(origin, inWindow, partitionForTarget)) {
          const record = tabs.record(id)
          if (record !== undefined) repartitionView(id, record, url, to)
        }
      }
    }
    // While the list of tunnel settings cannot be read, setting or clearing the proxy, or choosing the other tunnel, changes which websites are routed and in which profile without any of them changing.
    services.settings.onChange((change) => {
      if ((change.key !== 'network.route.proxy' && change.key !== 'network.route.kind') || !routes.hub.unreadable()) return
      routes.controller.settled().then(() => { for (const origin of services.windows.liveTabOrigins()) move(origin) }, (error: unknown) => { console.error('[route] moving tabs after the tunnel changed failed:', error) })
    })
    routes.hub.onChange((origin) => {
      routes.controller.settled().then(() => { move(origin) }, (error: unknown) => { console.error('[route] moving tabs to the session their tunnel calls for failed:', error) })
    })
  }
}
