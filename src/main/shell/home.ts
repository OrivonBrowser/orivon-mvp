// The Home page: what `home.url` names, and what the Home button and Alt+Home do with it.
import { parseOmniboxInput } from '../browsing/omnibox.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import type { SettingsStore } from '../settings/settings-store.js'
import type { TabManager } from './tabs.js'

/** The address `home.url` names, resolved as the address bar would resolve the same text ("example.com" is
 * https://example.com/); null when it is empty or names nothing the bar would load as an address. */
export function homeAddress (settings: Pick<SettingsStore, 'get'>): string | null {
  const parsed = parseOmniboxInput(settings.get('home.url'), isDevEthName)
  return parsed.kind === 'url' ? parsed.url : null
}

/** `newTab`: the home page goes to a new background tab, leaving this one. Otherwise it loads in the active
 * tab. With no home page set the new-tab page is opened, and a page already showing it stays: a loaded page is
 * never swapped for the dashboard, which would lose its history. */
export function goHome (tabs: Pick<TabManager, 'getState' | 'navigate' | 'createTab'>, settings: Pick<SettingsStore, 'get'>, { newTab }: { newTab: boolean }): void {
  const address = homeAddress(settings)
  const { tabs: order, activeTabId } = tabs.getState()
  const active = order.find((tab) => tab.id === activeTabId)
  if (newTab) {
    tabs.createTab(address ?? undefined, false)
  } else if (address !== null) {
    if (active === undefined) tabs.createTab(address)
    else tabs.navigate(active.id, address)
  } else if (active === undefined || !active.isNewTab) {
    tabs.createTab()
  }
}
