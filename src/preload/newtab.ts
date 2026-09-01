import { contextBridge, ipcRenderer } from 'electron'
import type { Bookmark } from '../main/bookmarks.js'
import { NEWTAB_COMMAND_CHANNEL } from '../main/channels.js'
import type { NewTabCommand } from '../main/newtab-ipc.js'

// Loaded ONLY for a genuinely fresh tab (src/main/tabs.ts's createTab(),
// `url === undefined`) -- the dashboard's own page (src/renderer/newtab/).
// Privileged in a narrow way (read-only bookmark access, navigate-this-
// tab-only) -- but unlike the chrome view, a dashboard TAB is an
// ordinary, navigable tab the user can leave freely, and preload cannot
// be un-set if that happens (it is fixed at WebContentsView creation).
//
// So this checks `location.href` against the EXPECTED dashboard URL --
// passed in at tab creation via `webPreferences.additionalArguments`,
// since the URL differs between dev and a built app and isn't a
// compile-time constant this file could just hardcode -- BEFORE
// exposing anything privileged. If this script runs again for whatever
// page the user navigated to instead, it exposes nothing beyond the
// same `{ version: 0 }` every ordinary tab already gets from
// preload/app.ts.
//
// This is one of TWO independent checks, not the only one:
// src/main/newtab-ipc.ts re-verifies the SAME thing, from the
// authoritative main-process side, on every single call. Neither layer
// trusts the other.
const ARG_PREFIX = '--orivon-newtab-url='
const expectedUrl = process.argv.find((arg) => arg.startsWith(ARG_PREFIX))?.slice(ARG_PREFIX.length)

if (expectedUrl !== undefined && location.href === expectedUrl) {
  function send (command: NewTabCommand): void {
    void ipcRenderer.invoke(NEWTAB_COMMAND_CHANNEL, command)
  }

  contextBridge.exposeInMainWorld('orivonNewTab', {
    getBookmarks: async (): Promise<Bookmark[]> => {
      const result: unknown = await ipcRenderer.invoke(NEWTAB_COMMAND_CHANNEL, { type: 'getBookmarks' })
      return Array.isArray(result) ? result as Bookmark[] : []
    },
    /** Navigates THIS tab -- used for both the search box and clicking a
     * bookmark tile. Reuses the same omnibox-parsing path the chrome
     * view's own address bar does (src/main/tabs.ts's navigate()), so a
     * typed query and an absolute bookmark URL are both handled
     * correctly by the one mechanism, not two. */
    navigate: (input: string): void => { send({ type: 'navigate', input }) }
  })
} else {
  contextBridge.exposeInMainWorld('orivon', { version: 0 })
}
