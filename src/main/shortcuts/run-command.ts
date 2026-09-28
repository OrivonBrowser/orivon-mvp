// What each command does to the window it was pressed in. The shell already
// has a method for nearly all of them; this maps a command to that method.
import type { BookmarkStore } from '../browsing/bookmarks.js'
import { SHELL_EVENT_CHANNEL } from '../channels.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { moveToNewWindow } from '../shell/tab-move.js'
import { cascadeFrom } from '../shell/window-options.js'
import type { ShellWindowOptions } from '../shell/window-options.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { DevToolsService } from '../devtools/devtools-service.js'
import type { ProfilesService } from '../launch/profiles-service.js'
import type { ZoomService } from '../zoom/zoom-service.js'
import type { CommandId } from './commands.js'

export interface CommandDeps {
  readonly bookmarks: BookmarkStore
  readonly zoom: ZoomService
  readonly devtools: DevToolsService
  readonly profiles: ProfilesService
  readonly openWindow: (options?: ShellWindowOptions) => void
  readonly quit: () => void
}

export function runCommand (id: CommandId, target: ShellWindow, deps: CommandDeps): void {
  const { tabs, window, chrome } = target
  const { tabs: order, activeTabId } = tabs.getState()
  const active = order.find((tab) => tab.id === activeTabId)
  const goTo = (index: number): void => {
    const tab = order[index]
    if (tab !== undefined) tabs.activateTab(tab.id)
  }
  const activeIndex = order.findIndex((tab) => tab.id === activeTabId)

  switch (id) {
    case 'tab.new': tabs.createTab(); return
    case 'tab.close': if (active !== undefined) tabs.closeTab(active.id); return
    case 'tab.next': if (order.length > 0) goTo((activeIndex + 1) % order.length); return
    case 'tab.previous': if (order.length > 0) goTo((activeIndex - 1 + order.length) % order.length); return
    case 'tab.goto1': goTo(0); return
    case 'tab.goto2': goTo(1); return
    case 'tab.goto3': goTo(2); return
    case 'tab.goto4': goTo(3); return
    case 'tab.goto5': goTo(4); return
    case 'tab.goto6': goTo(5); return
    case 'tab.goto7': goTo(6); return
    case 'tab.goto8': goTo(7); return
    case 'tab.gotoLast': goTo(order.length - 1); return
    case 'nav.back': if (active !== undefined) tabs.back(active.id); return
    case 'nav.forward': if (active !== undefined) tabs.forward(active.id); return
    case 'nav.reload': if (active !== undefined) tabs.reload(active.id); return
    case 'nav.hardReload': tabs.activeWebContents()?.reloadIgnoringCache(); return
    case 'nav.focusAddress':
      chrome.webContents.focus()
      chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'focusAddress' })
      return
    case 'zoom.in': case 'zoom.out': case 'zoom.reset': {
      const origin = active === undefined ? null : originFromUrl(active.url)
      if (origin === null) return
      if (id === 'zoom.reset') deps.zoom.reset(origin)
      else deps.zoom.step(origin, id === 'zoom.in' ? 'in' : 'out')
      return
    }
    case 'history.open': tabs.openInternal('history'); return
    case 'devtools.toggle': deps.devtools.toggle(tabs.activeWebContents(), window); return
    case 'bookmark.toggle':
      // The same rule as the star in the toolbar: a page with a site, and no other.
      if (active === undefined || active.isNewTab || active.isInternal) return
      if (deps.bookmarks.has(active.url)) deps.bookmarks.remove(active.url)
      else deps.bookmarks.add({ url: active.url, title: active.title.length > 0 ? active.title : active.url, favicon: tabs.faviconFor(active.id) })
      return
    case 'window.new': deps.openWindow({ place: cascadeFrom(window.getBounds()) }); return
    case 'tab.moveLeft': case 'tab.moveRight': {
      if (active === undefined) return
      // A joined pair moves as one, from where it begins.
      const partnerAt = active.splitWith === null ? -1 : order.findIndex((tab) => tab.id === active.splitWith)
      const begins = partnerAt === -1 ? activeIndex : Math.min(activeIndex, partnerAt)
      tabs.moveTab(active.id, begins + (id === 'tab.moveRight' ? 1 : -1))
      return
    }
    case 'split.toggle': if (active !== undefined) tabs.splits.toggle(active.id); return
    case 'split.focusOther': if (active !== undefined) tabs.splits.focusOther(active.id); return
    case 'split.swap': if (active !== undefined) tabs.splits.swap(active.id); return
    case 'split.rotate': if (active !== undefined) tabs.splits.rotate(active.id); return
    case 'tab.moveToNewWindow':
      if (active !== undefined) moveToNewWindow(target, active.id, deps.openWindow, cascadeFrom(window.getBounds()))
      return
    case 'window.newPrivate': deps.profiles.openPrivate(); return
    case 'profiles.open': tabs.openInternal('profiles'); return
    case 'window.close': window.close(); return
    case 'window.fullscreen': window.setFullScreen(!window.isFullScreen()); return
    case 'settings.open': tabs.openInternal('settings'); return
    case 'app.quit': deps.quit(); return
  }
}
