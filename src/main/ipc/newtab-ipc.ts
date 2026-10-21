// The new-tab dashboard's IPC surface: read-only access to the bookmarks that are web addresses, and
// navigating the CALLING tab -- nothing else. The dashboard
// replaces about:blank for a fresh tab.
//
// A separate channel and a separate sender check from ipc.ts's
// registerShellIpc() on purpose. That check compares identity against the
// ONE chrome webContents of its window; more than one dashboard tab can
// exist at once, in any window, so there is no single webContents to
// compare against here. isFromDashboard() instead requires the sender
// frame to be its OWN webContents' top frame -- never an embedded
// subframe -- and at the dashboard's own URL, re-verified on EVERY call:
// a dashboard tab is an ordinary, navigable tab, and one that has since
// left the dashboard must fail this at once, not keep whatever trust it
// had when the channel was first wired. src/preload/newtab.ts makes the
// same check, independently, before exposing anything at all -- neither
// layer trusts the other.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { Bookmark, BookmarkStore } from '../browsing/bookmarks.js'
import { NEWTAB_COMMAND_CHANNEL } from '../channels.js'
import type { FeaturedState } from '../newtab/featured-state.js'
import type { FeaturedStore } from '../newtab/featured-store.js'
import { isComplete, startHereView, type StartHereFacts, type StartHereView } from '../newtab/start-here-state.js'
import type { YourApps, YourAppsAnswer } from '../newtab/your-apps.js'
import type { WindowRegistry } from '../shell/window-registry.js'

/** The dashboard's grid holds no more than this many tiles. */
const DASHBOARD_TILES = 24

/** What the page needs of this profile's Featured choices to draw the row. */
export type FeaturedPrefs = Pick<FeaturedState, 'newcomerPin' | 'newcomerName' | 'unpinned' | 'hidden'>

export type NewTabCommand =
  | { type: 'getBookmarks' }
  | { type: 'getFeatured' }
  | { type: 'getYourApps' }
  | { type: 'hideFeatured'; id: string }
  | { type: 'unpinFeatured'; id: string }
  | { type: 'showHiddenFeatured' }
  | { type: 'getStartHere' }
  | { type: 'dismissStartHere' }
  | { type: 'navigate'; input: string }

function prefsOf (featured: FeaturedStore): FeaturedPrefs {
  const { newcomerPin, newcomerName, unpinned, hidden } = featured.get()
  return { newcomerPin, newcomerName, unpinned, hidden }
}

function isFromDashboard (event: IpcMainInvokeEvent, dashboardUrl: string): boolean {
  return event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === dashboardUrl
}

/** Once per process: `ipcMain.handle` refuses a second registration of a channel. */
export function registerNewTabIpc (dashboardUrl: string, windows: WindowRegistry, bookmarks: BookmarkStore, featured: FeaturedStore, yourApps: Pick<YourApps, 'list'>, startFacts: () => Promise<StartHereFacts>): void {
  ipcMain.handle(
    NEWTAB_COMMAND_CHANNEL,
    async (event: IpcMainInvokeEvent, command: NewTabCommand): Promise<Bookmark[] | FeaturedPrefs | YourAppsAnswer | StartHereView | null | undefined> => {
      if (!isFromDashboard(event, dashboardUrl)) {
        // Not the dashboard's own frame -- refuse silently, same
        // non-committal response ipc.ts's isFromChrome() gives, rather
        // than a thrown error that would confirm the channel exists.
        return undefined
      }

      switch (command.type) {
        case 'getBookmarks':
          // The first tab of a launch asks before the file is read.
          await bookmarks.load()
          // A tile navigates its own tab, and a tab's navigation never opens a local file.
          return bookmarks.getAll().filter((bookmark) => !/^file:/i.test(bookmark.url)).slice(0, DASHBOARD_TILES)
        case 'getFeatured':
          return prefsOf(featured)
        case 'getYourApps':
          return await yourApps.list()
        case 'hideFeatured':
          if (typeof command.id === 'string') featured.hide(command.id)
          return prefsOf(featured)
        case 'unpinFeatured':
          if (typeof command.id === 'string') featured.unpin(command.id)
          return prefsOf(featured)
        case 'showHiddenFeatured':
          featured.showHidden()
          return prefsOf(featured)
        case 'getStartHere': {
          const facts = await startFacts()
          // A card whose every step is done leaves for good, even if a browser to import from turns up later.
          if (!facts.isPrivate && isComplete(featured.get().start, facts)) featured.closeStart()
          return startHereView(featured.get().start, facts)
        }
        case 'dismissStartHere':
          featured.closeStart()
          return null
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
