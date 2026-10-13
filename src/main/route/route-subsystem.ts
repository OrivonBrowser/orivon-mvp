// Starts the routes: the store of routed apps, the hub and the controller, wired to Electron's sessions, web contents
// and `login` event, and published as `ctx.routes` for the broker and the loader to read. Critical: if this failed, an
// app flagged as routed would go direct.

import { join } from 'node:path'
import { app, session, webContents } from 'electron'
import type { Session } from 'electron'
import { beforeAppSessionServes } from '../../loader/electron/app-partitions.js'
import { setReachRoute } from '../../loader/electron/reach-route.js'
import { embedPartitionFor } from '../embed/embed-guard.js'
import { publishRoutes } from '../registry.js'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { readSettingBeforeReady } from '../settings/settings-file.js'
import { isOriginPinnedSync, isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isPersistableOrigin } from '../../broker/policy/origin.js'
import { setLeavingRoutes } from './leaving-routes.js'
import { setLookupSessionSource, setRouteChallengeSource } from './lookup-session.js'
import { createRouteSwitch } from './route-switch.js'
import { createTemporaryRoutes } from './temporary-routes.js'
import { createRouteService } from './route-service.js'
import { RouteStore } from './route-store.js'

export const routeSubsystem: Subsystem = {
  name: 'route',
  critical: true,
  afterReady: (ctx: SubsystemContext) => {
    const userData = ctx.app.getPath('userData')
    const routes = createRouteService({
      store: new RouteStore(ctx.privateSession ? null : join(userData, 'routes.json')),
      savedProxy: readSettingBeforeReady(join(userData, 'settings.json'), 'network.route.proxy'),
      // Asked only when the list of routed apps cannot be read; the broker exists by then.
      installed: () => [...new Set([...(ctx.broker?.app.registeredOriginsSync() ?? []), ...(ctx.broker?.app.persistedAppsSync().map((installed) => installed.origin) ?? [])])],
      electron: {
        broker: () => ctx.broker,
        sessionFor: (partition) => session.fromPartition(partition),
        embedPartition: embedPartitionFor,
        allContents: () => webContents.getAllWebContents(),
        onContentsCreated: (listener) => { app.on('web-contents-created', (_event, contents) => { listener(contents) }) },
        // Ahead of the sheet that asks the person about a proxy's challenge, which must not see this one.
        onLogin: (listener) => { app.prependListener('login', (event, _contents, _details, info, callback) => { listener(event, info, callback) }) }
      }
    })
    setReachRoute(routes.hub.routeFor)
    // The sessions handed out are Electron's own (`sessionFor` above), so the cast only restores what the controller's narrow type hides.
    setLookupSessionSource(async (origin) => await routes.controller.fetchSessionFor(origin) as Session | undefined)
    setRouteChallengeSource(routes.controller.challengeCredentials)
    beforeAppSessionServes(async (appSession, origin) => { await routes.controller.appSessionRegistered(origin, appSession) })
    const temporary = createTemporaryRoutes({
      controller: routes.controller,
      proxy: routes.proxy,
      sessionFor: (partition) => session.fromPartition(partition),
      liveContentsIn: (inside) => webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.session === inside).length,
      onContentsGone: (listener) => {
        app.on('web-contents-created', (_event, contents) => {
          // Read now: a destroyed contents no longer answers for its session.
          const own = contents.session
          contents.once('destroyed', () => { listener(own) })
        })
      }
    })
    setLeavingRoutes({
      world: {
        isRouted: routes.hub.isRouted,
        isInstalledApp: isOriginServedFromCacheSync,
        routedOriginOf: (partition) => partition === undefined ? undefined : routes.store.origins().find((origin) => partitionFor(origin) === partition)
      },
      temporary,
      routeSwitch: createRouteSwitch(routes, { isPinned: isOriginPinnedSync, isPersistable: isPersistableOrigin })
    })
    publishRoutes(ctx, routes)
    app.once('will-quit', () => {
      void Promise.all([routes.hub.dispose(), temporary.dispose()]).catch((error: unknown) => { console.error('[route] stopping the fronts failed:', error) })
    })
  }
}
