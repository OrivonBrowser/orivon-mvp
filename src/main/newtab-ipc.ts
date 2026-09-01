// The new-tab dashboard's IPC surface: read-only bookmark access, and
// navigating the CALLING tab -- nothing else. Owner override, 2026-08-28
// (mvp-scope.md; the dashboard replaces about:blank for a fresh tab).
//
// A separate channel and a separate sender check from ipc.ts's
// registerShellIpc() on purpose. That check is object identity against
// the ONE known chrome webContents, which works because exactly one
// chrome view exists for the app's whole life. More than one dashboard
// tab can exist at once (open two new tabs), so there is no single
// webContents to compare against -- the frame's own URL is the
// strongest available check instead. It is re-verified on EVERY call,
// not just once at registration, because a dashboard tab is an
// ordinary, navigable tab: one that has since left the dashboard must
// fail this immediately, not keep whatever trust it had when the
// channel was first wired. src/preload/newtab.ts makes the same check,
// independently, before exposing anything at all -- neither layer
// trusts the other.
//
// Untested by design, matching ipc.ts (see update-check-runner.ts's own
// header for the stated reasoning): this file is Electron wiring with no
// decision logic pure enough to extract on its own terms
// (`isFromDashboard`'s signature is tied to `IpcMainInvokeEvent`, same as
// `ipc.ts`'s `isFromChrome`) -- adding a unit test here and not to its
// sibling would be an inconsistency, not a gap. `findTabIdByWebContents()`
// (tabs.ts) has no unit coverage of its own either, for the same reason
// (tabs.ts has no test file at all) -- both it and this file's own
// refusal path are exercised by scripts/smoke.mjs's dashboard scenario
// instead, against the real running app.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Bookmark, BookmarkStore } from './bookmarks.js'
import { NEWTAB_COMMAND_CHANNEL } from './channels.js'
import type { TabManager } from './tabs.js'

export type NewTabCommand =
  | { type: 'getBookmarks' }
  | { type: 'navigate'; input: string }

function isFromDashboard (event: IpcMainInvokeEvent, dashboardUrl: string): boolean {
  return event.senderFrame !== null && event.senderFrame.url === dashboardUrl
}

export function registerNewTabIpc (dashboardUrl: string, tabs: TabManager, bookmarks: BookmarkStore): void {
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
          // Resolved from the event's OWN sender, never a tab id the
          // page could simply claim -- a dashboard tab navigates
          // itself, nothing else.
          const id = tabs.findTabIdByWebContents(event.sender)
          if (id !== null) tabs.navigate(id, command.input)
          return undefined
        }
      }
    }
  )
}
