// What each command does to the window it was pressed in. The shell already
// has a method for nearly all of them; this maps a command to that method.
import { SHELL_EVENT_CHANNEL } from '../channels.js'
import { findStep, openFind } from '../find/find-commands.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { closeOthers, closeToRight, duplicateTab, toggleMute, togglePin } from '../shell/tab-commands.js'
import { openBookmarkAllTabs, starCommand } from '../shell/bookmark-bubble/open-edit.js'
import { toggleBookmarksBar } from '../shell/bookmarks-bar/bar-visibility.js'
import { moveToNewWindow } from '../shell/tab-move.js'
import { goHome } from '../shell/home.js'
import { OMNIBOX_MODULE } from '../omnibox/omnibox-names.js'
import { sendChromeEvent } from '../shell/shell-events.js'
import { cascadeFrom } from '../shell/window-options.js'
import type { ShellWindowOptions } from '../shell/window-options.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { ShellServices } from '../shell/shell-services.js'
import { reopenClosed } from '../session-restore/reopen.js'
import { openCertificate } from '../auth/certificate-open.js'
import { openQr } from '../qr/qr-open.js'
import { copyLinkCommand, emailLinkCommand } from '../os/share-commands.js'
import { realShareDeps } from '../os/share-runner.js'
import { openShortcutSheet } from '../os/shortcut-open.js'
import { TAB_SEARCH_OVERLAY } from '../tab-search/tab-search-overlay.js'
import { dismissRestoreOffer } from '../startup/restore-offer.js'
import { kioskAllows } from '../window-state/kiosk.js'
import type { CommandId } from './commands.js'
import { pdfCommand, pipCommand, printCommand, saveCommand, screenshotCommand, viewSourceCommand } from '../page-tools/page-commands.js'
import { realDeps } from '../page-tools/real-deps.js'

/** A new dependency of a command is a `ShellServices` member, never a field here. */
export interface CommandDeps {
  readonly services: ShellServices
  readonly openWindow: (options?: ShellWindowOptions) => void
  /** The displays as they are now: a saved window's place is used only where one of them shows it. */
  readonly displays: () => ReadonlyArray<{ readonly bounds: { x: number, y: number, width: number, height: number } }>
  readonly quit: () => void
}

export function runCommand (id: CommandId, target: ShellWindow, deps: CommandDeps): void {
  const { tabs, window, chrome } = target
  const { services } = deps
  if (services.kiosk && !kioskAllows(id)) return
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
    case 'nav.home': goHome(tabs, services.settings, { newTab: false }); return
    case 'nav.stop': tabs.activeWebContents()?.stop(); return
    case 'nav.focusAddress':
      chrome.webContents.focus()
      chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'focusAddress' })
      return
    case 'nav.focusSearch':
      chrome.webContents.focus()
      sendChromeEvent(target, OMNIBOX_MODULE, { type: 'focusSearch' })
      return
    case 'zoom.in': case 'zoom.out': case 'zoom.reset': {
      const origin = active === undefined ? null : originFromUrl(active.url)
      if (origin === null) return
      if (id === 'zoom.reset') services.zoom.reset(origin)
      else services.zoom.step(origin, id === 'zoom.in' ? 'in' : 'out')
      return
    }
    case 'find.open': dismissRestoreOffer(target); openFind(target); return
    case 'find.next': dismissRestoreOffer(target); findStep(target, true); return
    case 'find.previous': dismissRestoreOffer(target); findStep(target, false); return
    case 'history.open': tabs.openInternal('history'); return
    case 'privacy.clearData': return
    case 'bookmarks.open': tabs.openInternal('bookmarks'); return
    case 'devtools.toggle': services.devtools.toggle(tabs.activeWebContents(), window); return
    case 'devtools.console': services.devtools.openConsole(tabs.activeWebContents(), window); return
    case 'tasks.open': tabs.openInternal('tasks'); return
    // Saves a page that is new and opens the bubble; on a saved page it only opens it, so the key never removes one.
    case 'bookmark.toggle': starCommand({ window: target, services }); return
    case 'bookmark.allTabs': openBookmarkAllTabs({ window: target, services }); return
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
    case 'tab.reopen': reopenClosed(target, deps); return
    case 'tab.moveToNewWindow':
      if (active !== undefined) moveToNewWindow(target, active.id, deps.openWindow, cascadeFrom(window.getBounds()))
      return
    case 'tab.duplicate': if (active !== undefined) duplicateTab(tabs, active.id); return
    case 'tab.pin': if (active !== undefined) togglePin(tabs, active.id); return
    case 'tab.mute': if (active !== undefined) toggleMute(tabs, active.id); return
    case 'tab.closeOthers': if (active !== undefined) closeOthers(tabs, active.id); return
    case 'tab.closeRight': if (active !== undefined) closeToRight(tabs, active.id); return
    case 'tab.search': target.overlays.toggle(TAB_SEARCH_OVERLAY); return
    case 'window.newPrivate': services.profiles.openPrivate(); return
    case 'profiles.open': tabs.openInternal('profiles'); return
    case 'downloads.open': tabs.openInternal('downloads'); return
    case 'window.close': window.close(); return
    case 'window.fullscreen': window.setFullScreen(!window.isFullScreen()); return
    case 'bookmarks.toggleBar': toggleBookmarksBar(services); return
    case 'window.alwaysOnTop': window.setAlwaysOnTop(!window.isAlwaysOnTop()); return
    case 'settings.open': tabs.openInternal('settings'); return
    case 'passwords.open': tabs.openInternal('settings', '/passwords'); return
    case 'siteSettings.open': tabs.openInternal('settings', '/sites'); return
    case 'about.open': tabs.openInternal('about'); return
    case 'extensions.open': tabs.openInternal('extensions'); return
    case 'import.open': tabs.openInternal('import'); return
    case 'app.quit': deps.quit(); return
    case 'page.print': void printCommand(target); return
    case 'page.pdf': void pdfCommand(target, realDeps); return
    case 'page.save': void saveCommand(target, realDeps); return
    case 'page.viewSource': void viewSourceCommand(target); return
    case 'share.copyLink': copyLinkCommand(target, realShareDeps); return
    case 'share.email': void emailLinkCommand(target, realShareDeps); return
    case 'site.certificate': openCertificate(target); return
    case 'site.shortcut': openShortcutSheet(target, services); return
    case 'page.screenshot': void screenshotCommand(target); return
    case 'page.qr': openQr(target); return
    case 'page.pip': void pipCommand(target); return
  }
}
