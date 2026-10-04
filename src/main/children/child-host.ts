// One offscreen, never-attached WebContentsView per app origin: ADR-0046's
// child host. Reused for as long as the origin has one (see ./registry.ts
// for when that is), never freed early -- ../sessions/web-context-host.ts's
// own reuse-per-slot shape, with no slot here since an origin gets exactly
// one. README.md's Design notes has the measurements this reuses.

import { session as electronSession, WebContentsView } from 'electron'
import type { Session, WebContents } from 'electron'
import { join } from 'node:path'
import type { MessagePortMain } from 'electron'
import { originHash } from '../../broker/grants/origin-hash.js'
import { liveCspHeaderFor } from '../../loader/electron/serve.js'
import { ISOLATION_HEADERS } from '../../loader/serve/csp.js'
import { partitionForTarget } from '../shell/tab-view.js'
import { lockNavigation } from '../shell/lock-navigation.js'
import { CHILD_HOST_PAGE_CHANNEL, CHILD_HOST_READY_CHANNEL } from '../channels.js'
import type { Broker } from '../../broker/broker-contracts.js'

/** No `persist:` prefix: in-memory, forgotten with the process, like
 * web-context-host.ts's own partitions -- never freed while the app still
 * has one open, so the name only has to be stable across recreation of the
 * SAME origin's host, never across a whole process restart. */
function childHostPartitionName (origin: string): string {
  return `child-host-${originHash(origin)}`
}

/** Where this host's own document lives: a real path under the app's own
 * origin, answered by this session's own `protocol.handle` below -- never a
 * `data:` document (ADR-0046's Context: a `data:` document takes the origin
 * but carries no headers, so it is never cross-origin isolated). */
function wellKnownUrl (origin: string): string {
  return `${origin}/.well-known/orivon/child-host`
}

const EMPTY_CHILD_HOST_DOCUMENT = '<!DOCTYPE html><html><head><title></title></head><body></body></html>'

/**
 * The session the app's own tabs use for `origin`: `tab-view.ts`'s own
 * `partitionForTarget`, an app served from cache having a partition of its
 * own and every other app the default session.
 */
function appSessionFor (origin: string): Session {
  const partition = partitionForTarget(origin)
  return partition === undefined ? electronSession.defaultSession : electronSession.fromPartition(partition)
}

/**
 * Every scheme the host session must answer `answer` on for `origin`: always
 * both `https` and `http` -- an app served from its own network server may be
 * plain `http:` (a local development origin, say), and the host's document
 * request must never fall through to that real server, whose own SPA
 * fallback could serve the app's own page (and run its code) inside the
 * host, with none of the CSP the host sets -- plus `origin`'s own scheme
 * when it is neither of those (`registerAppOrigin`'s own derivation; no
 * origin uses a third scheme today, but a future one must not silently go
 * unhandled here the way `http` did).
 */
function schemesFor (origin: string): readonly string[] {
  const own = new URL(origin).protocol.replace(':', '')
  return own === 'https' || own === 'http' ? ['https', 'http'] : ['https', 'http', own]
}

/**
 * Wires the host's own session: deny every permission (nothing here can ever
 * show the person a dialog to answer one), no downloads, WebRTC's native
 * dial closed the same way an isolated WebContext's is, and `protocol.handle`
 * answering the host's own document with the app's live CSP (and its
 * isolation headers, when the manifest asks) while delegating every other
 * request to the session `origin`'s own tabs already load from -- so a
 * child's module, program and network requests are answered exactly as a
 * page's would be, the pinned bundle for a cached app or its own server for
 * a network-served one. Handled on every scheme in `schemesFor`, with the
 * SAME function: the document is answered "exactly at `wellKnownUrl(origin)`,
 * whatever the scheme" first, and everything else falls through to
 * `appSession.fetch` identically.
 *
 * NOT proxied through the discard port (W5, unlike `web-context-host.ts`'s
 * isolated context and the earlier version of this function): no app code
 * ever runs in this document, and a Web Worker has no `RTCPeerConnection` to
 * begin with, so the one thing that proxy could still reach here is a
 * child's own WebSocket -- `protocol.handle` never answers `ws:`/`wss:`, so
 * routing them into a discard port only breaks them outright rather than
 * confining anything. `setWebRTCIPHandlingPolicy` below is kept: it bounds
 * what the underlying session's own ICE gathering could leak even with
 * nothing here ever opening an `RTCPeerConnection`.
 */
async function configureHostSession (hostSession: Session, origin: string, broker: Broker): Promise<void> {
  hostSession.setPermissionCheckHandler(() => false)
  hostSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })

  hostSession.removeAllListeners('will-download')
  hostSession.on('will-download', (event) => { event.preventDefault() })

  const documentUrl = wellKnownUrl(origin)
  const appSession = appSessionFor(origin)

  const answer = async (request: Request): Promise<Response> => {
    if (request.url === documentUrl) {
      const headers = new Headers({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': await liveCspHeaderFor(broker, origin)
      })
      const manifest = await broker.app.manifest(origin).catch(() => undefined)
      if (manifest?.crossOriginIsolated === true) {
        for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value)
      }
      return new Response(EMPTY_CHILD_HOST_DOCUMENT, { headers })
    }
    return await appSession.fetch(request)
  }
  for (const scheme of schemesFor(origin)) {
    if (hostSession.protocol.isProtocolHandled(scheme)) hostSession.protocol.unhandle(scheme)
    hostSession.protocol.handle(scheme, answer)
  }
}

/** A stable string over `origin`'s CURRENT live grants -- compared against
 * the one a host was built with (F2). Cheap and order-sensitive rather than
 * canonicalised: a false-positive rebuild (the same grants reported in a
 * different order) costs one rebuilt host; a false negative would leave a
 * revoked or widened grant unreflected, which is the whole bug this exists
 * to close. Empty string (never a real grants signature: `broker.app.grants`
 * always resolves an array) on failure, so a broker error never *prevents* a
 * later staleness check from tripping once it recovers. */
async function grantsSignatureFor (origin: string, broker: Broker): Promise<string> {
  try {
    return JSON.stringify(await broker.app.grants(origin))
  } catch {
    return ''
  }
}

const HOST_READY_TIMEOUT_MS = 5000

/**
 * Waits for the host's own preload to report itself ready
 * (`CHILD_HOST_READY_CHANNEL`, sent once `src/preload/child-host.ts` has
 * built `orivon` and wired `ChildHost.addPage` with nothing throwing) --
 * W2: without this, a preload that threw partway through (the
 * sandboxed-bundling faults `src/preload/README.md`'s own Design notes
 * measure) left a host with no `CHILD_HOST_PAGE_CHANNEL` listener at all,
 * silently, and every page routed through it hung forever with no error
 * anywhere. Bounded, so a preload that never gets there fails the build
 * instead of hanging it.
 */
function waitForReady (webContents: WebContents): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error("orivon: the child host's own preload never reported ready"))
    }, HOST_READY_TIMEOUT_MS)
    webContents.ipc.once(CHILD_HOST_READY_CHANNEL, () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    })
  })
}

/** W2: the host's own counterpart to `../shell/tab-view.ts`'s
 * `reportAppFailures` -- a hidden view has no person watching it, so its own
 * failures are otherwise invisible. */
function reportChildHostFailures (origin: string, webContents: WebContents): void {
  webContents.on('console-message', (details) => {
    if (details.level !== 'warning' && details.level !== 'error') return
    const at = details.sourceId === '' ? '' : `  (${details.sourceId}:${String(details.lineNumber)})`
    console.error(`[orivon][child-host ${origin}] ${details.message}${at}`)
  })
  webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[orivon][child-host ${origin}] its preload threw, so it can never relay a child (${preloadPath})`, error)
  })
  webContents.on('render-process-gone', (_event, details) => {
    console.error(`[orivon][child-host ${origin}] the renderer died: ${details.reason} (exit ${String(details.exitCode)})`)
  })
}

export interface ChildHost {
  readonly origin: string
  /** Hands one MessagePortMain to the host's own preload, over the channel it listens on. */
  postPagePort (port: MessagePortMain): void
}

export interface ChildHostPool {
  /** The origin's host, building it on first use and reusing it after -- unless its live grants
   * have drifted from what it was built with (F2), in which case it is closed and rebuilt fresh
   * first. Concurrent calls for the same not-yet-built origin share the one build in flight. */
  getOrCreate (origin: string): Promise<ChildHost>
  /** Closes one origin's host, if it has one. Idempotent. */
  close (origin: string): Promise<void>
  /** Every open host -- `before-quit`'s own call. */
  closeAll (): Promise<void>
}

/** Every host this pool built, by the origin it was built for: `isChildHostFor` reads it. */
const builtHosts = new WeakMap<WebContents, string>()

/**
 * Whether `contents` is the child host this process built for `origin`, still showing its own
 * document. The broker attributes a call to an origin only from that origin's session
 * (../sessions/session-attribution.ts); a host runs in a session of its own, so it is recognised
 * here instead, and nothing else in that session ever is.
 */
export function isChildHostFor (contents: WebContents, origin: string): boolean {
  return builtHosts.get(contents) === origin && !contents.isDestroyed() && contents.getURL() === wellKnownUrl(origin)
}

interface HostRecord {
  readonly view: WebContentsView
  readonly webContents: WebContents
  readonly session: Session
  /** F2: what `origin`'s live grants looked like when this host was built. */
  readonly grantsSignature: string
}

/** `getBroker` is a lazy thunk for the same reason ../sessions/web-context-host.ts's is: this pool
 * is built and wired in before the real broker exists. */
export function createChildHostPool (
  getBroker: () => Broker,
  // import.meta.dirname is out/main/ for every file bundled into the single
  // main entry, whatever its own nesting under src/main/ -- tabs.ts's own
  // join(import.meta.dirname, '../preload/app.js') is the same shape.
  preloadPath: string = join(import.meta.dirname, '../preload/child-host.js')
): ChildHostPool {
  const hosts = new Map<string, Promise<HostRecord>>()

  async function build (origin: string): Promise<HostRecord> {
    const broker = getBroker()
    const hostSession = electronSession.fromPartition(childHostPartitionName(origin), { cache: false })

    const view = new WebContentsView({
      webPreferences: {
        session: hostSession,
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false,
        // Nobody watches the host: a native alert box could never be answered.
        disableDialogs: true
      }
    })
    const webContents = view.webContents
    builtHosts.set(webContents, origin)
    reportChildHostFailures(origin, webContents)

    // F5: a crash (or any other reason the renderer is gone) must close
    // this view and drop ITS OWN entry -- comparing the RESOLVED record's
    // webContents, never blind origin-keyed deletion, so a crash of an
    // already-superseded host (one a later build already replaced in
    // `hosts`) never deletes the newer, still-live one.
    webContents.on('render-process-gone', () => {
      if (!webContents.isDestroyed()) webContents.close()
      void hosts.get(origin)?.then(
        (record) => { if (record.webContents === webContents) hosts.delete(origin) },
        () => {} // this build already failed its own way below; nothing more to drop here
      )
    })

    try {
      webContents.setAudioMuted(true)
      webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
      // No `allowedUrl`: this document never navigates again, not even back
      // to itself -- lockNavigation's own contract for a page like this one.
      lockNavigation(webContents)

      await configureHostSession(hostSession, origin, broker)
      // Registered BEFORE the load, never after: the preload can send its
      // ready ping at `document-start`, well before `loadURL`'s own promise
      // settles on `did-finish-load` -- awaiting `loadURL` first would race
      // it and, having missed it, time out for good (measured live).
      // Awaited together, so a failed load never leaves the ready wait to reject later with nothing listening, which
      // would end the browser.
      const ready = waitForReady(webContents)
      await Promise.all([webContents.loadURL(wellKnownUrl(origin)), ready])
    } catch (error) {
      if (!webContents.isDestroyed()) webContents.close()
      throw error
    }

    return { view, webContents, session: hostSession, grantsSignature: await grantsSignatureFor(origin, broker) }
  }

  async function getOrCreate (origin: string): Promise<ChildHost> {
    const broker = getBroker()
    let pending = hosts.get(origin)
    if (pending !== undefined) {
      // F2: an existing, successfully built host whose grants have since
      // changed (granted, revoked, or its manifest/registration changed
      // enough to move `broker.app.grants` at all) is closed here, so the
      // NEXT child -- this one -- builds a fresh host with the current
      // session and CSP, rather than reusing one still carrying whatever
      // was live at build time. A build still in flight, or one that
      // already failed, is never treated as stale -- there is nothing yet
      // to compare, and its own paths handle it.
      const stale = await pending.then(
        async (record) => record.grantsSignature !== await grantsSignatureFor(origin, broker),
        () => false
      )
      if (stale) {
        await close(origin)
        pending = undefined
      }
    }
    if (pending === undefined) {
      pending = build(origin)
      hosts.set(origin, pending)
      const attempt = pending
      // A build that throws must not leave a dead promise blocking every
      // later attempt for this origin -- only if THIS attempt is still the
      // one on record (getOrCreate's own stale-close above may already have
      // replaced it by the time this settles).
      attempt.catch(() => { if (hosts.get(origin) === attempt) hosts.delete(origin) })
    }
    const record = await pending
    return {
      origin,
      postPagePort: (port) => {
        try {
          record.webContents.mainFrame.postMessage(CHILD_HOST_PAGE_CHANNEL, null, [port])
        } catch (error) {
          // F5: the host's own frame can be gone by the time a page's
          // connect() reaches here (a race with the host crashing) -- the
          // page's own port simply never gets an answer, exactly as a
          // frame gone between the check and the send already is in
          // registry.ts, never an uncaught throw that reaches
          // index.ts's `unhandledRejection` handler.
          console.error(`[orivon][child-host ${origin}] could not deliver a page's port`, error)
        }
      }
    }
  }

  async function close (origin: string): Promise<void> {
    const pending = hosts.get(origin)
    if (pending === undefined) return
    hosts.delete(origin)
    try {
      const { webContents, session: hostSession } = await pending
      if (!webContents.isDestroyed()) webContents.close()
      // N3: a host's session (and so its child's own IndexedDB/Cache
      // Storage -- ADR-0046's own Consequences) otherwise outlives this
      // host, reachable again by the very next one built for this origin.
      // Nothing here promises a child's web storage survives a host
      // generation, so clearing it is the safer default; if a session ever
      // needs that, it earns its own decision-log row. `clearData`,
      // matching `../sessions/web-context-host.ts`'s own teardown.
      await hostSession.clearData().catch(() => {})
    } catch { /* the build itself failed; nothing was ever open */ }
  }

  async function closeAll (): Promise<void> {
    await Promise.all([...hosts.keys()].map(async (origin) => { await close(origin) }))
  }

  return { getOrCreate, close, closeAll }
}
