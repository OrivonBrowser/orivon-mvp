// Registered in `./shell-installers.ts`: when a website's tunnel is turned on or off, its open tabs move to the session
// that state calls for (`./site-session-move.ts`), once the sessions follow the switch so that nothing loads in one that
// is not yet pointed. The moving itself is `repartitionView`, the same cross-session move Back across sessions uses.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { ShellInstaller } from './shell-installers.js'
import { addressOfTab, tabMovesFor } from './site-session-move.js'
import { repartitionView } from './tab-parking.js'
import { partitionForTab } from './tab-partition.js'

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
          return [{ id, url: addressOfTab(contents.getURL(), record), partition: record.partition, showsPage: !record.isDashboardTab && record.internalPage === null && (record.sleeping ?? null) === null, ...(record.tunnelChoice === undefined ? {} : { tunnelChoice: record.tunnelChoice }) }]
        })
        for (const { id, url, to } of tabMovesFor(origin, inWindow, partitionForTab)) {
          const record = tabs.record(id)
          if (record === undefined) continue
          try {
            repartitionView(id, record, url, to)
          } catch (error) {
            // A page left in the session it was in would keep sending as that session does: it is stopped, and the tunnel button says it is not on its tunnel.
            console.error('[route] a tab could not move to the session its tunnel calls for; its loads are stopped:', error)
            tabs.liveWebContents(id)?.stop()
          }
        }
      }
    }
    // The sessions could not be made to follow a switch: what is open on the website is stopped rather than left sending as the session it is in does.
    const stopLoads = (origin: string): void => {
      for (const window of services.windows.all()) {
        for (const id of window.tabs.ids()) {
          const contents = window.tabs.liveWebContents(id)
          const record = window.tabs.record(id)
          if (contents !== undefined && record !== undefined && originFromUrl(addressOfTab(contents.getURL(), record)) === origin) contents.stop()
        }
      }
    }
    // While the list of tunnel settings cannot be read, setting or clearing the proxy, or choosing the other tunnel, changes which websites are routed and in which profile without any of them changing.
    services.settings.onChange((change) => {
      if ((change.key !== 'network.route.proxy' && change.key !== 'network.route.kind') || !routes.hub.unreadable()) return
      routes.controller.settled().then(() => { for (const origin of services.windows.liveTabOrigins()) move(origin) }, (error: unknown) => { console.error('[route] moving tabs after the tunnel changed failed:', error) })
    })
    routes.hub.onChange((origin) => {
      routes.controller.settled().then(() => { move(origin) }, (error: unknown) => {
        console.error('[route] moving tabs to the session their tunnel calls for failed:', error)
        stopLoads(origin)
      })
    })
  }
}
