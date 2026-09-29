// The page's own half of ADR-0046: F1's redesign moved the actual
// connection to the app's child host into the isolated-world preload
// (`../preload/expose-child-host-connect.ts`'s own header says why -- T17,
// docs/architecture/security-model.md). What THIS page's own code gets is
// `window[Symbol.for('orivon:children')]`, a `contextBridge`-proxied bridge
// of plain closures (`start`/`send`/`kill`) -- never a `MessagePort`. This
// file adapts that bridge to `WorkerLike` (../worker/protocol.ts), the exact
// interface `spawn.ts`'s `launchChild()` already uses for a same-process
// Worker, so `ChildProcess` itself never knows which kind of child it has.

import type { FromWorker, ToWorker, WorkerLike } from '../worker/protocol.js'
import type { HostStart } from '../worker/host-protocol.js'

/** What this file needs from `window` -- structural, so a test never touches the one real
 * global environment (`spawn.ts`'s own reason for `launchChild()`'s injectable Worker factory). */
export interface WindowLike {
  [key: symbol]: unknown
}

/** The bridge shape the preload installs -- kept local (not imported from
 * `../../preload/`, a direction `src/shim/README.md` forbids) and cast to at
 * the one place this file reads `window`. Exported only so a test can build
 * one to inject via `createRemoteWorker`'s own `getBridge` parameter. */
export interface ChildrenBridge {
  start: (start: HostStart, onMessage: (message: FromWorker) => void) => Promise<string>
  send: (childId: string, message: ToWorker | { readonly type: 'terminate' }) => void
  kill: (childId: string) => void
}

/** `Symbol.for('orivon:children')` -- see `../../preload/expose-child-host-connect.ts`'s own
 * header for why a registered symbol, and why this string must match its literal exactly. */
const CHILDREN_BRIDGE_KEY = 'orivon:children'

function realWindow (): WindowLike | undefined {
  return typeof window === 'undefined' ? undefined : window as unknown as WindowLike
}

function childrenBridge (win: WindowLike | undefined): ChildrenBridge | undefined {
  if (win === undefined) return undefined
  return win[Symbol.for(CHILDREN_BRIDGE_KEY)] as ChildrenBridge | undefined
}

const USE_REAL_WINDOW = Symbol('use the real window')
let overrideWin: WindowLike | undefined | typeof USE_REAL_WINDOW = USE_REAL_WINDOW

/**
 * For a test only: makes `hasChildHost`/`createRemoteWorker` read a fake
 * `window` instead of the real global one -- called with `undefined` to
 * simulate no bridge at all (a page outside Orivon, or a Worker's own
 * nested children). Called with NO argument, restores the real window.
 */
export function useWindowForTests (...override: [] | [WindowLike | undefined]): void {
  overrideWin = override.length === 0 ? USE_REAL_WINDOW : override[0]
}

function currentWindow (): WindowLike | undefined {
  return overrideWin === USE_REAL_WINDOW ? realWindow() : overrideWin
}

/**
 * Whether this page's app has a child host to route through -- a plain
 * structural check (W7): the preload installs the bridge, or it does not,
 * the moment this document's scripts start running, so there is nothing to
 * race or time out on the page's own side any more. `false` for a Worker's
 * own nested children (no `window` there at all), a page outside Orivon, or
 * any tab that is not a registered app.
 */
export function hasChildHost (): boolean {
  return childrenBridge(currentWindow()) !== undefined
}

/**
 * A child routed through the app's host, behind the exact interface
 * `ChildProcess` already uses for a same-process Worker
 * (`../worker/protocol.ts`'s `WorkerLike`): `postMessage`, `onmessage`,
 * `terminate`. Every `postMessage`/`terminate` call made before the host
 * actually accepts the child (`bridge.start` is asynchronous: it crosses
 * `contextBridge` and may itself await the app's very first connection) is
 * queued and replayed in order once it does -- mirroring
 * `../worker/host.ts`'s own buffering for the same race on the host's side.
 * `getBridge` is injectable only for a test.
 */
export function createRemoteWorker (
  start: HostStart,
  getBridge: () => ChildrenBridge | undefined = () => childrenBridge(currentWindow())
): WorkerLike {
  const bridge = getBridge()
  const adapter: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message: ToWorker) => { enqueueOrSend(message) },
    // No wire member for this in ToWorker: a real Worker's own terminate()
    // is a platform call, never a message, everywhere else this protocol is
    // used -- host-protocol.ts's ToHostChild is what gives it one for this
    // one extra hop.
    terminate: () => {
      if (childId !== undefined) { bridge?.kill(childId); return }
      killedBeforeStarted = true
    }
  }

  let childId: string | undefined
  let queued: ToWorker[] = []
  let killedBeforeStarted = false

  function enqueueOrSend (message: ToWorker): void {
    if (childId !== undefined) { bridge?.send(childId, message); return }
    queued.push(message)
  }

  if (bridge === undefined) {
    // No host on this page at all -- `launchChild` never calls this branch
    // in practice (it only builds a remote worker once `hasChildHost()` is
    // true), but failing the same way a start the host itself refused would
    // is cheaper than a silent hang.
    queueMicrotask(() => { adapter.onmessage?.({ data: { type: 'failed', error: { name: 'Error', message: 'orivon: no child host on this page', code: 'ENOEXEC' } } } as MessageEvent<FromWorker>) })
    return adapter
  }

  bridge.start(start, (message) => { adapter.onmessage?.({ data: message } as MessageEvent<FromWorker>) })
    .then((id) => {
      childId = id
      if (killedBeforeStarted) { bridge.kill(id); return }
      for (const message of queued) bridge.send(id, message)
      queued = []
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      adapter.onmessage?.({ data: { type: 'failed', error: { name: 'Error', message, code: 'ENOEXEC' } } } as MessageEvent<FromWorker>)
    })

  return adapter
}
