// Starts the routes: the store of routed apps, the hub and the controller, wired to Electron's sessions, web contents
// and `login` event, and published as `ctx.routes` for the broker and the loader to read. Critical: if this failed, an
// app flagged as routed would go direct.

import { join } from 'node:path'
import { app, net, session, webContents } from 'electron'
import type { Session, WebRequestFilter } from 'electron'
import { beforeAppSessionServes } from '../../loader/electron/app-partitions.js'
import { setReachRoute } from '../../loader/electron/reach-route.js'
import { embedPartitionFor } from '../embed/embed-guard.js'
import { publishRoutes } from '../registry.js'
import type { Subsystem, SubsystemContext } from '../registry.js'
import { everywhereBeforeReady, readSettingBeforeReady, settingsFileProblem } from '../settings/settings-file.js'
import { isOriginPinnedSync, isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isPersistableOrigin } from '../../broker/policy/origin.js'
import { setLeavingRoutes } from './leaving-routes.js'
import { answerRouteChallenge, lookupSessionFor, setDirectLookupSource, setLookupSessionSource, setRouteChallengeSource } from './lookup-session.js'
import { followsSystem, hasOwnProxy, markFollowsSystem, markOwnProxy } from './own-proxy.js'
import { migrateRouteKinds, moveNymProfileToProxy } from './kinds-migration.js'
import { migrateLegacySites } from './legacy-sites.js'
import { setOwnRequests } from './own-requests.js'
import { setSystemProxyProbe } from './system-proxy.js'
import { createRequestFetch } from '../../loader/electron/request-fetch.js'
import { prepareProfileSession, wakeProfileSession } from '../extensions/extensions-subsystem.js'
import { servedOrigin } from './served-origin.js'
import { mustLeaveSession, setSiteRoutes, setMadeSiteSessions, setSiteSessionEnsurer, siteProfileOf } from './site-routes.js'
import { onionRefusals, onionRefused } from './onion-guard.js'
import { isOnionUrl } from '../../broker/route/onion.js'
import { createSiteSessions } from './site-sessions.js'
import { kindOfProfile } from './site-partition.js'
import type { SiteSession } from './site-sessions.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { announceWebsiteSession } from '../sessions/website-sessions.js'
import { webRequestOwnerFor, type WebRequestHandlerHandle } from '../sessions/web-request-owner.js'
import { createTemporaryRoutes, temporarySessionShowing } from './temporary-routes.js'
import { createNym } from './nym-launch.js'
import { createRouteService } from './route-service.js'
import { SHARED_ORIGIN } from './route-hub.js'
import { tunnelDefaultChanged } from '../verifier/verifier-subsystem.js'
import { RouteStore } from './route-store.js'
import { profileIsolationSecret } from './isolation-secret.js'
import { startDeadEnd } from './dead-end.js'
import type { DeadEnd } from './dead-end.js'

/** Where an onion guard runs among a session's `onBeforeRequest` handlers: after the main-frame guard (-2) and the hold on a session not yet pointed (-1). */
const ONION_GUARD_ORDER = 0
/** Every scheme a request for an onion host can use; the root-dot spelling is a host of its own to a match pattern. */
const ONION_FILTER: WebRequestFilter = { urls: ['http://*.onion/*', 'https://*.onion/*', 'ws://*.onion/*', 'wss://*.onion/*', 'http://*.onion./*', 'https://*.onion./*', 'ws://*.onion./*', 'wss://*.onion./*'] }

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
    // A private window held to Nym starts with everything on it, whatever its settings file says: the sessions are stopped before the first request.
    const heldToNym = ctx.privateTunnel === 'nym'
    const savedKind = heldToNym ? 'nym' : readSettingBeforeReady(join(userData, 'settings.json'), 'network.route.kind')
    // A private window held to a tunnel can give no origin an `off` entry or another tunnel. A file written before each origin named its own took the tunnel that was the choice.
    const store = new RouteStore(ctx.privateSession ? null : join(userData, 'routes.json'), { ...(heldToNym ? { onlyKind: 'nym' as const } : {}), legacyKind: savedKind })
    // Before any session is made: the folder a session opens is moved first, and the choice is not guessed when the settings cannot be read.
    migrateRouteKinds(store, () => moveNymProfileToProxy(userData), settingsFileProblem(join(userData, 'settings.json')) === undefined)
    const isolationSecret = profileIsolationSecret(userData)
    const routes = createRouteService({
      store,
      isolationSecret,
      savedProxy: readSettingBeforeReady(join(userData, 'settings.json'), 'network.route.proxy'),
      // A settings file that cannot be used counts as the whole browser being on the tunnel (Settings says why).
      savedEverywhere: heldToNym || everywhereBeforeReady(join(userData, 'settings.json')),
      savedKind,
      nym: createNym(readSettingBeforeReady(join(userData, 'settings.json'), 'network.nym.privacy'), heldToNym || readSettingBeforeReady(join(userData, 'settings.json'), 'network.nym.enabled')),
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
        followsSystem,
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
        details.resourceType === 'mainFrame' && mustLeaveSession(details.url, { shared: target === session.defaultSession, via: routes.controller.tunnelOf(target), temporary: isTemporary(target) }, isOriginServedFromCacheSync, routes.hub.kindOf) ? { cancel: true } : current)
      // After the hold on a profile session that is not yet pointed (order -1), so that a session coming up through the person's tunnel is judged by the tunnel it ends up on.
      webRequestOwnerFor(target).onBeforeRequest(ONION_GUARD_ORDER, ONION_FILTER, isOnionUrl, (details, current) => {
        if (!onionRefused(details.url, routes.controller.tunnelOf(target))) return current
        if (details.resourceType === 'mainFrame') onionRefusals.note(details.webContentsId, details.url)
        return { cancel: true }
      })
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
        markFollowsSystem(systemSession)
        systemSession.setProxy({ mode: 'system' }).catch((error: unknown) => { console.error('[route] could not put the system-proxy session on the system\'s proxy:', error) })
      }
      return systemSession
    }
    setSystemProxyProbe(async (url) => await systemProxySession().resolveProxy(url))
    setDirectLookupSource(() => routes.everywhere() ? systemProxySession() : undefined)
    const tunnelFetch = createRequestFetch({ net, session: session.defaultSession, answer: answerRouteChallenge })
    const directFetch = createRequestFetch({ net, session: systemProxySession(), answer: (_info, callback) => { callback() } })
    // A website with a tunnel of its own is asked about (its app manifest, its files by the loader) in that tunnel's profile session, never the default one, which is direct while the whole browser is off the tunnel and may be the other tunnel when it is on.
    const siteTunnelled = (origin: string): boolean => {
      const profile = routes.hub.profileFor(origin)
      return profile !== undefined && profile !== 'direct'
    }
    const siteSession = async (origin: string): Promise<Session | undefined> => {
      if (!siteTunnelled(origin)) return undefined
      const routed = await lookupSessionFor(origin)
      // A website that belongs in a tunnel profile is never asked about from the default session instead.
      if (routed === undefined) throw new Error('the tunnel profile is not available, so this website is not asked about')
      return routed
    }
    const through = async (origin: string): Promise<typeof tunnelFetch | undefined> => {
      const routed = await siteSession(origin)
      return routed === undefined ? undefined : createRequestFetch({ net, session: routed, answer: answerRouteChallenge })
    }
    setOwnRequests({ everywhere: routes.everywhere, isRouted: routes.hub.isRouted, tunnel: tunnelFetch, direct: directFetch, directSession: systemProxySession, settled: routes.controller.sharedSettled, siteTunnelled, siteSession, through, nodeEndpoint: routes.nodeEndpoint, onNodeRouteMoved: routes.onNodeRouteMoved, carriesOnion: (origin) => (origin === undefined ? routes.defaultKind() : routes.hub.kindOf(origin) ?? routes.defaultKind()) === 'socks5' })

    const siteSessions = createSiteSessions({
      controller: routes.controller,
      sessionFor: (partition) => session.fromPartition(partition) as SiteSession,
      prepare: (target, persistable, partition) => { prepareProfileSession(target as unknown as Session, partition, persistable) },
      wake: (target) => wakeProfileSession(target as unknown as Session),
      // The names the verifier answers for reach it on this machine; the proxy never sees them.
      bypass: () => BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `*.${suffix}`).join(';'),
      hold: (held, current) => {
        let handle: WebRequestHandlerHandle | undefined
        const arm = (): void => {
          handle ??= webRequestOwnerFor(held as Session).onBeforeRequest(-1, { urls: ['<all_urls>'] }, () => true, async (_details, soFar) => {
            try {
              await current()
            } catch {
              return { cancel: true }
            }
            return soFar
          })
        }
        arm()
        // Once the session is ready the handler is taken away; a session that could not be made ready keeps refusing everything until a later attempt works. A later attempt (the extensions waking) arms it again until its own end.
        const watch = (): void => {
          arm()
          const waiting = current()
          waiting.then(() => {
            if (current() !== waiting) return
            handle?.remove()
            handle = undefined
          }, () => {})
        }
        watch()
        return watch
      },
      fit: (target, profile) => { announceWebsiteSession(target as Session, kindOfProfile(profile)) }
    })
    // The verifier host reads whether a proxy applies once, when it starts, and fetches through the shared front when the whole browser is on the tunnel: it stops at once, with the local nodes, and starts again with the new setting when something asks for it, once the sessions follow.
    routes.hub.onChange((origin) => {
      if (origin === SHARED_ORIGIN) tunnelDefaultChanged()
    })
    setSiteRoutes({
      profileFor: routes.hub.profileFor,
      sentLikeItsOwn: (partition, origin) => {
        const holder = partition === undefined ? session.defaultSession : session.fromPartition(partition)
        const here = routes.controller.tunnelOf(holder)
        const there = routes.hub.kindOf(origin)
        // A session keeps an address that needs no tunnel (a sign-in popup of a tunnelled site, a routed app's window) and one that needs its own; one that is not tunnelled, or goes through the other tunnel, never keeps an address that needs another.
        return there === undefined || here === 'held' || here === there
      }
    })
    // Sessions websites had of their own before the two profiles are cleared once; the person signs in again once.
    migrateLegacySites(routes.store, { clear: async (partition) => { await session.fromPartition(partition).clearData() } }).catch((error: unknown) => { console.error('[route] the migration to profiles failed:', error) })
    setSiteSessionEnsurer(siteSessions.ensure)
    setMadeSiteSessions(siteSessions.made)
    setReachRoute(routes.hub.routeFor)
    setRouteChallengeSource(routes.controller.challengeCredentials)
    beforeAppSessionServes(async (appSession, origin) => { await routes.controller.appSessionRegistered(origin, appSession) })
    const temporary = createTemporaryRoutes({
      isolationSecret,
      controller: routes.controller,
      targetOf: routes.targetOf,
      providerFor: routes.providerFor,
      sessionFor: (partition) => session.fromPartition(partition),
      announce: (target) => { announceWebsiteSession(target as unknown as Session) },
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
      routeSwitch: routes.routeSwitch,
      kindOf: routes.hub.kindOf,
      defaultKind: routes.defaultKind
    })
    publishRoutes(ctx, routes)
    // Whatever loads next (the person's extensions, the first window) finds the sessions already following the setting.
    await routes.controller.settled()
    app.once('will-quit', () => {
      void Promise.all([routes.hub.dispose(), temporary.dispose(), deadEnd.close()]).catch((error: unknown) => { console.error('[route] stopping the fronts failed:', error) })
    })
  }
}
