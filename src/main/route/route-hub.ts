// Which origins (installed apps and websites alike) go through the proxy, and what each needs running for it: its
// route (read by the broker and the loader), its loopback front (read by Chromium) and its health (read by the Settings
// page and the site-info popover). Electron-free. A routed origin with no proxy set gets a route that refuses: it never
// falls back to a direct one. When the store cannot say what the person set, every origin is routed while a tunnel is set.

import type { Route, RouteFor, RouteProvider } from '../../broker/route/provider.js'
import { createSocks5Provider, isolationCredentials, routeAnswered } from '../../broker/route/socks5.js'
import { createRouteFor } from '../../broker/route/table.js'
import type { RouteTarget } from '../../broker/route/table.js'
import { fail } from '../../broker/errors.js'
import { startRouteFront } from './front.js'
import type { RouteFront } from './front.js'
import type { RouteStore } from './route-store.js'
import { tunnelStateOf } from './route-state.js'
import type { TunnelKind } from './route-state.js'
import { profileOf } from './site-partition.js'
import type { Profile } from './site-partition.js'

/** `switch`: the origin's routing changed (its own entry, or the default it follows), `proxy`: the tunnel changed. */
export type RouteChangeCause = 'switch' | 'proxy'

/**
 * The key of the shared tunnel identity: the one front and route every session that belongs to no origin of its own
 * shares (the default session, the shell's own, a local file's), on while the browser-wide setting is. Never an origin
 * a page can have, so no website or app can be mistaken for it.
 */
export const SHARED_ORIGIN = 'orivon-shared-tunnel'
/** The identity of Nym's profile: one front and one set of tunnel credentials for every website whose entry is Nym. Always on. */
export const NYM_PROFILE_ORIGIN = 'orivon-tunnel-profile'
/** The identity of the proxy's profile: the same for every website whose entry is the person's proxy. Always on. */
export const PROXY_PROFILE_ORIGIN = 'orivon-proxy-profile'
/** The identity of the direct profile: never routed, so its session is never pointed at a front. */
export const DIRECT_PROFILE_ORIGIN = 'orivon-direct-profile'

const PROFILE_ORIGINS: Readonly<Record<Profile, string>> = { nym: NYM_PROFILE_ORIGIN, socks5: PROXY_PROFILE_ORIGIN, direct: DIRECT_PROFILE_ORIGIN }

/** The identity a profile's session is prepared under. */
export function profileOrigin (profile: Profile): string {
  return PROFILE_ORIGINS[profile]
}

/** What the Settings page and the popover say about an app's route: `idle` is a route nothing has used yet. */
export type RouteState = 'off' | 'no-proxy' | 'idle' | 'ok' | 'down'

export interface RouteHubOptions {
  readonly store: RouteStore
  /** Where traffic of the tunnel `kind` leaves now (Nym's target, or the proxy address saved), read on every use; undefined for the proxy when no address is set. */
  readonly targetOf: (kind: TunnelKind) => RouteTarget | undefined
  /** The tunnel everything with no choice of its own goes through (the whole browser while it is on a tunnel, an unreadable list). Nym when left out. */
  readonly defaultKind?: () => TunnelKind
  /** Whether the whole browser goes through the tunnel unless an origin says otherwise: the default an origin with no entry follows. */
  readonly everywhere?: () => boolean
  /** Whether `origin` is an installed app, which has an identity of its own; any other origin is a website, which shares one (the tunnel profile's, or the shared one). Every origin is an app when this is left out. */
  readonly isApp?: (origin: string) => boolean
  /** The apps installed on this computer, asked when the proxy changes while the store cannot say what was set or the browser-wide setting is on, and when that setting changes, so their sessions are pointed again. */
  readonly installed?: () => readonly string[]
  /** Builds the provider for one app and proxy where the proxy is not a SOCKS5 address (Nym); undefined falls back to SOCKS5 with a distinct username and password per app. */
  readonly providerFor?: (key: string, target: RouteTarget) => RouteProvider | undefined
}

export interface RouteHub {
  /** For `CreateBrokerOptions.routeFor` and the loader's reach path. */
  readonly routeFor: RouteFor
  isRouted: (origin: string) => boolean
  /** Whether `origin` is an installed app, which has an identity of its own; any other origin is a website. */
  isApp: (origin: string) => boolean
  /** The tunnel the traffic of `origin` goes through now, or undefined when it is not routed. */
  kindOf: (origin: string) => TunnelKind | undefined
  /** The tunnels something goes through now: the default one while the whole browser is on a tunnel or the list cannot be read, and the ones origins have an entry for. */
  kindsInUse: () => TunnelKind[]
  /** The profile a website at `origin` runs in: the one its entry names, or the default tunnel's profile while the store cannot be read. Undefined for a website that follows the default session, and for an app. */
  profileFor: (origin: string) => Profile | undefined
  /** Whether the list of tunnel settings could not be read, so that every origin counts as routed while a tunnel is set. */
  unreadable: () => boolean
  state: (origin: string) => RouteState
  /** The app's front, started on first use. Rejects for an app that is not routed. */
  front: (origin: string) => Promise<RouteFront>
  /** The credentials the front listening on `port` expects, for the proxy challenge Chromium answers through the app. */
  credentialsForPort: (port: number) => { readonly username: string, readonly password: string } | undefined
  /** Call when the proxy address saved in the settings changed: every origin that goes through the proxy drops its connections and is told. */
  addressChanged: () => void
  /** Call when the default tunnel changed from `previous`: the shared identity and every origin with no entry of its own move to the new tunnel. */
  defaultKindChanged: (previous: TunnelKind) => void
  /** Call when the browser-wide setting changed from `previous`: every origin that follows the default changes with it, and a website with an entry of its own may no longer differ from the default. */
  everywhereChanged: (previous: boolean) => void
  /** Whether the browser-wide setting is on now. */
  isEverywhere: () => boolean
  /** Ends every tunnel the app has through its front. */
  closeTunnels: (origin: string) => void
  /** Called when an origin's route was switched on, off or to the other tunnel, and for every origin that goes through the proxy when its address changed. */
  onChange: (listener: (origin: string, routed: boolean, cause: RouteChangeCause) => void) => () => void
  /** Resolves when the fronts of switched-off apps have stopped. */
  settled: () => Promise<void>
  dispose: () => Promise<void>
}

const REFUSING_PROVIDER: RouteProvider = {
  connect: async () => { throw fail('unreachable', 'no proxy is set for this app') }
}
const REFUSING_ROUTE: Route = { provider: REFUSING_PROVIDER }

export function createRouteHub (options: RouteHubOptions): RouteHub {
  const { store } = options
  const everywhere = options.everywhere ?? (() => false)
  const defaultKind = options.defaultKind ?? ((): TunnelKind => 'nym')
  const credentials = isolationCredentials()
  const health = new Map<string, 'ok' | 'down'>()
  const fronts = new Map<string, Promise<RouteFront>>()
  /** The fronts that are listening, which is what a challenge's port can name. */
  const started = new Map<string, RouteFront>()
  const stopping = new Set<Promise<void>>()
  const listeners = new Set<(origin: string, routed: boolean, cause: RouteChangeCause) => void>()
  const emit = (origin: string, routed: boolean, cause: RouteChangeCause): void => { for (const listener of [...listeners]) listener(origin, routed, cause) }

  /** Everything that goes through an app's route, from any caller, counts toward its health. */
  const tracked = (key: string, provider: RouteProvider): RouteProvider => ({
    ...provider,
    connect: async (host, port, signal) => {
      try {
        const socket = await provider.connect(host, port, signal)
        health.set(key, 'ok')
        return socket
      } catch (error) {
        // A proxy that refused one destination is up; only a route that could not be used says down.
        if (!signal.aborted) health.set(key, routeAnswered(error) ? 'ok' : 'down')
        throw error
      }
    }
  })
  const isApp = options.isApp ?? (() => true)
  const build = (key: string, target: RouteTarget): RouteProvider => options.providerFor?.(key, target) ?? createSocks5Provider({ host: target.host, port: target.port, credentials: credentials(key) })
  /** An unreadable list is not "nothing routed": with a tunnel to go through, every origin is. */
  const unreadableWithTarget = (kind: TunnelKind): boolean => store.unreadable() && options.targetOf(kind) !== undefined
  /** The tunnel `origin` goes through when the default tunnel is `fallback` and the whole browser is `onEverywhere`, or undefined when it is not routed. */
  const kindWith = (origin: string, fallback: TunnelKind, onEverywhere: boolean): TunnelKind | undefined => {
    if (origin === NYM_PROFILE_ORIGIN) return 'nym'
    if (origin === PROXY_PROFILE_ORIGIN) return 'socks5'
    if (origin === DIRECT_PROFILE_ORIGIN) return undefined
    // The shared identity follows the browser-wide setting alone: an unreadable list puts every website in a tunnel profile, but Orivon's own requests do not change with it.
    if (origin === SHARED_ORIGIN) return onEverywhere ? fallback : undefined
    if (unreadableWithTarget(fallback)) return fallback
    const state = tunnelStateOf(store.stateOf(origin), onEverywhere, fallback)
    return state === 'off' ? undefined : state
  }
  const kindOf = (origin: string): TunnelKind | undefined => kindWith(origin, defaultKind(), everywhere())
  const routed = (origin: string): boolean => kindOf(origin) !== undefined
  /** Where `origin`'s traffic leaves now, or undefined when it is not routed or its tunnel has no address. */
  const targetFor = (origin: string): RouteTarget | undefined => {
    const kind = kindOf(origin)
    return kind === undefined ? undefined : options.targetOf(kind)
  }
  /** Whose front and credentials carry `origin`'s traffic: an app its own; a website whose entry is a tunnel that tunnel's profile's, which every such website shares; any other website the shared one. */
  const identityOf = (origin: string): string => {
    if (origin === SHARED_ORIGIN || origin === NYM_PROFILE_ORIGIN || origin === PROXY_PROFILE_ORIGIN || origin === DIRECT_PROFILE_ORIGIN || isApp(origin)) return origin
    if (unreadableWithTarget(defaultKind())) return profileOrigin(defaultKind())
    const entry = store.stateOf(origin)
    if (entry !== undefined && entry !== 'off') return profileOrigin(entry)
    return entry === undefined && everywhere() ? SHARED_ORIGIN : origin
  }
  const table = createRouteFor({
    targetFor,
    providerFor: (key, target) => tracked(key, build(key, target))
  })
  const routeFor: RouteFor = (key) => routed(key) ? table(identityOf(key)) ?? REFUSING_ROUTE : undefined

  const stopFront = (origin: string): void => {
    const running = fronts.get(origin)
    if (running === undefined) return
    fronts.delete(origin)
    started.delete(origin)
    const stopped = running.then(async (front) => { await front.close() }, () => {}).finally(() => { stopping.delete(stopped) })
    stopping.add(stopped)
  }

  store.onChange((origin, entry, previous) => {
    health.delete(origin)
    const state = tunnelStateOf(entry, everywhere(), defaultKind())
    const before = tunnelStateOf(previous, everywhere(), defaultKind())
    // An entry that says what the default already says changes nothing for the origin.
    if (state === before) return
    const now = state !== 'off'
    // Off, or the other tunnel: the front it had is let go, so the new one signs in afresh.
    stopFront(origin)
    emit(origin, now, 'switch')
  })

  return {
    routeFor,
    isRouted: routed,
    isApp,
    kindOf,
    kindsInUse: () => {
      const kinds = new Set<TunnelKind>()
      if (everywhere() || (store.unreadable() && unreadableWithTarget(defaultKind()))) kinds.add(defaultKind())
      for (const [, entry] of store.entries()) if (entry !== 'off') kinds.add(entry)
      return [...kinds]
    },
    profileFor: (origin) => isApp(origin) ? undefined : unreadableWithTarget(defaultKind()) ? profileOf(defaultKind()) : profileOf(store.stateOf(origin)),
    unreadable: () => store.unreadable(),
    state: (origin) => {
      const kind = kindOf(origin)
      if (kind === undefined) return 'off'
      if (options.targetOf(kind) === undefined) return 'no-proxy'
      return health.get(identityOf(origin)) ?? 'idle'
    },
    front: async (named) => {
      if (!routed(named)) throw new Error('this origin is not routed')
      const origin = identityOf(named)
      let running = fronts.get(origin)
      if (running === undefined) {
        // Recorded as listening only while it is still the app's front: one that was switched off meanwhile is closing.
        const starting: Promise<RouteFront> = startRouteFront({
          provider: () => targetFor(origin) === undefined ? undefined : routeFor(origin)?.provider,
          // Its secret answers a proxy challenge for its port alone, so it goes with the port: a program that takes the port next is never answered.
          onClosed: () => { void starting.then((front) => { if (started.get(origin) === front) { started.delete(origin); fronts.delete(origin) } }, () => {}) }
        }).then((front) => { if (fronts.get(origin) === starting) started.set(origin, front); return front })
        running = starting
        fronts.set(origin, starting)
        starting.catch(() => { if (fronts.get(origin) === starting) fronts.delete(origin) })
      }
      return await running
    },
    credentialsForPort: (port) => {
      for (const front of started.values()) if (front.port === port) return { username: front.username, password: front.secret }
      return undefined
    },
    addressChanged: () => {
      health.clear()
      // With the list unreadable, setting or clearing the address changes which origins are routed at all.
      const candidates = new Set([...(routed(SHARED_ORIGIN) || fronts.has(SHARED_ORIGIN) ? [SHARED_ORIGIN] : []), ...store.origins(), ...fronts.keys(), ...(store.unreadable() || everywhere() ? options.installed?.() ?? [] : [])])
      for (const origin of candidates) {
        // An unreadable list sends every origin by the default tunnel while it has an address, so the address appearing or going changes whether they are routed at all.
        const bound = kindOf(origin) === 'socks5' || (store.unreadable() && origin !== SHARED_ORIGIN && defaultKind() === 'socks5')
        if (!bound) continue
        void fronts.get(origin)?.then((front) => { front.closeTunnels() }, () => {})
        const now = routed(origin)
        if (!now) stopFront(origin)
        emit(origin, now, 'proxy')
      }
    },
    defaultKindChanged: (previous) => {
      health.clear()
      // The shared identity and every installed app that follows the default; an origin with an entry of its own, a website or an app, is where it was.
      const candidates = new Set([SHARED_ORIGIN, ...fronts.keys(), ...(options.installed?.() ?? [])])
      for (const origin of candidates) {
        const was = kindWith(origin, previous, everywhere())
        const now = kindOf(origin)
        if (was === now) continue
        void fronts.get(origin)?.then((front) => { front.closeTunnels() }, () => {})
        if (now === undefined) stopFront(origin)
        emit(origin, now !== undefined, 'proxy')
      }
    },
    isEverywhere: everywhere,
    everywhereChanged: (previous) => {
      health.clear()
      const now = everywhere()
      if (now === previous) return
      // The shared identity, and every installed app that follows the default (whether or not it has been used since the start). An origin with an entry of its own, a website or an app, is where it was.
      const affected = new Set([SHARED_ORIGIN, ...(options.installed?.() ?? [])])
      for (const origin of affected) {
        if (origin !== SHARED_ORIGIN && store.stateOf(origin) !== undefined) continue
        // Read the way `routed` reads it: the shared identity follows the setting alone, an app also the unreadable list.
        const was = kindWith(origin, defaultKind(), previous) !== undefined
        const is = routed(origin)
        if (!is) stopFront(origin)
        if (is !== was) emit(origin, is, 'switch')
      }
    },
    closeTunnels: (origin) => { void fronts.get(origin)?.then((front) => { front.closeTunnels() }, () => {}) },
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    settled: async () => { await Promise.all([...stopping]) },
    dispose: async () => {
      for (const origin of [...fronts.keys()]) stopFront(origin)
      await Promise.all([...stopping])
    }
  }
}
