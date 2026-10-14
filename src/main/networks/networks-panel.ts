// The Available networks popup, as an in-window panel hanging off the toolbar button of the same name. The
// `WebContentsView` lifecycle (sizing, click-away dismissal, content-height resizing) lives in
// ../permissions/popover-view.js, shared with the site-info popover; this file owns only the cards on top of it.

import type { BaseWindow, View, WebContents } from 'electron'
import { registerNetworksIpc } from '../ipc/networks-ipc.js'
import { createPopoverView } from '../permissions/popover-view.js'
import type { PopoverAnchor } from '../permissions/popover-view.js'
import { PANEL_POPOVER_BACKGROUND } from '../shell/theme-colors.js'
import type { NetworksSource } from './networks-source.js'

export type { PopoverAnchor as PanelAnchor } from '../permissions/popover-view.js'

export interface NetworksPanel {
  /** Pressing the button again while the popup is open closes it, the way every browser's own toolbar popup behaves. */
  toggle: (anchor: PopoverAnchor, pressedAt?: number) => void
  close: () => void
  isOpen: () => boolean
  restack: () => void
}

export function createNetworksPanel (
  win: BaseWindow,
  contentView: View,
  networks: Pick<NetworksSource, 'view' | 'setSwitch' | 'onChange'>,
  dirname: string,
  activeContents: () => WebContents | undefined
): NetworksPanel {
  const popover = createPopoverView(win, contentView, {
    dirname,
    entryPath: '/networks/',
    entry: 'networks',
    preloadRelPath: '../preload/networks.js',
    urlArgName: 'orivon-networks-url',
    align: 'right',
    // Four cards: shown whole, so only the window's own height makes the popup scroll.
    maxHeight: Number.POSITIVE_INFINITY,
    background: PANEL_POPOVER_BACKGROUND,
    activeContents,
    registerIpc: (webContents, url, onContentHeight) => registerNetworksIpc(webContents, url, networks, onContentHeight, () => { popover.close() })
  })

  return {
    toggle: (anchor, pressedAt) => { popover.toggle(anchor, [], undefined, pressedAt) },
    close: popover.close,
    isOpen: popover.isOpen,
    restack: popover.restack
  }
}
