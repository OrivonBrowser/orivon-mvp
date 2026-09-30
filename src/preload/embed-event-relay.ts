import { contextBridge, ipcRenderer } from 'electron'
import { EMBED_EVENT_CHANNEL } from '../main/channels.js'

// Turns a notice from the shell (src/main/embed/embed-host.ts: a shown page
// asked for a window or started a download, ADR-0047) into a bubbling
// `orivon-popup` or `orivon-download` event on the `<webview>` element that
// shows the page. Only the shell can reach the listener: a page's own script
// has no way to send on an `ipcRenderer` channel.

const EVENT_NAMES: ReadonlySet<unknown> = new Set(['orivon-popup', 'orivon-download'])

/**
 * Runs in the page's MAIN world, where the `<webview>` methods live and where
 * the app's listeners read `event.detail`: an object built here in the
 * isolated world would be unreadable there. `executeInMainWorld` copies the
 * arguments across, so `detail` arrives as an ordinary main-world object.
 * Written self-contained because only the function's source crosses.
 */
function dispatchInMainWorld (guestId: number, name: string, detail: unknown): void {
  const find = (root: ParentNode): Element | null => {
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.localName === 'webview') {
        try {
          if ((element as unknown as { getWebContentsId: () => number }).getWebContentsId() === guestId) return element
        } catch {
          // Not attached yet: it cannot be the page a notice is about.
        }
      }
      if (element.shadowRoot !== null) {
        const inner = find(element.shadowRoot)
        if (inner !== null) return inner
      }
    }
    return null
  }
  find(document)?.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
}

/** Listens for the shell's notices; a notice no `<webview>` in this page matches is dropped. */
export function installEmbedEventRelay (): void {
  ipcRenderer.on(EMBED_EVENT_CHANNEL, (_event, guestId: unknown, name: unknown, detail: unknown) => {
    if (typeof guestId !== 'number' || !EVENT_NAMES.has(name) || typeof detail !== 'object' || detail === null) return
    contextBridge.executeInMainWorld({ func: dispatchInMainWorld, args: [guestId, name as string, detail] })
  })
}
