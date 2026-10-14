import { contextBridge, ipcRenderer } from 'electron'
import { NETWORKS_CHANGED_CHANNEL, NETWORKS_COMMAND_CHANNEL } from '../main/channels.js'
import type { NetworksCommand } from '../main/ipc/networks-ipc.js'
import type { NetworksView } from '../main/networks/networks-view.js'

// Loaded ONLY by the Available networks popup's own WebContentsView (src/main/networks/networks-panel.ts).
// This page never navigates anywhere else (no links, no address bar), but the check below still runs before exposing
// anything privileged -- the same defense-in-depth newtab.ts applies for a page that COULD navigate, kept here so this
// file is not the one preload in the codebase that trusts webPreferences.additionalArguments without checking
// location.href against it. src/main/ipc/networks-ipc.ts re-verifies the same thing from the authoritative
// main-process side, on every call; neither layer trusts the other.
const URL_PREFIX = '--orivon-networks-url='
const expectedUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX))?.slice(URL_PREFIX.length)

function isView (value: unknown): value is NetworksView {
  return typeof value === 'object' && value !== null && Array.isArray((value as { cards?: unknown }).cards)
}

if (expectedUrl !== undefined && location.href === expectedUrl) {
  contextBridge.exposeInMainWorld('orivonNetworks', {
    /** The cards as they are now; null when main did not answer with any. */
    view: async (): Promise<NetworksView | null> => {
      const result: unknown = await ipcRenderer.invoke(NETWORKS_COMMAND_CHANNEL, { type: 'view' } satisfies NetworksCommand)
      return isView(result) ? result : null
    },
    /** Moves one card's switch; false when it did not move. The new cards arrive through `onChange`. */
    setSwitch: async (id: string, on: boolean): Promise<boolean> => {
      const result: unknown = await ipcRenderer.invoke(NETWORKS_COMMAND_CHANNEL, { type: 'setSwitch', id, on } satisfies NetworksCommand)
      return result === true
    },
    /** Pushed by main on every change of a node and every two seconds for the figures, while the popup is open. */
    onChange: (listener: (view: NetworksView) => void): void => {
      ipcRenderer.on(NETWORKS_CHANGED_CHANNEL, (_event, view: unknown) => { if (isView(view)) listener(view) })
    },
    /** Escape in the page: asks main to close the popup and hand the keyboard back to the tab. */
    close: (): void => {
      void ipcRenderer.invoke(NETWORKS_COMMAND_CHANNEL, { type: 'close' } satisfies NetworksCommand)
    },
    /** Tells main how tall the rendered content is, so the popup sizes to it. Fire-and-forget: a popup that failed to resize is cosmetic, and must never break rendering the cards. */
    reportHeight: (height: number): void => {
      void ipcRenderer.invoke(NETWORKS_COMMAND_CHANNEL, { type: 'contentHeight', height } satisfies NetworksCommand)
    }
  })
}
// No else branch, unlike newtab.ts: this window is never anything BUT the networks popup (it has no bookmarks bar, no
// address bar, nothing for a user to navigate away with), so there is no second, unprivileged surface to fall back to.
