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
  const live = windows.filter((entry) => !entry.window.isDestroyed())
  const holds = (entry: TabWindow): boolean => entry.tabs.getState().tabs.some((tab) => entry.tabs.liveWebContents(tab.id) === request.tab)
  const ordered = [...live.filter(holds), ...live.filter((entry) => !holds(entry))]
  const offers: TabOffer[] = []
  for (const entry of ordered) {
    for (const tab of entry.tabs.getState().tabs) {
      const wc = entry.tabs.liveWebContents(tab.id)
      if (wc === undefined || wc.isDestroyed() || !isPickableTab(tab)) continue
      const self = wc === request.tab
      if (self && request.hints.selfBrowserSurface === 'exclude') continue
      offers.push({ wc, tab, self })
    }
  }
  return offers.sort((a, b) => Number(b.self) - Number(a.self))
}
