// ADR-0019's Electron half: the real `WebContextHost` (broker/web-context-
// contracts.ts) src/broker/web-capability.ts calls through `CreateBrokerOptions
// .webContextHost`. Everything security-relevant about the isolated context
// lives HERE, not in the broker (which stays Electron-free, ../broker/
// web-capability.ts's own header) -- the partition, the sandboxed/isolated
// WebContentsView, the reach-only network path, and the CORS wrapper the
// spec's own item 5 asks to keep beside this file rather than in the loader.
//
// `getBroker` is a LAZY THUNK, not a captured `Broker`, because this host is
// built and wired into `CreateBrokerOptions` BEFORE `createBroker(...)`
// returns the very broker it needs (../broker/transport/ipc.ts's own
// `brokerIpcSubsystem` -- see that file for the wiring). Resolved only
// inside `open()`, well after `ctx.broker` is published.

import { session as electronSession, WebContentsView } from 'electron'
import type { Session, WebContents } from 'electron'
import { LIMITS } from '../contracts/index.js'
import { originHash } from '../broker/grants/origin-hash.js'
import { reachOnlyHandlerFor } from '../loader/electron-serve.js'
import type { Broker, WebContextHost } from '../broker/broker-contracts.js'

const EMPTY_DOCUMENT = 'data:text/html,<!DOCTYPE html><html><head><title></title></head><body></body></html>'

/**
 * The discard port (RFC 863) on loopback -- nothing answers there. Every
 * native connection this session's own network stack dials OUTSIDE
 * `protocol.handle`/`webRequest` (WebRTC's ICE/STUN/TURN dial is the known
 * one, `docs/open-questions.md` A41) is routed here and dies rather than
 * reaching the real network -- `protocol.handle`'s https/http responses
 * never consult a session's proxy at all, so the context's own `fetch()` is
 * unaffected. See README.md's Design notes for why, and what was measured.
 */
const WEBRTC_ESCAPE_PROXY = 'http://127.0.0.1:9'

/** 128 bits from the platform CSPRNG, as hex -- the host's OWN id, never a caller-supplied one (WebContextHost's own doc). Same construction as handle-store.ts's newHandleId, duplicated rather than imported: that one is broker-internal and this module must not reach into src/broker/handles/. */
function newHostId (): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * ADR-0019's own network path, wrapped with CORS for the context's origin --
 * kept beside the host (spec item 5) rather than in loader/electron-serve.ts,
 * which owns the reach DECISION but not this response shape. An `OPTIONS`
 * preflight is answered synthetically, never reaching the network; every
 * other response gets `access-control-allow-origin` for the context's own
 * origin, the one origin a context's own `fetch()` is ever entitled to see
 * a non-opaque response from (ADR-0019: "the app can read these responses
 * anyway through routed fetch, and the context carries no credentials").
 */
function withContextCors (
  handler: (request: Request) => Promise<Response>,
  contextOrigin: string
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      const headers = new Headers({ 'access-control-allow-origin': contextOrigin })
      const requestMethod = request.headers.get('access-control-request-method')
      const requestHeaders = request.headers.get('access-control-request-headers')
      if (requestMethod !== null) headers.set('access-control-allow-methods', requestMethod)
      if (requestHeaders !== null) headers.set('access-control-allow-headers', requestHeaders)
      return new Response(null, { status: 204, headers })
    }
    const response = await handler(request)
    const headers = new Headers(response.headers)
    headers.set('access-control-allow-origin', contextOrigin)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }
}

/** `protocol.handle('http', ...)`'s own refusal -- without registering this scheme too, a plain `fetch('http://...')` from inside the context would fall through to Electron's real network stack, unauthorised, rather than into `fetchThirdParty`'s own gate (which only ever answers `https:`). */
function httpRefusalResponse (): Response {
  return new Response(
    'Orivon: plain http is never reachable from an isolated context',
    { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }
  )
}

/** `web.contexts`'s in-memory, NO `persist:` prefix partition name for one (opener, slot) -- stable across reopenings of the same slot (Electron never frees a session, ADR-0019), and never colliding across openers (hashed, never the literal origin). */
function partitionName (opener: string, slot: number): string {
  return `web-context-${originHash(opener)}-${String(slot)}`
}

interface OpenContextRecord {
  readonly webContents: WebContents
  readonly session: Session
  readonly opener: string
  readonly slot: number
}

/**
 * Builds the real `WebContextHost`. `getBroker` is resolved fresh on every
 * `open()` -- see this file's own header for why it must be a thunk, not a
 * captured value.
 */
export function createWebContextHost (getBroker: () => Broker): WebContextHost {
  const contexts = new Map<string, OpenContextRecord>()
  const slotsInUse = new Map<string, Set<number>>()
  const goneListeners = new Set<(id: string, platformCode: string) => void>()

  function allocateSlot (opener: string): number {
    const used = slotsInUse.get(opener) ?? new Set<number>()
    for (let slot = 0; slot < LIMITS.webContexts; slot += 1) {
      if (!used.has(slot)) {
        used.add(slot)
        slotsInUse.set(opener, used)
        return slot
      }
    }
    // broker/web-capability.ts's own HandleTable already enforces
    // LIMITS.webContexts BEFORE this is ever called (assertCapacity, kind
    // 'webContext') -- reaching here means this file's own slot bookkeeping
    // has drifted from the broker's, a bug here, never a real over-budget
    // request an app could trigger.
    throw new Error('no free web-context slot for this opener -- host/broker slot bookkeeping mismatch')
  }

  function releaseSlot (opener: string, slot: number): void {
    slotsInUse.get(opener)?.delete(slot)
  }

  /**
   * The ONE teardown, used by `close()` AND by every failure path inside
   * `open()` (Finding 1 of the security review this fixes -- before this,
   * `open()`'s own `catch` released the slot without ever calling this,
   * leaving the view alive and handing the next `open()` for that slot a
   * partition that was never cleared). Same order both callers need:
   * destroy the view FIRST -- a still-open connection when `clearData`/
   * `closeAllConnections` run is exactly what `avoidClosingConnections`
   * exists to protect against, and this context owns nothing worth
   * protecting -- then clear the partition, so it holds nothing (ADR-0019's
   * own contract) by the time anyone can reuse the slot.
   *
   * `webContents` is `undefined` when a failure happened before the view
   * was even created (`configureSession` throwing) -- there is then nothing
   * to close, so that step is skipped rather than guarded with a throw.
   *
   * THE SLOT IS RELEASED ONLY ON THE WAY OUT, past both awaits -- if either
   * one throws, `releaseSlot` never runs and the slot is quarantined for
   * the rest of this process's life (never reallocated: `allocateSlot`
   * only ever sees it as still in use). That is deliberate, not a missed
   * case: `closeAllConnections`/`clearData` failing means this partition's
   * contents are now unknown, and handing the slot back would let the very
   * next `open()` for it inherit whatever that is -- the exact leak this
   * function exists to close. `LIMITS.webContexts` is a small per-opener
   * cap (2), so losing one slot this way is cheap; guessing the partition
   * is actually clean is not safe at any price. The caller decides what to
   * do with the original failure; this function only ever throws the
   * teardown's own error, never swallows it.
   */
  async function teardown (
    opener: string,
    slot: number,
    webContents: WebContents | undefined,
    contextSession: Session
  ): Promise<void> {
    try {
      if (webContents !== undefined && !webContents.isDestroyed()) webContents.close()
    } catch { /* already gone */ }

    await contextSession.closeAllConnections()
    await contextSession.clearData()

    releaseSlot(opener, slot)
  }

  /**
   * Wires (or rewires, on slot reuse) one partition's session: deny every
   * permission outright, cancel every download, cancel ws:/wss:, and answer
   * https/http through the reach-only path for `opener`, CORS-wrapped for
   * `origin`. Idempotent -- `protocol.handle` throws on a scheme already
   * handled on the same session (electron-serve.ts's own registerAppOrigin
   * precedent), and `will-download` is a plain EventEmitter listener that
   * would otherwise accumulate one per reuse of this slot's session.
   */
  async function configureSession (contextSession: Session, opener: string, origin: string): Promise<void> {
    // NOT redundant with permission-gate.ts, which allows
    // 'clipboard-sanitized-write' browser-wide: these two lines are the only
    // thing keeping that away from a document running another site's script,
    // where a copy the person never asked for has nothing to do with them
    // acting in a page they can see. Deleting them as duplication reopens it.
    contextSession.setPermissionCheckHandler(() => false)
    contextSession.setPermissionRequestHandler((_webContents, _permission, callback) => { callback(false) })

    contextSession.removeAllListeners('will-download')
    contextSession.on('will-download', (event) => { event.preventDefault() })

    contextSession.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url
      if (details.resourceType === 'webSocket' || url.startsWith('ws:') || url.startsWith('wss:')) {
        callback({ cancel: true })
      } else {
        callback({})
      }
    })

    // Awaited BEFORE anything loads: the belt against A41 for whatever
    // escapes the handlers below (WebRTC's own dial, chiefly) must be live
    // from the context's very first moment, not raced against it.
    await contextSession.setProxy({ mode: 'fixed_servers', proxyRules: WEBRTC_ESCAPE_PROXY })

    const reach = withContextCors(reachOnlyHandlerFor(getBroker(), opener), origin)
    if (contextSession.protocol.isProtocolHandled('https')) contextSession.protocol.unhandle('https')
    contextSession.protocol.handle('https', reach)
    if (contextSession.protocol.isProtocolHandled('http')) contextSession.protocol.unhandle('http')
    contextSession.protocol.handle('http', async () => httpRefusalResponse())
  }

  /**
   * A context's own renderer dying on its own -- Electron's
   * `render-process-gone`, normally a crash or an OOM kill -- rather than
   * through `close()` or a revoke. Finding 3 of the security review this
   * fixes: before this, nothing reacted until `LIMITS.webContextIdleMs`
   * closed it as merely idle.
   *
   * `contexts.get(id)` can already be gone here -- `close()` racing this
   * same event is exactly why this is a lookup-and-bail, not an assumption.
   * Teardown failing does not stop the broker from being told: an app
   * learning late that its context is gone is still better than one that
   * never learns at all, so this only logs (`console.error`, this
   * codebase's own convention for a swallowed fault -- see e.g.
   * ../broker/transport/socket-relay.ts) and still notifies every listener.
   */
  async function handleRenderProcessGone (id: string, platformCode: string): Promise<void> {
    const entry = contexts.get(id)
    if (entry === undefined) return
    contexts.delete(id)
    try {
      await teardown(entry.opener, entry.slot, entry.webContents, entry.session)
    } catch (error) {
      console.error('[web-context-host] teardown failed after a crashed context; its slot is quarantined', error)
    }
    goneListeners.forEach((listener) => { listener(id, platformCode) })
  }

  async function open (opener: string, origin: string, size: { width: number, height: number }): Promise<string> {
    const slot = allocateSlot(opener)
    const contextSession = electronSession.fromPartition(partitionName(opener, slot), { cache: false })
    let webContents: WebContents | undefined
    try {
      await configureSession(contextSession, opener, origin)

      const view = new WebContentsView({
        webPreferences: {
          session: contextSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          offscreen: true,
          backgroundThrottling: false
        }
      })
      view.setBounds({ x: 0, y: 0, width: size.width, height: size.height })
      webContents = view.webContents
      webContents.setAudioMuted(true)
      webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      // The other belt against A41 -- see WEBRTC_ESCAPE_PROXY's own comment
      // and README.md's Design notes. A context has no reason to use WebRTC
      // at all, so this is refused outright rather than merely constrained.
      webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')

      await webContents.loadURL(EMPTY_DOCUMENT, { baseURLForDataURL: `${origin}/` })

      const actualOrigin = await webContents.executeJavaScript('self.origin')
      if (actualOrigin !== origin) {
        throw new Error(`the context document settled at ${String(actualOrigin)}, not the requested ${origin}`)
      }

      // ONLY AFTER THE FIRST LOAD -- webContents.loadURL's own programmatic
      // navigation does not fire will-navigate at all (Electron's own doc),
      // so these listeners never see it; attaching them any earlier would
      // only be defensive, never load-bearing, and attaching them here
      // matches the spec's own ordering exactly.
      const id = newHostId()

      const preventTopFrameNavigation = (event: { preventDefault: () => void }): void => { event.preventDefault() }
      webContents.on('will-navigate', preventTopFrameNavigation)
      webContents.on('will-redirect', preventTopFrameNavigation)
      webContents.on('will-frame-navigate', (event) => { if (event.isMainFrame) event.preventDefault() })
      // Finding 3: react to the renderer dying on its own (a crash, an OOM
      // kill) rather than learning about it only from the idle timer.
      // Registered here, alongside the navigation guards above, rather than
      // earlier -- a crash during loadURL/executeJavaScript above already
      // surfaces as a rejection there, which the catch block below already
      // tears down; this listener is for AFTER open() has already returned.
      webContents.on('render-process-gone', (_event, details) => {
        void handleRenderProcessGone(id, details.reason)
      })

      contexts.set(id, { webContents, session: contextSession, opener, slot })
      return id
    } catch (error) {
      try {
        await teardown(opener, slot, webContents, contextSession)
      } catch (teardownError) {
        console.error('[web-context-host] teardown failed after a failed open; its slot is quarantined', teardownError)
      }
      throw error
    }
  }

  async function evaluate (id: string, script: string): Promise<unknown> {
    const entry = contexts.get(id)
    if (entry === undefined) throw new Error('no such web context')
    return await entry.webContents.executeJavaScript(script)
  }

  async function close (id: string): Promise<void> {
    const entry = contexts.get(id)
    if (entry === undefined) return // idempotent, matching Handle.close()'s own contract
    contexts.delete(id)
    await teardown(entry.opener, entry.slot, entry.webContents, entry.session)
  }

  function onGone (listener: (id: string, platformCode: string) => void): void {
    goneListeners.add(listener)
  }

  return { open, evaluate, close, onGone }
}
