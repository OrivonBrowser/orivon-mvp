// ADR-0046's page<->host handshake, app tabs only -- gated on the SAME
// `--orivon-app-tab` flag ./expose-shim-globals.ts reads (src/main/shell/
// tab-view.ts's `appTabArgsFor`): a page starting a child asks its own
// isolated-world preload for a connection, over `window.postMessage` rather
// than a new global, so `check:page-globals` sees nothing new. The port
// Electron hands back on `CHILD_HOST_PORT_CHANNEL` is already a real,
// web-standard `MessagePort` by the time `ipcRenderer.on` sees it -- Electron
// converts the main process's `MessagePortMain` at the IPC boundary -- so
// handing it straight to the main world is the ordinary way any `MessagePort`
// crosses, not the raw `MessagePortMain` this directory's own rule (README.md)
// keeps out: that rule is about the Electron-specific main-process class,
// which never exists in a renderer at all.

import { ipcRenderer } from 'electron'
import { CHILD_HOST_CONNECT_CHANNEL, CHILD_HOST_PORT_CHANNEL } from '../main/channels.js'

const APP_TAB_FLAG = '--orivon-app-tab'
const CONNECT_MESSAGE_TYPE = 'orivon:child-host:connect'
const PORT_MESSAGE_TYPE = 'orivon:child-host:port'

export function exposeChildHostConnect (): void {
  if (!process.argv.includes(APP_TAB_FLAG)) return

  // Only the page's OWN main world, never another frame or an extension
  // content script: `event.source === window` and the page's own origin.
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return
    const data = event.data as { type?: unknown } | null
    if (typeof data !== 'object' || data === null || data.type !== CONNECT_MESSAGE_TYPE) return
    ipcRenderer.send(CHILD_HOST_CONNECT_CHANNEL)
  })

  ipcRenderer.on(CHILD_HOST_PORT_CHANNEL, (event) => {
    const port = event.ports[0]
    if (port === undefined) return
    window.postMessage({ type: PORT_MESSAGE_TYPE }, location.origin, [port])
  })
}
