// What routing an app does to Chromium, Electron-free over the parts it drives: point each of the app's sessions at its
// front (never at `direct`), keep UDP off the network with the WebRTC policy on every web contents in them, close what
// the app held open when its route is switched, and answer the front's own proxy challenge, for that front alone.

import type { Session, WebContents } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { originHash } from '../../broker/grants/origin-hash.js'
import type { RouteChangeCause, RouteHub } from './route-hub.js'

export type RouteSession = Pick<Session, 'setProxy' | 'closeAllConnections'>
/** `session` is compared by identity with the sessions prepared here, so it is only an object. */
export type RouteContents = Pick<WebContents, 'isDestroyed' | 'setWebRTCIPHandlingPolicy'> & { readonly session: object }

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
  /** Reloads the app's own tabs. */
  readonly reloadTabs: (origin: string) => void
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
  /** Points a session that belongs to no app at a front of its own, and puts the WebRTC policy on every web contents that opens in it. */
  prepareTemporary: (session: RouteSession, front: TemporaryFront) => Promise<void>
  /** The session is gone: its front's challenge is no longer answered. */
  releaseTemporary: (session: RouteSession, front: TemporaryFront) => void
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
/** A session call that never returns would hold every later switch behind it. */
const SESSION_CALL_MS = 10_000
/** `pointedAt`'s value for a session held on the unreachable proxy: no front has this port. */
const CONFINED_FRONT = 0

async function within<T> (work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('a session call did not finish')) }, SESSION_CALL_MS) })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

export function createRouteController (deps: RouteControllerDeps): RouteController {
  const { hub } = deps
  /** Every session prepared for an app, and whether its pages are the controller's to confine. */
  const known = new Map<string, Map<RouteSession, boolean>>()
  /** The front each session points at now. */
  const pointedAt = new Map<RouteSession, number>()
  /** Web contents given the policy here, which are the only ones restored. */
  const confined = new WeakSet<RouteContents>()
  const fetchSessions = new Map<string, RouteSession>()
  /** The sessions of temporary routed tabs and the credentials their fronts expect, by port. */
  const temporarySessions = new Set<object>()
  const temporaryFronts = new Map<number, TemporaryFront>()
  let queue: Promise<void> = Promise.resolve()

  const sessionsOf = (origin: string): Map<RouteSession, boolean> => {
    let sessions = known.get(origin)
    if (sessions === undefined) { sessions = new Map(); known.set(origin, sessions) }
    return sessions
  }
  const managedContents = (origin: string): RouteContents[] => {
    const managed = [...sessionsOf(origin)].filter(([, webrtc]) => webrtc).map(([session]) => session)
    return deps.allContents().filter((contents) => !contents.isDestroyed() && managed.some((session) => session === contents.session))
  }

  /** One change to a session at a time: two callers must not both see it unpointed and both point it. */
  const turns = new Map<RouteSession, Promise<void>>()

  async function prepare (origin: string, session: RouteSession, options: PrepareOptions = {}): Promise<void> {
    sessionsOf(origin).set(session, options.webrtc !== false)
    const turn = (turns.get(session) ?? Promise.resolve()).then(async () => { await point(origin, session) })
    turns.set(session, turn.catch(() => {}))
    await turn
  }

  async function pointAt (session: RouteSession, port: number): Promise<void> {
    if (pointedAt.get(session) === port) return
    await within(session.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${String(port)}` }))
    pointedAt.set(session, port)
  }

  async function point (origin: string, session: RouteSession): Promise<void> {
    if (hub.isRouted(origin)) {
      await pointAt(session, (await hub.front(origin)).port)
    } else if (pointedAt.has(session)) {
      pointedAt.delete(session)
      await within(session.setProxy({ mode: 'system' }))
    }
  }

  /** A rule that reaches nothing, for a session that could not be pointed at the app's front: a request there fails, it is never sent direct. */
  async function confine (session: RouteSession): Promise<void> {
    // Recorded, so that switching the route off puts the session back on the system's proxy.
    pointedAt.set(session, CONFINED_FRONT)
    try {
      await within(session.setProxy({ mode: 'fixed_servers', proxyRules: UNREACHABLE_PROXY }))
    } catch (error) {
      console.error('[route] could not stop a session that could not be routed:', error)
    }
  }

  async function apply (origin: string, routed: boolean, cause: RouteChangeCause): Promise<void> {
    // Asking for a session creates it on disk, so the embed partition is touched only for an app that is routed.
    if (routed) sessionsOf(origin).set(deps.sessionFor(deps.embedPartition(origin)), true)
    const sessions = [...sessionsOf(origin)]
    const pointed = await Promise.allSettled(sessions.map(async ([session, webrtc]) => { await prepare(origin, session, { webrtc }) }))
    for (const [index, outcome] of pointed.entries()) {
      if (outcome.status === 'fulfilled') continue
      console.error('[route] could not point a session of the app at its route:', outcome.reason)
      const failed = sessions[index]?.[0]
      if (routed && failed !== undefined) await confine(failed)
    }
    for (const contents of managedContents(origin)) {
      if (routed) {
        confined.add(contents)
        contents.setWebRTCIPHandlingPolicy(CONFINED)
      } else if (confined.has(contents)) {
        confined.delete(contents)
        contents.setWebRTCIPHandlingPolicy('default')
      }
    }
    // What was opened before the switch is on the old route (or none), whatever the proxy now says.
    try {
      await deps.broker()?.dropOrigin(origin)
    } catch (error) {
      console.error('[route] could not close the app\'s open handles:', error)
    }
    await Promise.allSettled(sessions.map(async ([session]) => { await within(session.closeAllConnections()) }))
    if (cause === 'switch') deps.reloadTabs(origin)
  }

  hub.onChange((origin, routed, cause) => {
    queue = queue.then(async () => { await apply(origin, routed, cause) }).catch((error: unknown) => { console.error('[route] could not apply a change of route:', error) })
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

  deps.onLogin((event, info, callback) => {
    if (!info.isProxy || info.host !== '127.0.0.1') return
    const front = temporaryFronts.get(info.port)
    const credentials = front === undefined ? hub.credentialsForPort(info.port) : { username: front.username, password: front.secret }
    if (credentials === undefined) return
    event.preventDefault()
    callback(credentials.username, credentials.password)
  })

  return {
    prepare,
    appSessionRegistered: async (origin, session) => {
      await prepare(origin, session)
      if (hub.isRouted(origin)) await prepare(origin, deps.sessionFor(deps.embedPartition(origin)))
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
    prepareTemporary: async (session, front) => {
      // Registered before the session is pointed, so a web contents made in it meanwhile already has the policy.
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
      let seen: Promise<void>
      do {
        seen = queue
        await seen
      } while (seen !== queue)
    }
  }
}
