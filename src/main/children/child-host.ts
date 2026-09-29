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

/** RFC 863's discard port on loopback -- nothing answers there. Same belt
 * against WebRTC's own ICE/STUN/TURN dial escaping `protocol.handle`/
 * `webRequest` as ../sessions/web-context-host.ts's WEBRTC_ESCAPE_PROXY;
 * duplicated rather than imported, since that constant is that file's own
 * private detail, not an exported one. */
const WEBRTC_ESCAPE_PROXY = 'http://127.0.0.1:9'

/**
 * The session the app's own tabs use for `origin` -- `tab-view.ts`'s own
 * `partitionForTarget`, or the default session when it answers undefined
 * (an origin the broker does not yet see as granted or cached; the registry
 * never reaches this far for such an origin, since it refuses a connect for
 * one that is not even registered, but a defensive read here still resolves
 * to something rather than throwing).
 */
function appSessionFor (origin: string, broker: Broker): Session {
  const partition = partitionForTarget(origin, broker)
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
 */
async function configureHostSession (hostSession: Session, origin: string, broker: Broker): Promise<void> {
  hostSession.setPermissionCheckHandler(() => false)
  hostSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })

  hostSession.removeAllListeners('will-download')
  hostSession.on('will-download', (event) => { event.preventDefault() })

  await hostSession.setProxy({ mode: 'fixed_servers', proxyRules: WEBRTC_ESCAPE_PROXY })

  const documentUrl = wellKnownUrl(origin)
  const appSession = appSessionFor(origin, broker)

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

export interface ChildHost {
  readonly origin: string
  /** Hands one MessagePortMain to the host's own preload, over the channel it listens on. */
  postPagePort (port: MessagePortMain): void
}

export interface ChildHostPool {
  /** The origin's host, building it on first use and reusing it after. Concurrent calls for the
   * same not-yet-built origin share the one build in flight. */
  getOrCreate (origin: string): Promise<ChildHost>
  /** Closes one origin's host, if it has one. Idempotent. */
  close (origin: string): Promise<void>
  /** Every open host -- `before-quit`'s own call. */
  closeAll (): Promise<void>
}

interface HostRecord {
  readonly view: WebContentsView
  readonly webContents: WebContents
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
    await configureHostSession(hostSession, origin, broker)

    const view = new WebContentsView({
      webPreferences: {
        session: hostSession,
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        offscreen: true,
        backgroundThrottling: false
      }
    })
    const webContents = view.webContents
    webContents.setAudioMuted(true)
    webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    // No `allowedUrl`: this document never navigates again, not even back to
    // itself -- lockNavigation's own contract for a page like this one.
    lockNavigation(webContents)
    // Its own crash. Dropping the map entry is enough: the next connect() for
    // this origin calls build() again, and nothing here holds a reference to
    // the dead view once it is gone.
    webContents.on('render-process-gone', () => { hosts.delete(origin) })

    await webContents.loadURL(wellKnownUrl(origin))
    return { view, webContents }
  }

  async function getOrCreate (origin: string): Promise<ChildHost> {
    let pending = hosts.get(origin)
    if (pending === undefined) {
      pending = build(origin)
      hosts.set(origin, pending)
      // A build that throws must not leave a dead promise blocking every
      // later attempt for this origin.
      pending.catch(() => { hosts.delete(origin) })
    }
    const record = await pending
    return {
      origin,
      postPagePort: (port) => { record.webContents.mainFrame.postMessage('orivon:child-host:page', null, [port]) }
    }
  }

  async function close (origin: string): Promise<void> {
    const pending = hosts.get(origin)
    if (pending === undefined) return
    hosts.delete(origin)
    try {
      const { webContents } = await pending
      if (!webContents.isDestroyed()) webContents.close()
    } catch { /* the build itself failed; nothing was ever open */ }
  }

  async function closeAll (): Promise<void> {
    await Promise.all([...hosts.keys()].map(async (origin) => { await close(origin) }))
  }

  return { getOrCreate, close, closeAll }
}
