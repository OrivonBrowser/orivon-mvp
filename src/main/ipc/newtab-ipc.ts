// The new-tab dashboard's IPC surface: read-only bookmark access, and
// navigating the CALLING tab -- nothing else. Owner override, 2026-08-28
// (scope.md; the dashboard replaces about:blank for a fresh tab).
//
// A separate channel and a separate sender check from ipc.ts's
// registerShellIpc() on purpose. That check compares against the ONE chrome
// webContents of its window (identity, then URL), registered on that view. More
// than one dashboard tab can exist at once, in any window, so there is no
// single webContents to compare against and the channel is process-wide --
// the frame's own URL is the strongest available check instead. It is re-verified on EVERY call,
// not just once at registration, because a dashboard tab is an
// ordinary, navigable tab: one that has since left the dashboard must
// fail this immediately, not keep whatever trust it had when the
// channel was first wired. src/preload/newtab.ts makes the same check,
// independently, before exposing anything at all -- neither layer
// trusts the other.
//
// Untested by design, matching ipc.ts: this file is Electron wiring with no
// decision logic pure enough to extract (`isFromDashboard`'s signature is
// tied to `IpcMainInvokeEvent`, same as `ipc.ts`'s `isFromChrome`).
// Exercised instead by scripts/smoke.mjs's dashboard scenario, against the
// real running app -- same as tabs.ts's findTabIdByWebContents(), which
// has no test file either.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Bookmark, BookmarkStore } from '../browsing/bookmarks.js'
import { NEWTAB_COMMAND_CHANNEL } from '../channels.js'
import type { WindowRegistry } from '../shell/window-registry.js'

export type NewTabCommand =
  | { type: 'getBookmarks' }
  | { type: 'navigate'; input: string }

function isFromDashboard (event: IpcMainInvokeEvent, dashboardUrl: string): boolean {
  return event.senderFrame !== null && event.senderFrame.url === dashboardUrl
}

/** Once per process: `ipcMain.handle` refuses a second registration of a channel. */
export function registerNewTabIpc (dashboardUrl: string, windows: WindowRegistry, bookmarks: BookmarkStore): void {
  ipcMain.handle(
    NEWTAB_COMMAND_CHANNEL,
    (event: IpcMainInvokeEvent, command: NewTabCommand): Bookmark[] | undefined => {
      if (!isFromDashboard(event, dashboardUrl)) {
        // Not the dashboard's own frame -- refuse silently, same
        // non-committal response ipc.ts's isFromChrome() gives, rather
        // than a thrown error that would confirm the channel exists.
        return undefined
      }

      switch (command.type) {
        case 'getBookmarks':
          return bookmarks.getAll()
        case 'navigate': {
          // Resolved from the event's OWN sender, in whichever window holds
          // it, never a tab id the page could simply claim -- a dashboard
          // tab navigates itself, nothing else.
          const found = windows.findTab(event.sender)
          if (found !== null) found.window.tabs.navigate(found.tabId, command.input)
          return undefined
        }
      }
    }
  )
}
