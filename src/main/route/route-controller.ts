// What routing an app does to Chromium, Electron-free over the parts it drives: point each of the app's sessions at its
// front (never at `direct`), keep UDP off the network with the WebRTC policy on every web contents in them, close what
// the app held open when its route is switched, and answer the front's own proxy challenge, for that front alone.

import type { Session, WebContents } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { originHash } from '../../broker/grants/origin-hash.js'
import { SHARED_ORIGIN } from './route-hub.js'
import { profilePartitionFor } from './site-partition.js'
import type { RouteChangeCause, RouteHub } from './route-hub.js'

export type RouteSession = Pick<Session, 'setProxy' | 'closeAllConnections'>
/** What a proxy is set to: Electron's own shape. */
export type RouteProxyConfig = Parameters<RouteSession['setProxy']>[0]
/** `session` is compared by identity with the sessions prepared here, so it is only an object. */
export type RouteContents = Pick<WebContents, 'isDestroyed' | 'setWebRTCIPHandlingPolicy' | 'reload' | 'getType' | 'getURL'> & { readonly session: object }

/** The `login` event's parts that matter here, so a fake can drive it. */
export type RouteLoginListener = (
  event: { readonly preventDefault: () => void },
  info: { readonly isProxy: boolean, readonly host: string, readonly port: number },
  callback: (username?: string, password?: string) => void
) => void

export interface RouteControllerDeps {
  readonly hub: RouteHub
  readonly broker: () => Pick<Broker, 'dropOrigin'> | undefined
  readonly sessionFor: (partition: string) => RouteSession
  /** The partition the pages an app shows inside itself run in. */
  readonly embedPartition: (origin: string) => string
  readonly allContents: () => readonly RouteContents[]
  readonly onContentsCreated: (listener: (contents: RouteContents) => void) => void
  /** The listener must run before the sheet that asks the person about a proxy's challenge. */
  readonly onLogin: (listener: RouteLoginListener) => void
  /** Whether `origin` is an installed app, which has an embed session and reloads on a switch; any other origin is a website. Every origin is an app when this is left out. */
  readonly isApp?: (origin: string) => boolean
  /** How long one call into a session or the broker may take before the switch goes on without it. */
  readonly callTimeoutMs?: number
  /** The default session, which the shared tunnel identity always covers and the lookups about a website that follows the default go through. */
  readonly defaultSession?: () => RouteSession
  /** The host rules the sessions of the shared identity reach without the proxy besides this machine: the names the verifier answers for. */
  readonly sharedBypass?: () => string
  /** Points the requests made with no session (a utility process's `net`, the runtime's own) at a proxy. */
  readonly setAppProxy?: (config: RouteProxyConfig) => Promise<void>
  /** Whether the session set its own proxy and answers for what it lets through, so the shared identity leaves it alone. */
  readonly ownProxy?: (session: RouteSession) => boolean
}

export interface PrepareOptions {
  /** False for a session whose pages confine WebRTC themselves, so it is neither set nor restored here. */
  readonly webrtc?: boolean
  /** Host rules the session reaches without the proxy, besides this machine: the names Orivon's own verifier answers for, in a website's session. */
  readonly bypass?: string
}

export interface RouteController {
  /** What the front a proxy challenge came from expects, or undefined when it came from anything else. */
  challengeCredentials: (info: { readonly isProxy: boolean, readonly host: string, readonly port: number }) => { readonly username: string, readonly password: string } | undefined
  /** Points `session` at the app's front when the app is routed (waiting for it), and back at the system's proxy when it no longer is. */
  prepare: (origin: string, session: RouteSession, options?: PrepareOptions) => Promise<void>
  /** An app's served session has appeared: prepares it and the app's embed session. */
  appSessionRegistered: (origin: string, session: RouteSession) => Promise<void>
  /** A website's session of its own: pointed at its front while the website is routed (waiting for it), at the system's proxy while it is not. `bypass` is the host rules it reaches directly besides this machine. */
  prepareSite: (origin: string, session: RouteSession, bypass: string) => Promise<void>
  /** A rule that reaches nothing, for a website's session that could not be pointed: a request there fails, it is never sent direct. */
  confineSite: (session: RouteSession) => Promise<void>
  /** A session in memory pointed at the app's front, for the lookups made about a routed app; undefined when the app is not routed. */
  fetchSessionFor: (origin: string) => Promise<RouteSession | undefined>
  /** The app is gone (forgotten): its sessions are no longer followed, and its lookup session is made anew if it is routed again. Call after its route was switched off. */
  forget: (origin: string) => void
  /** Points a session that belongs to no app at a front of its own, and puts the WebRTC policy on every web contents that opens in it. */
  prepareTemporary: (session: RouteSession, front: TemporaryFront) => Promise<void>
  /** The session is gone: its front's challenge is no longer answered. */
  releaseTemporary: (session: RouteSession, front: TemporaryFront) => void
  /**
   * A session was created: while the browser-wide setting is on it is stopped at once (a rule that reaches nothing) and then
   * pointed at the shared front, unless whoever made it claims it, by preparing it for an origin or by setting a proxy of its own.
   * While the setting is off it is only remembered, so that turning the setting on reaches it.
   */
  adopt: (session: RouteSession) => void
  /** Points the shared identity once at start: its sessions, and the requests made with no session. Nothing while the browser-wide setting is off. */
  startShared: () => void
  /** Resolves when the switches heard so far have been applied. */
  settled: () => Promise<void>
}

/** What the controller needs of a front that is not an app's: where it listens and what it expects. */
export interface TemporaryFront {
  readonly port: number
  readonly username: string
  readonly secret: string
}

const CONFINED = 'disable_non_proxied_udp'
/** The belt a web context already carries against WebRTC: a port nothing is expected to answer on. */
const UNREACHABLE_PROXY = 'http://127.0.0.1:9'
/** A call that never returns would hold the app's later switches behind it. */
const SESSION_CALL_MS = 10_000
/**
 * What Chromium may reach without the proxy: this machine and nothing else. `<-loopback>` takes away the bypass it
 * applies to its own accord, which covers link-local addresses (169.254.0.0/16, fe80::/10) as well as loopback, and
 * the rest puts back only what the app's own loopback pages (a served port, a `*.localhost` name) need.
 */
const ROUTED_BYPASS = '<-loopback>;localhost;*.localhost;127.0.0.1/8;[::1]'
/** The rule that reaches nothing bypasses nothing: the implicit bypass of loopback and link-local is cancelled too. */
const CONFINED_BYPASS = '<-loopback>'
/** `pointedAt`'s value for a session held on the unreachable proxy: no front has this port. */
const CONFINED_FRONT = 0

async function within<T> (work: Promise<T>, ms = SESSION_CALL_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('a call did not finish')) }, ms) })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

export function createRouteController (deps: RouteControllerDeps): RouteController {
  const { hub } = deps
  const callMs = deps.callTimeoutMs ?? SESSION_CALL_MS
  /** Every session prepared for an app, and whether its pages are the controller's to confine. */
  const known = new Map<string, Map<RouteSession, boolean>>()
  /** The front each session points at now. */
  const pointedAt = new Map<RouteSession, number>()
  /** Web contents given the policy here, which are the only ones restored. */
  const confined = new WeakSet<RouteContents>()
  const fetchSessions = new Map<string, RouteSession>()
  /** The host rules a session reaches directly besides this machine. */
  const bypasses = new Map<RouteSession, string>()
  const isApp = deps.isApp ?? (() => true)
  /** The sessions of temporary routed tabs, and the credentials their fronts expect, by port. */
  const temporarySessions = new Set<object>()
  const temporaryFronts = new Map<number, TemporaryFront>()
  /** One app's switches run in order, and never behind another app's. */
  const queues = new Map<string, Promise<void>>()

  const sessionsOf = (origin: string): Map<RouteSession, boolean> => {
    let sessions = known.get(origin)
    if (sessions === undefined) { sessions = new Map(); known.set(origin, sessions) }
    return sessions
  }
  const contentsIn = (origin: string, onlyManaged: boolean): RouteContents[] => {
    const wanted = [...sessionsOf(origin)].filter(([, webrtc]) => webrtc || !onlyManaged).map(([session]) => session)
    return deps.allContents().filter((contents) => !contents.isDestroyed() && wanted.some((session) => session === contents.session))
  }
  const enqueue = (origin: string, work: () => Promise<void>): void => {
    const next: Promise<void> = (queues.get(origin) ?? Promise.resolve()).then(work)
      .catch((error: unknown) => { console.error('[route] could not apply a change of route:', error) })
      .finally(() => { if (queues.get(origin) === next) queues.delete(origin) })
    queues.set(origin, next)
  }

  /** One change to a session at a time: two callers must not both see it unpointed and both point it. */
  const turns = new Map<RouteSession, Promise<void>>()
  /** Sessions an origin prepared: the shared identity never takes them. */
  const claimed = new WeakSet<RouteSession>()

  async function prepare (origin: string, session: RouteSession, options: PrepareOptions = {}): Promise<void> {
    // A session belongs to one origin's identity: an origin that prepares it takes it from the shared one.
    if (origin !== SHARED_ORIGIN) {
      known.get(SHARED_ORIGIN)?.delete(session)
      claimed.add(session)
    } else if (deps.sharedBypass !== undefined) {
      bypasses.set(session, deps.sharedBypass())
    }
    sessionsOf(origin).set(session, options.webrtc !== false)
    if (options.bypass !== undefined) bypasses.set(session, options.bypass)
    const turn = (turns.get(session) ?? Promise.resolve()).then(async () => { await point(origin, session) })
    turns.set(session, turn.catch(() => {}))
    await turn
  }

  async function pointAt (session: RouteSession, port: number): Promise<void> {
    if (pointedAt.get(session) === port) return
    const extra = bypasses.get(session)
    await within(session.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${String(port)}`, proxyBypassRules: extra === undefined ? ROUTED_BYPASS : `${ROUTED_BYPASS};${extra}` }), callMs)
    pointedAt.set(session, port)
  }

  async function point (origin: string, session: RouteSession): Promise<void> {
    if (hub.isRouted(origin)) {
      await pointAt(session, (await hub.front(origin)).port)
    } else if (pointedAt.has(session)) {
      // Forgotten only once it is done: a session that could not be put back stays marked, so a later pass tries again.
      await within(session.setProxy({ mode: 'system' }), callMs)
      pointedAt.delete(session)
    }
  }

  /** A rule that reaches nothing, for a session that could not be pointed at the app's front: a request there fails, it is never sent direct. */
  async function confine (session: RouteSession): Promise<void> {
    // Recorded, so that switching the route off puts the session back on the system's proxy.
    pointedAt.set(session, CONFINED_FRONT)
    try {
      await within(session.setProxy({ mode: 'fixed_servers', proxyRules: UNREACHABLE_PROXY, proxyBypassRules: CONFINED_BYPASS }), callMs)
    } catch (error) {
      console.error('[route] could not stop a session that could not be routed:', error)
    }
  }

  /** Points `session`, once more when putting it back on the system's proxy failed: a session left on a stopped front fails everything. */
  async function pointWithRetry (origin: string, session: RouteSession, webrtc: boolean, routed: boolean): Promise<void> {
    try {
      await prepare(origin, session, { webrtc })
    } catch (error) {
      if (routed) throw error
      console.error('[route] could not put a session back on the system\'s proxy, trying again:', error)
      await prepare(origin, session, { webrtc })
    }
  }

  /** The requests made with no session follow the shared identity: its front, or the system's proxy; a front that cannot be had stops them. */
  async function pointAppRequests (routed: boolean): Promise<void> {
    if (deps.setAppProxy === undefined) return
    try {
      const config: RouteProxyConfig = routed
        ? { mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${String((await hub.front(SHARED_ORIGIN)).port)}`, proxyBypassRules: ROUTED_BYPASS }
        : { mode: 'system' }
      await within(deps.setAppProxy(config), callMs)
    } catch (error) {
      console.error('[route] could not point the runtime\'s own requests at the tunnel:', error)
      if (!routed) return
      try {
        await within(deps.setAppProxy({ mode: 'fixed_servers', proxyRules: UNREACHABLE_PROXY, proxyBypassRules: CONFINED_BYPASS }), callMs)
      } catch (stopping) {
        console.error('[route] could not stop the runtime\'s own requests:', stopping)
      }
    }
  }

  async function apply (origin: string, routed: boolean, cause: RouteChangeCause): Promise<void> {
    // Asking for a session creates it on disk, so the embed partition is touched only for an app that is routed.
    if (routed && isApp(origin)) sessionsOf(origin).set(deps.sessionFor(deps.embedPartition(origin)), true)
    if (origin === SHARED_ORIGIN) {
      // A session that set its own proxy is not the shared identity's to point or to put back.
      for (const session of [...sessionsOf(origin).keys()]) if (claimed.has(session) || deps.ownProxy?.(session) === true) sessionsOf(origin).delete(session)
    }
    const sessions = [...sessionsOf(origin)]
    const pointed = await Promise.allSettled(sessions.map(async ([session, webrtc]) => { await pointWithRetry(origin, session, webrtc, routed) }))
    for (const [index, outcome] of pointed.entries()) {
      if (outcome.status === 'fulfilled') continue
      console.error('[route] could not point a session of the app at its route:', outcome.reason)
      const failed = sessions[index]?.[0]
      if (routed && failed !== undefined) await confine(failed)
    }
    if (origin === SHARED_ORIGIN) await pointAppRequests(routed)
    for (const contents of contentsIn(origin, true)) {
      if (routed) {
        confined.add(contents)
        contents.setWebRTCIPHandlingPolicy(CONFINED)
      } else if (confined.has(contents)) {
        confined.delete(contents)
        contents.setWebRTCIPHandlingPolicy('default')
      }
    }
    // What was opened before the switch is on the old route (or none), whatever the proxy now says. The sessions are
    // already on the new one, so nothing new opens on the old while the broker's handles are closed.
    await Promise.allSettled(sessions.map(async ([session]) => { await within(session.closeAllConnections(), callMs) }))
    if (isApp(origin)) {
      try {
        await within(Promise.resolve(deps.broker()?.dropOrigin(origin)), callMs)
      } catch (error) {
        console.error('[route] could not close the app\'s open handles:', error)
      }
    }
    // A page that held a peer connection, a worker or an embed from before the switch starts again on the new route. A website's tab moves to the session it now belongs in, which loads it anew.
    if (cause === 'switch' && isApp(origin)) for (const contents of contentsIn(origin, false)) if (contents.getType() !== 'remote') contents.reload()
    // The shared identity's pages are the browser's tabs: they are reloaded so that no peer connection or worker made on the old route survives; the shell's own pages are not.
    if (cause === 'switch' && origin === SHARED_ORIGIN) for (const contents of contentsIn(origin, false)) if (/^https?:/.test(contents.getURL())) contents.reload()
  }

  hub.onChange((origin, routed, cause) => {
    enqueue(origin, async () => { await apply(origin, routed, cause) })
  })

  deps.onContentsCreated((contents) => {
    if (temporarySessions.has(contents.session)) {
      confined.add(contents)
      contents.setWebRTCIPHandlingPolicy(CONFINED)
    }
    for (const [origin, sessions] of known) {
      if (sessions.get(contents.session as RouteSession) === true && hub.isRouted(origin)) {
        confined.add(contents)
        contents.setWebRTCIPHandlingPolicy(CONFINED)
      }
    }
  })

  const challengeCredentials: RouteController['challengeCredentials'] = (info) => {
    if (!info.isProxy || info.host !== '127.0.0.1') return undefined
    const temporary = temporaryFronts.get(info.port)
    return temporary === undefined ? hub.credentialsForPort(info.port) : { username: temporary.username, password: temporary.secret }
  }

  deps.onLogin((event, info, callback) => {
    const credentials = challengeCredentials(info)
    if (credentials === undefined) return
    event.preventDefault()
    callback(credentials.username, credentials.password)
  })

  return {
    challengeCredentials,
    prepare,
    appSessionRegistered: async (origin, session) => {
      try {
        await prepare(origin, session)
        // With the whole browser on, an app set to off keeps its embeds off the shared identity too.
        if (hub.isRouted(origin) || hub.isRouted(SHARED_ORIGIN)) await prepare(origin, deps.sessionFor(deps.embedPartition(origin)))
      } catch (error) {
        // The loader stops the app on this rejection; what the session holds meanwhile reaches nothing.
        if (hub.isRouted(origin)) await confine(session)
        throw error
      }
    },
    prepareSite: async (origin, session, bypass) => { await prepare(origin, session, { bypass }) },
    confineSite: confine,
    startShared: () => {
      if (hub.isRouted(SHARED_ORIGIN)) enqueue(SHARED_ORIGIN, async () => { await apply(SHARED_ORIGIN, true, 'proxy') })
    },
    adopt: (session) => {
      const shared = sessionsOf(SHARED_ORIGIN)
      if (claimed.has(session) || shared.has(session)) return
      shared.set(session, true)
      if (!hub.isRouted(SHARED_ORIGIN)) return
      // Stopped before anything can load in it, then pointed once the shared front runs (or claimed away meanwhile).
      confine(session).catch((error: unknown) => { console.error('[route] could not stop a new session:', error) })
      enqueue(SHARED_ORIGIN, async () => {
        if (claimed.has(session) || deps.ownProxy?.(session) === true) { shared.delete(session); return }
        await prepare(SHARED_ORIGIN, session)
      })
    },
    fetchSessionFor: async (origin) => {
      if (!hub.isRouted(origin)) return undefined
      if (!isApp(origin)) {
        // A website is looked up about through the session it runs in, which is already prepared with the identity it shares: the tunnel profile's, or the default session when the whole browser is on the tunnel.
        const profile = hub.profileFor(origin)
        if (profile === 'tunnel') return deps.sessionFor(profilePartitionFor('tunnel', origin))
        const shared = deps.defaultSession?.()
        if (profile === undefined && shared !== undefined && hub.isRouted(SHARED_ORIGIN)) return shared
      }
      let session = fetchSessions.get(origin)
      if (session === undefined) {
        session = deps.sessionFor(`orivon-route-fetch-${originHash(origin)}`)
        fetchSessions.set(origin, session)
      }
      await prepare(origin, session, { webrtc: false })
      return session
    },
    forget: (origin) => {
      enqueue(origin, async () => {
        const sessions = sessionsOf(origin)
        // A session still marked as pointed at a front is put back once more, and let go only when it is.
        for (const session of [...sessions.keys()]) {
          if (pointedAt.has(session)) await prepare(origin, session).catch((error: unknown) => { console.error('[route] a forgotten app\'s session is still on its front:', error) })
          if (!pointedAt.has(session)) { sessions.delete(session); bypasses.delete(session) }
        }
        if (sessions.size === 0) known.delete(origin)
        fetchSessions.delete(origin)
      })
    },
    prepareTemporary: async (session, front) => {
      // Registered before the session is pointed, so a web contents made in it meanwhile already has the policy.
      known.get(SHARED_ORIGIN)?.delete(session)
      claimed.add(session)
      temporarySessions.add(session)
      temporaryFronts.set(front.port, front)
      await pointAt(session, front.port)
    },
    releaseTemporary: (session, front) => {
      temporarySessions.delete(session)
      temporaryFronts.delete(front.port)
      pointedAt.delete(session)
    },
    settled: async () => {
      await hub.settled()
      let seen: Array<Promise<void>>
      do {
        seen = [...queues.values()]
        await Promise.all(seen)
      } while ([...queues.values()].some((one) => !seen.includes(one)))
    }
  }
}
