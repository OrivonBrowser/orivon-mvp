// Starts the routes: the store of routed apps, the hub and the controller, wired to Electron's sessions, web contents
// and `login` event, and published as `ctx.routes` for the broker and the loader to read. Critical: if this failed, an
// app flagged as routed would go direct.

import { join } from 'node:path'
import { app, net, session, webContents } from 'electron'
import type { Session } from 'electron'
import { beforeAppSessionServes } from '../../loader/electron/app-partitions.js'
import { setReachRoute } from '../../loader/electron/reach-route.js'
import { embedPartitionFor } from '../embed/embed-guard.js'
import { publishRoutes } from '../registry.js'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { everywhereBeforeReady, readSettingBeforeReady } from '../settings/settings-file.js'
import { isOriginPinnedSync, isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isPersistableOrigin } from '../../broker/policy/origin.js'
import { setLeavingRoutes } from './leaving-routes.js'
import { answerRouteChallenge, lookupSessionFor, setDirectLookupSource, setLookupSessionSource, setRouteChallengeSource } from './lookup-session.js'
import { hasOwnProxy, markOwnProxy } from './own-proxy.js'
import { migrateLegacySites } from './legacy-sites.js'
import { setOwnRequests } from './own-requests.js'
import { setSystemProxyProbe } from './system-proxy.js'
import { createRequestFetch } from '../../loader/electron/request-fetch.js'
import { mirrorExtensions } from '../extensions/profile-extensions.js'
import { installExtensionRequestHandlers } from '../extensions/extensions-subsystem.js'
import { servedOrigin } from './served-origin.js'
import { mustLeaveSession, setSiteRoutes, setSiteSessionEnsurer, siteProfileOf } from './site-routes.js'
import { createSiteSessions } from './site-sessions.js'
import type { SiteSession } from './site-sessions.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { announceWebsiteSession } from '../sessions/website-sessions.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import { createTemporaryRoutes, temporarySessionShowing } from './temporary-routes.js'
import { createNym } from './nym-launch.js'
import { createRouteService } from './route-service.js'
import { SHARED_ORIGIN } from './route-hub.js'
import { tunnelDefaultChanged } from '../verifier/verifier-subsystem.js'
import { RouteStore } from './route-store.js'
import { startDeadEnd } from './dead-end.js'
import type { DeadEnd } from './dead-end.js'

/** Sessions created before the controller exists, and after: each is adopted by the shared identity (`route-controller.ts`). */
const created: object[] = []
let adopt: ((created: Session) => void) | undefined

export const routeSubsystem: Subsystem = {
  name: 'route',
  critical: true,
  // Listening starts before Electron can create a session: one made before `afterReady` is adopted then.
  beforeReady: () => {
    app.on('session-created', (made) => {
      if (adopt === undefined) created.push(made)
      else adopt(made)
    })
  },
  afterReady: async (ctx: SubsystemContext) => {
    const userData = ctx.app.getPath('userData')
    // Had before any session is stopped, so that stopping one takes no waiting: the listener a stopped session is pointed at.
    const deadEnd: DeadEnd = await startDeadEnd()
    const deadEndRule = (): string => `http://127.0.0.1:${String(deadEnd.port)}`
    const routes = createRouteService({
      store: new RouteStore(ctx.privateSession ? null : join(userData, 'routes.json')),
      savedProxy: readSettingBeforeReady(join(userData, 'settings.json'), 'network.route.proxy'),
      // A settings file that cannot be used counts as the whole browser being on the tunnel (Settings says why).
      savedEverywhere: everywhereBeforeReady(join(userData, 'settings.json')),
      savedKind: readSettingBeforeReady(join(userData, 'settings.json'), 'network.route.kind'),
      nym: createNym(),
      // Asked only when the list of tunnel settings cannot be read; the broker exists by then.
      installed: () => [...new Set([...(ctx.broker?.app.registeredOriginsSync() ?? []), ...(ctx.broker?.app.persistedAppsSync().map((installed) => installed.origin) ?? [])])],
      switchWorld: {
        isPinned: isOriginPinnedSync,
        isPersistable: isPersistableOrigin,
        removeSiteStorage: async (partition, origin) => { await siteSessions.removeStorage(partition, origin) },
        dropServiceWorkers: async (partition, origin) => { await (partition === undefined ? session.defaultSession : session.fromPartition(partition)).clearStorageData({ origin, storages: ['serviceworkers'] }) }
      },
      electron: {
        isApp: isOriginServedFromCacheSync,
        broker: () => ctx.broker,
        sessionFor: (partition) => session.fromPartition(partition),
        defaultSession: () => session.defaultSession,
        // The names the verifier answers for reach it on this machine; the proxy never sees them.
        sharedBypass: () => BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `*.${suffix}`).join(';'),
        setAppProxy: async (config) => { await app.setProxy(config) },
        ownProxy: hasOwnProxy,
        deadEnd: deadEndRule,
        embedPartition: embedPartitionFor,
        allContents: () => webContents.getAllWebContents(),
        onContentsCreated: (listener) => { app.on('web-contents-created', (_event, contents) => { listener(contents) }) },
        // Ahead of the sheet that asks the person about a proxy's challenge, which must not see this one.
        onLogin: (listener) => { app.prependListener('login', (event, _contents, _details, info, callback) => { listener(event, info, callback) }) }
      }
    })
    // Every session guards its own main frame: a website that belongs in another session, or a routed one in a session that is not tunnelled, is never loaded there.
    let isTemporary: (target: object) => boolean = () => false
    const guarded = new WeakSet<Session>()
    const guardLoads = (target: Session): void => {
      if (guarded.has(target)) return
      guarded.add(target)
      webRequestOwnerFor(target).onBeforeRequest(-2, { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] }, () => true, (details, current) =>
        details.resourceType === 'mainFrame' && mustLeaveSession(details.url, { shared: target === session.defaultSession, tunnelled: routes.controller.isTunnelled(target), temporary: isTemporary(target) }, isOriginServedFromCacheSync, routes.hub.isRouted) ? { cancel: true } : current)
    }
    adopt = (made) => { routes.controller.adopt(made); guardLoads(made) }
    for (const earlier of created.splice(0)) adopt(earlier as Session)
    // The default session is the shared identity's, and is stopped before anything else is done while the whole browser is on the tunnel.
    adopt(session.defaultSession)
    routes.controller.startShared()

    // The session that asks what the system's proxy is (T20) never follows the tunnel; the lookups about a website set to off go through it too.
    let systemSession: Session | undefined
    const systemProxySession = (): Session => {
      if (systemSession === undefined) {
        systemSession = session.fromPartition('orivon-system-proxy')
        markOwnProxy(systemSession)
        systemSession.setProxy({ mode: 'system' }).catch((error: unknown) => { console.error('[route] could not put the system-proxy session on the system\'s proxy:', error) })
      }
      return systemSession
    }
    setSystemProxyProbe(async (url) => await systemProxySession().resolveProxy(url))
    setDirectLookupSource(() => routes.everywhere() ? systemProxySession() : undefined)
    const tunnelFetch = createRequestFetch({ net, session: session.defaultSession, answer: answerRouteChallenge })
    const directFetch = createRequestFetch({ net, session: systemProxySession(), answer: (_info, callback) => { callback() } })
    // A website with its tunnel on is asked about (its app manifest, its files by the loader) in the tunnel profile's session, not the default one, which is direct while the whole browser is off the tunnel.
    const siteSession = async (origin: string): Promise<Session | undefined> => routes.hub.profileFor(origin) === 'tunnel' ? await lookupSessionFor(origin) : undefined
    const through = async (origin: string): Promise<typeof tunnelFetch | undefined> => {
      const routed = await siteSession(origin)
      return routed === undefined ? undefined : createRequestFetch({ net, session: routed, answer: answerRouteChallenge })
    }
    setOwnRequests({ everywhere: routes.everywhere, isRouted: routes.hub.isRouted, tunnel: tunnelFetch, direct: directFetch, directSession: systemProxySession, settled: routes.controller.sharedSettled, siteSession, through })

    const siteSessions = createSiteSessions({
      controller: routes.controller,
      sessionFor: (partition) => session.fromPartition(partition) as SiteSession,
      extend: async (target, persistable) => {
        if (persistable) await mirrorExtensions(target as unknown as Session, session.defaultSession)
        installExtensionRequestHandlers(target as unknown as Session)
      },
      // The names the verifier answers for reach it on this machine; the proxy never sees them.
      bypass: () => BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `*.${suffix}`).join(';'),
      hold: (held, current) => {
        const handle = webRequestOwnerFor(held as Session).onBeforeRequest(-1, { urls: ['<all_urls>'] }, () => true, async (_details, soFar) => {
          try {
            await current()
          } catch {
            return { cancel: true }
          }
          return soFar
        })
        // Once the session is ready the handler is taken away; a session that could not be made ready keeps refusing everything until a later attempt works.
        const watch = (): void => { current().then(() => { handle.remove() }, () => {}) }
        watch()
        return watch
      },
      fit: (target, profile) => { announceWebsiteSession(target as Session, profile === 'tunnel') }
    })
    // The verifier host reads whether a proxy applies once, when it starts, and fetches through the shared front when the whole browser is on the tunnel: it stops at once, with the local nodes, and starts again with the new setting when something asks for it, once the sessions follow.
    routes.hub.onChange((origin) => {
      if (origin === SHARED_ORIGIN) tunnelDefaultChanged()
    })
    setSiteRoutes({
      profileFor: routes.hub.profileFor,
      sentLikeItsOwn: (partition, origin) => {
        const holder = partition === undefined ? session.defaultSession : session.fromPartition(partition)
        const here = routes.controller.isTunnelled(holder)
        const there = routes.hub.isRouted(origin)
        // A session that is tunnelled keeps an address that needs no tunnel (a sign-in popup of a tunnelled site, a routed app's window); one that is not never keeps an address that does.
        return here || !there
      }
    })
    // Sessions websites had of their own before the two profiles are cleared once; the person signs in again once.
    migrateLegacySites(routes.store, { clear: async (partition) => { await session.fromPartition(partition).clearData() } }).catch((error: unknown) => { console.error('[route] the migration to profiles failed:', error) })
    setSiteSessionEnsurer(siteSessions.ensure)
    setReachRoute(routes.hub.routeFor)
    setRouteChallengeSource(routes.controller.challengeCredentials)
    beforeAppSessionServes(async (appSession, origin) => { await routes.controller.appSessionRegistered(origin, appSession) })
    const temporary = createTemporaryRoutes({
      controller: routes.controller,
      proxy: routes.proxy,
      providerFor: routes.providerFor,
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
    isTemporary = temporary.owns
    // The sessions handed out are Electron's own (`sessionFor` above), so the casts only restore what the controller's narrow type hides.
    // A site open in a temporary session is looked up about through that session; an app's own session wins for an app.
    setLookupSessionSource(async (origin) => await routes.controller.fetchSessionFor(origin) as Session | undefined
      ?? (temporary.count() === 0 ? undefined : temporarySessionShowing(webContents.getAllWebContents(), temporary.owns, origin) as Session | undefined))
    setLeavingRoutes({
      world: {
        isRouted: routes.hub.isRouted,
        isInstalledApp: isOriginServedFromCacheSync,
        routedOriginOf: (partition) => {
          // A profile holds many websites, so a page with no web address in one cannot be said to be any of them.
          if (partition === undefined || siteProfileOf(partition) !== undefined) return undefined
          return routes.store.origins().find((origin) => partitionFor(origin) === partition)
        },
        servedOrigin
      },
      temporary,
      routeSwitch: routes.routeSwitch
    })
    publishRoutes(ctx, routes)
    // Whatever loads next (the person's extensions, the first window) finds the sessions already following the setting.
    await routes.controller.settled()
    app.once('will-quit', () => {
      void Promise.all([routes.hub.dispose(), temporary.dispose(), deadEnd.close()]).catch((error: unknown) => { console.error('[route] stopping the fronts failed:', error) })
    })
  }
}
