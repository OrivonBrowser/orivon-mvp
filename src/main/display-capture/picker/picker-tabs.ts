// The tabs the picker offers for a tab share: this process's live tabs in every window, in the order a person looks
// for them (the asking tab, then its window, then the rest). Pure over the windows' tab state.
import type { WebContents } from 'electron'
import type { TabState } from '../../shell/tab-types.js'
import type { DisplayRequest } from '../types.js'
import { isPickableTab } from './picker-model.js'

export interface TabWindow {
  readonly window: { isDestroyed: () => boolean }
  readonly tabs: {
    getState: () => { readonly tabs: readonly TabState[] }
    liveWebContents: (id: string) => WebContents | undefined
  }
}

export interface TabOffer {
  readonly wc: WebContents
  readonly tab: TabState
  /** The tab that asked. */
  readonly self: boolean
}

export function offeredTabs (windows: readonly TabWindow[], request: Pick<DisplayRequest, 'tab' | 'hints'>): TabOffer[] {
  const live = windows.filter((entry) => !entry.window.isDestroyed()).map((entry) => ({ entry, tabs: entry.tabs.getState().tabs }))
  const holds = ({ entry, tabs }: { entry: TabWindow, tabs: readonly TabState[] }): boolean => tabs.some((tab) => entry.tabs.liveWebContents(tab.id) === request.tab)
  const ordered = [...live.filter(holds), ...live.filter((window) => !holds(window))]
  const offers: TabOffer[] = []
  for (const { entry, tabs } of ordered) {
    for (const tab of tabs) {
      const wc = entry.tabs.liveWebContents(tab.id)
      if (wc === undefined || wc.isDestroyed() || !isPickableTab(tab)) continue
      const self = wc === request.tab
      if (self && request.hints.selfBrowserSurface === 'exclude') continue
      offers.push({ wc, tab, self })
    }
  }
  return offers.sort((a, b) => Number(b.self) - Number(a.self))
}
