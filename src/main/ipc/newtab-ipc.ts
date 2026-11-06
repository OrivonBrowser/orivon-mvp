// The new-tab dashboard's IPC surface: read-only access to the bookmarks that are web addresses, what the page
// draws (its Featured choices, its picture and how bright it is, the update button), navigating the CALLING tab, and the update
// button's press -- nothing else. The dashboard replaces about:blank for a fresh tab.
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
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { Bookmark, BookmarkStore } from '../browsing/bookmarks.js'
import { NEWTAB_BACKGROUND_CHANGED_CHANNEL, NEWTAB_BRIGHTNESS_CHANGED_CHANNEL, NEWTAB_COMMAND_CHANNEL, NEWTAB_UPDATE_CHANGED_CHANNEL } from '../channels.js'
import type { BackgroundStore, PageBackground } from '../newtab/background-store.js'
import type { FeaturedState } from '../newtab/featured-state.js'
import type { FeaturedStore } from '../newtab/featured-store.js'
import type { NewTabUpdate, UpdatePill } from '../self-update/update-pill.js'
import type { WindowRegistry } from '../shell/window-registry.js'

/** The dashboard's grid holds no more than this many tiles. */
const DASHBOARD_TILES = 24

/** What the page needs of this profile's Featured choices to draw the row. */
export type FeaturedPrefs = Pick<FeaturedState, 'newcomerPin' | 'newcomerName' | 'unpinned' | 'hidden'>

export type NewTabCommand =
  | { type: 'getBookmarks' }
  | { type: 'getFeatured' }
  | { type: 'getBackground' }
  | { type: 'getBrightness' }
  | { type: 'getUpdate' }
  | { type: 'askUpdate' }
  | { type: 'hideFeatured'; id: string }
  | { type: 'unpinFeatured'; id: string }
  | { type: 'showHiddenFeatured' }
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
export function registerNewTabIpc (dashboardUrl: string, windows: WindowRegistry, bookmarks: BookmarkStore, featured: FeaturedStore, background: BackgroundStore, update: NewTabUpdate): void {
  // The dashboards that asked for the picture, its brightness or the update button, to be told when any changes (a page asks for all three).
  // A page that has left the dashboard is dropped.
  const following = new Set<WebContents>()
  const watched = new WeakSet<WebContents>()
  const follow = (contents: WebContents): void => {
    following.add(contents)
    if (watched.has(contents)) return
    watched.add(contents)
    contents.once('destroyed', () => { following.delete(contents) })
  }
  const tellFollowers = (channel: string): void => {
    // Called from inside a store's own notification: a page that is gone must not stop the rest, nor make the change throw.
    for (const contents of following) {
      try {
        if (contents.isDestroyed() || contents.mainFrame.url !== dashboardUrl) following.delete(contents)
        else contents.send(channel)
      } catch {
        following.delete(contents)
      }
    }
  }
  background.onChange(() => { tellFollowers(NEWTAB_BACKGROUND_CHANGED_CHANNEL) })
  background.onBrightnessChange(() => { tellFollowers(NEWTAB_BRIGHTNESS_CHANGED_CHANNEL) })
  update.onChange(() => { tellFollowers(NEWTAB_UPDATE_CHANGED_CHANNEL) })
  ipcMain.handle(
    NEWTAB_COMMAND_CHANNEL,
    async (event: IpcMainInvokeEvent, command: NewTabCommand): Promise<Bookmark[] | FeaturedPrefs | PageBackground | number | UpdatePill | null | undefined> => {
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
        case 'getBackground':
          follow(event.sender)
          return await background.current()
        case 'getBrightness':
          follow(event.sender)
          return background.brightness()
        case 'getUpdate':
          follow(event.sender)
          return update.shown()
        case 'askUpdate':
          // Asked in the window holding this tab, which a press has just put in use; what it asks about is main's own offer.
          update.ask()
          return undefined
        case 'getFeatured':
          return prefsOf(featured)
        case 'hideFeatured':
          if (typeof command.id === 'string') featured.hide(command.id)
          return prefsOf(featured)
        case 'unpinFeatured':
          if (typeof command.id === 'string') featured.unpin(command.id)
          return prefsOf(featured)
        case 'showHiddenFeatured':
          featured.showHidden()
          return prefsOf(featured)
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
