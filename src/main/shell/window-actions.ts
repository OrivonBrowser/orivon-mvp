// What the chrome's buttons and menus ask of their window beyond the tab
// collection: opening one popover closes the others, and a tab can be sent to
// another window. Assembled per window from the pieces window.ts made.
import { isolationKeyFromUrl, originFromUrl } from '../../broker/policy/origin.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import type { ShellActions } from '../ipc/ipc.js'
import { copyAddress } from '../os/address-clipboard-runner.js'
import { copyLinkCommand, copyWebLinkCommand, emailLinkCommand } from '../os/share-commands.js'
import { realShareDeps } from '../os/share-runner.js'
import { shareAddressFor, webLinkForTab } from '../os/share.js'
import type { NetworksPanel } from '../networks/networks-panel.js'
import type { SiteInfoPanel } from '../permissions/site-info-panel.js'
import { isRect } from './actions/overlay.js'
import { runChromeAction } from './chrome-actions.js'
import { createPressStamps } from './press-stamps.js'
import type { ShellServices } from './shell-services.js'
import { tabDragActions } from './tab-drag-actions.js'
import { addressOfFrontTab, openingAddressOf, tabForTunnelPopover } from './tunnel-popover-tab.js'
import { moveToNewWindow, moveToWindow } from './tab-move.js'
import { closeOthers, closeToRight, duplicateTab, newTabToRight, tabMenuFlags, toggleMute, togglePin } from './tab-commands.js'
import { sleepBackgroundTab } from '../memory-saver/sleep-command.js'
import { reloadOrWake } from '../memory-saver/sleep-tab.js'
import { showTabMenu, tabMenuTemplate } from './tab-menu.js'
import { groupLabel } from '../tab-groups/group-label.js'
import { groupsFor } from '../tab-groups/groups-model.js'
import { groupTab, groupTabNew, ungroupTab } from '../tab-groups/groups-runner.js'
import { cascadeFrom } from './window-options.js'
import type { ShellWindowOptions } from './window-options.js'
import type { Bounds } from './tab-types.js'
import type { ShellWindow } from './window-registry.js'

export interface WindowParts {
  readonly entry: ShellWindow
  readonly services: ShellServices
  /** Closes the overlay popups but not the two panels above, which a caller toggles itself. */
  readonly closeOverlays: () => void
  readonly panels: { readonly networks: NetworksPanel, readonly siteInfo: SiteInfoPanel }
  readonly openWindow: (options: ShellWindowOptions) => void
  /** How tall the top of the window (tab strip and toolbar) is: where another window's strip can be dropped on. */
  readonly topHeight: number
  /** The area the tabs' pages share, in window coordinates. */
  readonly area: () => Bounds
  /** Makes the chrome view taller while a tab is pressed, or gives it its own size back. */
  readonly reachChrome: (on: boolean) => void
}

function windowLabel (other: ShellWindow, position: number): string {
  const { tabs, activeTabId } = other.tabs.getState()
  const title = tabs.find((tab) => tab.id === activeTabId)?.title ?? ''
  return `Window ${String(position + 1)}: ${title === '' ? 'New Tab' : title}`
}

export function shellActions (parts: WindowParts): ShellActions {
  const { entry, services, panels, closeOverlays, openWindow, topHeight, area } = parts
  const { tabs, window } = entry
  const presses = createPressStamps()
  /** A press of the tunnel button that waits for its tab's keyboard (`TabManager.keyboard`). No list is drawn while it waits, so a second press of the button in that time is the same press again, not a close. */
  let waitingList: { readonly tabId: string, readonly cancel: (() => void) | undefined } | undefined
  const openingAddress = openingAddressOf(tabs)
  /** A popup opened on a tab whose first page has not committed keeps the keyboard when that page takes it as it commits. */
  const holdForArrival = (): void => {
    const state = tabs.getState()
    const front = state.tabs.find((tab) => tab.id === state.activeTabId)
    const contents = front?.url === '' ? tabs.liveWebContents(front.id) : undefined
    if (contents !== undefined) panels.siteInfo.holdAgainstArrival(contents)
  }
  const aboutTab = (): string | undefined => tabForTunnelPopover(tabs.getState(), (id) => tabs.partitionOf(id), isOriginServedFromCacheSync, openingAddress)

  const showTabMenuFor = (id: string): void => {
    const { tabs: all } = tabs.getState()
    const tab = all.find((candidate) => candidate.id === id)
    const flags = tabMenuFlags({ tabs: all }, id)
    if (tab === undefined || flags === undefined) return
    const others = services.windows.all().filter((other) => other !== entry && !other.window.isDestroyed())
    // A pinned tab is never in a split, on either side of it.
    const partners = tab.pinned ? [] : all.filter((other) => other.id !== id && other.splitWith === null && !other.pinned)
    const ctx = { window: entry, services }
    showTabMenu(window, tabMenuTemplate({
      ...flags,
      grouped: (tab.group ?? null) !== null,
      groups: groupsFor(tabs).list().filter((group) => group.id !== tab.group).map((group) => ({ label: groupLabel(group), join: () => { groupTab(ctx, id, group.id) } })),
      canSleep: id !== tabs.getState().activeTabId && tab.sleeping !== true,
      tabCount: all.length,
      canShare: shareAddressFor(tab) !== undefined,
      canCopyWebLink: webLinkForTab(tab) !== undefined,
      inSplit: tab.splitWith !== null,
      splitPartners: partners.map((other) => ({ label: other.title === '' ? 'New Tab' : other.title, split: () => { tabs.splits.split(id, other.id, 'right') } })),
      otherWindows: others.map((other, position) => ({ label: windowLabel(other, position), move: () => { moveToWindow(entry, id, other) } }))
    }, {
      newTabRight: () => { newTabToRight(tabs, id) },
      reload: () => { reloadOrWake(tabs, id) },
      duplicate: () => { duplicateTab(tabs, id) },
      togglePin: () => { togglePin(tabs, id) },
      toggleMute: () => { toggleMute(tabs, id) },
      newGroup: () => { groupTabNew(ctx, id) },
      ungroup: () => { ungroupTab(ctx, id) },
      sleep: () => { void sleepBackgroundTab(entry, id).catch((error: unknown) => { console.error('[shell] sleep background tab failed:', error) }) },
      copyLink: () => { void copyLinkCommand(entry, realShareDeps, id).catch((error: unknown) => { console.error('[shell] copy link command failed:', error) }) },
      copyWebLink: () => { void copyWebLinkCommand(entry, realShareDeps, id).catch((error: unknown) => { console.error('[shell] copy web link command failed:', error) }) },
      emailLink: () => { void emailLinkCommand(entry, realShareDeps, id).catch((error: unknown) => { console.error('[shell] email link command failed:', error) }) },
      moveToNewWindow: () => { moveToNewWindow(entry, id, openWindow, cascadeFrom(window.getBounds())) },
      separate: () => { tabs.splits.separate(id) },
      close: () => { tabs.closeTab(id) },
      closeOthers: () => { closeOthers(tabs, id) },
      closeRight: () => { closeToRight(tabs, id) },
      run: (command) => { services.commands.run(command, entry) }
    }))
  }

  return {
    openNetworks: (anchor) => {
      const pressedAt = presses.take('networks')
      panels.siteInfo.close() // only one popup open at a time
      closeOverlays()
      panels.networks.toggle(anchor, pressedAt)
    },
    openSiteInfo: (anchor, page, url) => {
      const pressedAt = presses.take(page)
      // The tunnel button of a new tab, and of a tab that carries a tunnel choice, is about the tab: no website has an origin to be about.
      const tabId = page === 'tunnels' ? aboutTab() : undefined
      if (tabId !== undefined) {
        if (waitingList?.tabId === tabId) return
        waitingList?.cancel?.()
        waitingList = undefined
        // A new tab's page takes the keyboard in its first moments and would close a list that is open by then, so the list opens once the tab's keyboard is placed.
        const cancel = tabs.keyboard.whenPlaced(tabId, () => {
          waitingList = undefined
          if (aboutTab() !== tabId) return
          panels.networks.close()
          closeOverlays()
          panels.siteInfo.toggleTab(anchor, tabId, pressedAt)
          holdForArrival()
        })
        if (cancel !== undefined) waitingList = { tabId, cancel }
        return
      }
      // A tab whose first page has not committed has no address to send: the button is about the one it is opening, as it is once the page has come.
      const address = url !== undefined && url !== '' ? url : page === 'tunnels' ? addressOfFrontTab(tabs.getState(), openingAddress) : undefined
      const origin = address === undefined ? undefined : isolationKeyFromUrl(address) ?? undefined
      if (origin === undefined) return // no canonical origin -- nothing this popup can show
      panels.networks.close()
      closeOverlays()
      panels.siteInfo.toggle(anchor, origin, page, pressedAt)
      if (page === 'tunnels') holdForArrival()
    },
    runCommand: (id) => { services.commands.run(id, entry) },
    act: (name, payload) => runChromeAction(name, payload, { window: entry, services, takePress: (button) => presses.take(button), copyAddress }),
    // The anchor comes from the chrome page: only a rectangle of numbers places a view.
    openMenu: (anchor) => {
      const pressedAt = presses.take('menu')
      if (isRect(anchor)) entry.overlays.toggle('menu', anchor, undefined, pressedAt)
    },
    press: (button) => { presses.note(button) },
    prewarmMenu: () => { entry.overlays.prewarm('menu') },
    ...tabDragActions(parts),
    showTabMenu: showTabMenuFor
  }
}
