import { contextBridge, ipcRenderer } from 'electron'
import { OVERLAY_COMMAND_CHANNEL, OVERLAY_EVENT_CHANNEL } from '../main/channels.js'

// Loaded ONLY by an overlay's own view (src/main/overlays/overlay-view.ts). The
// same defence as the toolbar popovers' preloads: nothing is exposed unless the
// document is at the address main gave it. src/main/overlays/overlay-ipc.ts
// re-verifies the sender on every call, and the host runs only the handler of
// the overlay this view was built for.
const URL_PREFIX = '--orivon-overlay-url='
const expectedUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX))?.slice(URL_PREFIX.length)

if (expectedUrl !== undefined && location.href === expectedUrl) {
  const invoke = async (message: unknown): Promise<unknown> => await ipcRenderer.invoke(OVERLAY_COMMAND_CHANNEL, message)
  contextBridge.exposeInMainWorld('orivonOverlay', {
    name: new URL(expectedUrl).searchParams.get('overlay') ?? '',
    platform: process.platform,
    /** Answers with the show result waiting for this page, if one is. */
    ready: async (): Promise<unknown> => await invoke({ type: 'ready' }),
    request: async (command: unknown): Promise<unknown> => await invoke({ type: 'request', command }),
    /** Tells main how tall the content is, so the view sizes to it. */
    size: (height: number): void => { void invoke({ type: 'size', height }) },
    close: (reason: 'request' | 'escape'): void => { void invoke({ type: 'close', reason }) },
    /** Main's messages: `{ type: 'show', payload }` and `{ type: 'event', event }`. Returns the unsubscribe. */
    onEvent: (listener: (message: unknown) => void): (() => void) => {
      const handler = (_event: unknown, message: unknown): void => { listener(message) }
      ipcRenderer.on(OVERLAY_EVENT_CHANNEL, handler)
      return () => { ipcRenderer.removeListener(OVERLAY_EVENT_CHANNEL, handler) }
    }
  })
}
