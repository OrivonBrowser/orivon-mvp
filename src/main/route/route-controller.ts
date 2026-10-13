// What routing an app does to Chromium, Electron-free over the parts it drives: point each of the app's sessions at its
// front (never at `direct`), keep UDP off the network with the WebRTC policy on every web contents in them, close what
// the app held open when its route is switched, and answer the front's own proxy challenge, for that front alone.

import type { Session, WebContents } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { originHash } from '../../broker/grants/origin-hash.js'
import type { RouteChangeCause, RouteHub } from './route-hub.js'

export type RouteSession = Pick<Session, 'setProxy' | 'closeAllConnections'>
/** `session` is compared by identity with the sessions prepared here, so it is only an object. */
export type RouteContents = Pick<WebContents, 'isDestroyed' | 'setWebRTCIPHandlingPolicy' | 'reload' | 'getType'> & { readonly session: object }

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
  /** How long one call into a session or the broker may take before the switch goes on without it. */
  readonly callTimeoutMs?: number
}

export interface PrepareOptions {
  /** False for a session whose pages confine WebRTC themselves, so it is neither set nor restored here. */
  readonly webrtc?: boolean
}

export interface RouteController {
  /** Points `session` at the app's front when the app is routed (waiting for it), and back at the system's proxy when it no longer is. */
  prepare: (origin: string, session: RouteSession, options?: PrepareOptions) => Promise<void>
  /** An app's served session has appeared: prepares it and the app's embed session. */
  appSessionRegistered: (origin: string, session: RouteSession) => Promise<void>
  /** A session in memory pointed at the app's front, for the lookups made about a routed app; undefined when the app is not routed. */
  fetchSessionFor: (origin: string) => Promise<RouteSession | undefined>
  /** The app is gone (forgotten): its sessions are no longer followed, and its lookup session is made anew if it is routed again. Call after its route was switched off. */
  forget: (origin: string) => void
  /** Resolves when the switches heard so far have been applied. */
  settled: () => Promise<void>
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

  async function prepare (origin: string, session: RouteSession, options: PrepareOptions = {}): Promise<void> {
    sessionsOf(origin).set(session, options.webrtc !== false)
    const turn = (turns.get(session) ?? Promise.resolve()).then(async () => { await point(origin, session) })
    turns.set(session, turn.catch(() => {}))
    await turn
  }

  async function point (origin: string, session: RouteSession): Promise<void> {
    if (hub.isRouted(origin)) {
      const front = await hub.front(origin)
      if (pointedAt.get(session) === front.port) return
      await within(session.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${String(front.port)}`, proxyBypassRules: ROUTED_BYPASS }), callMs)
      pointedAt.set(session, front.port)
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

  async function apply (origin: string, routed: boolean, cause: RouteChangeCause): Promise<void> {
    // Asking for a session creates it on disk, so the embed partition is touched only for an app that is routed.
    if (routed) sessionsOf(origin).set(deps.sessionFor(deps.embedPartition(origin)), true)
    const sessions = [...sessionsOf(origin)]
    const pointed = await Promise.allSettled(sessions.map(async ([session, webrtc]) => { await pointWithRetry(origin, session, webrtc, routed) }))
    for (const [index, outcome] of pointed.entries()) {
      if (outcome.status === 'fulfilled') continue
      console.error('[route] could not point a session of the app at its route:', outcome.reason)
      const failed = sessions[index]?.[0]
      if (routed && failed !== undefined) await confine(failed)
    }
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
    try {
      await within(Promise.resolve(deps.broker()?.dropOrigin(origin)), callMs)
    } catch (error) {
      console.error('[route] could not close the app\'s open handles:', error)
    }
    // A page that held a peer connection, a worker or an embed from before the switch starts again on the new route.
    if (cause === 'switch') for (const contents of contentsIn(origin, false)) if (contents.getType() !== 'remote') contents.reload()
  }

  hub.onChange((origin, routed, cause) => {
    enqueue(origin, async () => { await apply(origin, routed, cause) })
  })

  deps.onContentsCreated((contents) => {
    for (const [origin, sessions] of known) {
      if (sessions.get(contents.session as RouteSession) === true && hub.isRouted(origin)) {
        confined.add(contents)
        contents.setWebRTCIPHandlingPolicy(CONFINED)
      }
    }
  })

  deps.onLogin((event, info, callback) => {
    if (!info.isProxy || info.host !== '127.0.0.1') return
    const credentials = hub.credentialsForPort(info.port)
    if (credentials === undefined) return
    event.preventDefault()
    callback(credentials.username, credentials.password)
  })

  return {
    prepare,
    appSessionRegistered: async (origin, session) => {
      try {
        await prepare(origin, session)
        if (hub.isRouted(origin)) await prepare(origin, deps.sessionFor(deps.embedPartition(origin)))
      } catch (error) {
        // The loader stops the app on this rejection; what the session holds meanwhile reaches nothing.
        if (hub.isRouted(origin)) await confine(session)
        throw error
      }
    },
    fetchSessionFor: async (origin) => {
      if (!hub.isRouted(origin)) return undefined
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
        for (const session of known.get(origin)?.keys() ?? []) pointedAt.delete(session)
        known.delete(origin)
        fetchSessions.delete(origin)
      })
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
