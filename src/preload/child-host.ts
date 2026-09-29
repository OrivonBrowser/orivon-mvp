// ADR-0046's own preload: runs only in the hidden child host
// (`src/main/children/child-host.ts`), never an app's own page. Builds the
// same `orivon` object an app tab's own preload builds for its main world
// (`surface/orivon.ts`'s `buildOrivonBridge`, through `installOrivon`), but
// keeps it in THIS isolated world: the host runs no page code at all, so
// there is nothing to expose it to, and `installOrivon`'s own `target`
// parameter already exists for a caller that is not the real `window`
// (its own header: "so a test never mutates the one shared global
// environment"). Hands it to `../shim/worker/host.ts`, durable, which
// relays every page's children over the ports main connects
// (`../main/children/registry.ts`'s `postPagePort`).

import { ipcRenderer } from 'electron'
import type { Orivon } from '../contracts/capability-api.js'
import { LIMITS } from '../contracts/index.js'
import { CHILD_HOST_PAGE_CHANNEL, CHILD_HOST_READY_CHANNEL } from '../main/channels.js'
import { installOrivon } from './surface/main-world-socket.js'
import { buildOrivonBridge } from './surface/orivon.js'
import { createChildHost } from '../shim/worker/host.js'

const WELL_KNOWN_PATH = '/.well-known/orivon/child-host'

/** `../main/children/child-host.ts`'s own document is the only thing this preload is ever
 * attached to (its `webPreferences.preload` is set nowhere else), but every other preload in
 * this directory still re-checks its own expected document before exposing anything
 * (README.md's own rule) -- this is that check for this one. */
function isChildHostDocument (): boolean {
  return location.pathname === WELL_KNOWN_PATH
}

// Electron's own sandboxed `process` has no `nextTick` (README.md's Design notes: what needs it
// here, and why patching it here rather than in the shim). Set before `host.js` starts a child.
if (typeof (process as unknown as { nextTick?: unknown }).nextTick !== 'function') {
  (process as unknown as { nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => void }).nextTick =
    (callback, ...args) => { queueMicrotask(() => { callback(...args) }) }
}

if (isChildHostDocument()) {
  const target: { orivon?: unknown } = {}
  installOrivon(buildOrivonBridge(), {
    readWindowBytes: LIMITS.readWindowBytes,
    writeWindowBytes: LIMITS.writeWindowBytes,
    inboundDatagramWindow: LIMITS.inboundDatagramWindow,
    outboundDatagramWindow: LIMITS.outboundDatagramWindow
  }, target)
  // installOrivon always sets this, whatever the app's own live grants are:
  // only an individual CALL through it can fail, never the install itself.
  const orivon = target.orivon as Orivon

  const host = createChildHost(orivon)
  ipcRenderer.on(CHILD_HOST_PAGE_CHANNEL, (event) => {
    const port = event.ports[0]
    if (port !== undefined) host.addPage(port)
  })
  // W2: told to `child-host.ts`'s own `build()`, which waits (bounded) for
  // this before ever handing a page a port -- everything above ran without
  // throwing, so this document really can relay children.
  ipcRenderer.send(CHILD_HOST_READY_CHANNEL)
}
