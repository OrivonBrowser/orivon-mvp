// ADR-0046's page<->host handshake, app tabs only -- gated on the SAME
// `--orivon-app-tab` flag ./expose-shim-globals.ts reads (src/main/shell/
// tab-view.ts's `appTabArgsFor`).
//
// F1 (docs/architecture/security-model.md's T17 row): the raw connection to
// the app's child host is a bearer capability -- anyone who can post to
// `window` can get or spoof one, and once carried across it keeps working
// after the tab that got it is gone, for as long as any page of the app
// keeps the host alive. So the connection itself never leaves this
// isolated-world preload. What the main world gets instead is a small set
// of `contextBridge`-proxied closures (`start`/`send`/`kill`, this file's
// own `ChildrenPageBridge`) -- exactly how `window.orivon`'s own net surface
// hands a page a socket without ever handing it a `MessagePortMain`
// (surface/main-world-socket.ts, ports/README.md's rule). The page's own
// half of this, and what it does with these closures, is
// `../shim/child-process/host-client.ts`.
//
// Installed under a REGISTERED SYMBOL on the main world's `window`, never a
// new STRING global: a string name would need `check:page-globals`'s
// ORIVON_OWN_GLOBALS allowlist grown for a single internal channel, exactly
// the guard `window.orivon` itself already carries a purpose-built exemption
// for (ADR-0021). A symbol was never a platform global to begin with, so
// check-page-globals.mjs's own `SYMBOL_ARGUMENTS` case reads it as
// categorically outside that guard's concern, locked or not.

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CHILD_HOST_CONNECT_CHANNEL, CHILD_HOST_PORT_CHANNEL } from '../main/channels.js'

const APP_TAB_FLAG = '--orivon-app-tab'

/**
 * The registered-symbol key: BOTH this file's own `installChildrenBridge`
 * below (main-world install) and `../shim/child-process/host-client.ts`
 * (main-world read) call `Symbol.for('orivon:children')` with this exact
 * string -- `Symbol.for` returns the SAME symbol for the same string in one
 * realm's global registry, so the two sides need no shared module binding
 * (impossible here anyway: `installChildrenBridge` is serialised and
 * re-evaluated fresh in the main world, so it cannot import one, and
 * `check-page-globals.mjs`'s own `SYMBOL_ARGUMENTS` case only reads a
 * literal `Symbol.for('...')` at the call site, never a constant). A test
 * importing this file checks its own literal against this one, so the two
 * can never drift silently.
 */
export const CHILDREN_BRIDGE_KEY = 'orivon:children'

/**
 * What the main world gets instead of a raw port. A message this carries is
 * always plain data (`unknown` here on purpose -- this file must never
 * import `src/shim/`, the one dependency direction `src/preload/README.md`
 * forbids; the shim casts these back to its own `ToHostChild`/`FromHostChild`
 * wire types on its own side of the boundary).
 */
export interface ChildrenPageBridge {
  /**
   * Starts one child, resolving with its id once the host accepts the
   * per-child port -- or rejecting if the app's host never comes up at all
   * (F5: a dead or failed host must fail a start, never hang it forever).
   * `onMessage` gets every message the host relays back for this child, in
   * order, until the port closes.
   */
  start: (start: unknown, onMessage: (message: unknown) => void) => Promise<string>
  /** One message to an already-started child. Silently dropped once the
   * child's own port is gone -- matching a real `Worker`'s own
   * postMessage-after-terminate no-op. */
  send: (childId: string, message: unknown) => void
  /** Ends one child right away and frees its port pair (shim finding 16). */
  kill: (childId: string) => void
}

/** The one IPC round trip this whole bridge ever makes (F6: at most once
 * per document -- everything after the first `start()` reuses it, or, once
 * it fails, retries fresh rather than replaying a cached rejection forever). */
function requestHostPort (): Promise<MessagePort> {
  return new Promise((resolve, reject) => {
    const onPort = (event: IpcRendererEvent): void => {
      const port = event.ports[0]
      if (port === undefined) { reject(new Error('orivon: the child host handshake carried no port')); return }
      resolve(port)
    }
    ipcRenderer.once(CHILD_HOST_PORT_CHANNEL, onPort)
    ipcRenderer.send(CHILD_HOST_CONNECT_CHANNEL)
  })
}

/**
 * Builds the isolated-world closures `installChildrenBridge` hands to the
 * main world. Everything a raw `MessagePort` would have let the page do
 * directly -- keep the shared host connection, mint a per-child
 * `MessageChannel`, transfer its far end to the host -- happens here
 * instead; the main world only ever sees `start`/`send`/`kill`.
 */
export function buildChildrenBridge (): ChildrenPageBridge {
  /** The page's one connection to its app's child host -- undefined before
   * the first child, and again after the host (or the handshake itself)
   * goes away, so the NEXT `start()` reconnects rather than replaying a
   * dead port forever (F5/shim-8: a host crash must not strand every later
   * child of this page). */
  let hostPort: Promise<MessagePort> | undefined

  function connectedHostPort (): Promise<MessagePort> {
    if (hostPort === undefined) {
      const attempt: Promise<MessagePort> = requestHostPort().then((port) => {
        // Fires when the HOST'S end of this shared port is gone (its
        // WebContents crashed or was closed) -- never on an ordinary
        // message. Only reset the cache if THIS attempt is still the
        // current one: a newer attempt's own 'close' must not clobber it.
        port.addEventListener('close', () => { if (hostPort === attempt) hostPort = undefined })
        return port
      }).catch((error: unknown) => {
        if (hostPort === attempt) hostPort = undefined
        throw error
      })
      hostPort = attempt
    }
    return hostPort
  }

  let nextChildId = 0
  const children = new Map<string, MessagePort>()

  return {
    async start (start, onMessage) {
      const port = await connectedHostPort()
      const childId = String(nextChildId++)
      const { port1: local, port2: remote } = new MessageChannel()
      local.onmessage = (event: MessageEvent) => { onMessage(event.data) }
      // The host closes ITS end once the child is truly over (shim finding
      // 16); a host crash closes every per-child port it held the same way
      // (measured, ../shim/worker/host.ts's own header) -- either way,
      // 'close' here is this child's own end of the story, always.
      local.addEventListener('close', () => { children.delete(childId) })
      local.start()
      children.set(childId, local)
      port.postMessage({ type: 'start-child', port: remote, start, extra: [] }, [remote])
      return childId
    },
    send (childId, message) {
      children.get(childId)?.postMessage(message)
    },
    kill (childId) {
      const local = children.get(childId)
      if (local === undefined) return
      local.postMessage({ type: 'terminate' })
      local.close()
      children.delete(childId)
    }
  }
}

/**
 * Runs IN THE MAIN WORLD: `contextBridge.executeInMainWorld` serialises this
 * function (`Function.prototype.toString`) and re-evaluates it fresh there
 * (`surface/README.md`'s own note on `installOrivon` explains the same
 * constraint), so every free identifier below must resolve inside a plain
 * browser realm -- nothing from this module's own closure. `target`
 * defaults to the real `window`, overridable so a test never mutates the
 * one shared global environment (`surface/main-world-socket.ts`'s own
 * `installOrivon` takes the identical parameter for the identical reason).
 * Every entry applies `installOrivon`'s page-caller check, read from the internal-net slot here:
 * it must run AFTER `exposeOrivon()` and BEFORE `exposeFetchRoute()`, which releases that slot.
 */
export function installChildrenBridge (
  bridge: ChildrenPageBridge,
  target: object = typeof window === 'undefined' ? {} : window
): void {
  // ADR-0045's page-caller check, read from the slot `installOrivon` shares (an extension's
  // main-world script must not start, message or kill an app's children). Fail closed: no slot,
  // or no check in it, refuses every entry. Everything here stays inside this function's body.
  const slot = (target as Record<symbol, { callerIsPage?: (exclude: (...args: never[]) => unknown) => boolean } | undefined>)[Symbol.for('orivon.internal-net')]
  const callerIsPage = typeof slot?.callerIsPage === 'function' ? slot.callerIsPage : undefined
  function refusal (): Error & { code: string } {
    const error = new Error("orivon: refused -- the caller could not be attributed to this page's own script") as Error & { code: string }
    error.name = 'OrivonError'
    error.code = 'denied'
    return error
  }
  function allowed (wrapped: (...args: never[]) => unknown): boolean {
    try { return callerIsPage !== undefined && callerIsPage(wrapped) } catch { return false }
  }
  const guardedBridge: ChildrenPageBridge = {
    start: function wrappedStart (start, onMessage) {
      if (!allowed(wrappedStart as (...args: never[]) => unknown)) return Promise.reject(refusal())
      return bridge.start(start, onMessage)
    },
    send: function wrappedSend (childId, message) {
      if (!allowed(wrappedSend as (...args: never[]) => unknown)) throw refusal()
      bridge.send(childId, message)
    },
    kill: function wrappedKill (childId) {
      if (!allowed(wrappedKill as (...args: never[]) => unknown)) throw refusal()
      bridge.kill(childId)
    }
  }
  Object.defineProperty(target, Symbol.for('orivon:children'), {
    value: Object.freeze(guardedBridge),
    writable: false,
    configurable: false,
    enumerable: false
  })
}

export function exposeChildHostConnect (): void {
  if (!process.argv.includes(APP_TAB_FLAG)) return
  // ADR-0046 simply does not apply on a page with no main-world execution
  // hook: every child this page's own code starts runs locally
  // (`../shim/child-process/host-client.ts`'s own structural check --
  // `window[Symbol.for('orivon:children')]` never exists).
  if (typeof contextBridge.executeInMainWorld !== 'function') return

  const bridge = buildChildrenBridge()
  try {
    contextBridge.executeInMainWorld({ func: installChildrenBridge, args: [bridge] })
  } catch (error) {
    console.error('[orivon] child-host bridge install failed; this page\'s children run locally', error)
  }
}
