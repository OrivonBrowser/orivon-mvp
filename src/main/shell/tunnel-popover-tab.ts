// Which tab the tunnel button's popover is about, when it is about a tab and not a website (ADR-0101). Pure.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { TabsSnapshot } from './tab-types.js'

/**
 * The id of the tab in front when the tunnel button's popover is about the tab: a new tab, which shows no website to be about,
 * and a tab that carries a tunnel choice, whose every website the choice decides. An installed app keeps its own route whatever
 * the tab carries, so its page is still about the app; so is any page of a tab with no choice, and a page of the shell's own,
 * which has no button. `url` is the page the chrome says it shows.
 */
export function tabForTunnelPopover (state: TabsSnapshot, url: string | undefined, isApp: (origin: string) => boolean): string | undefined {
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)
  if (active === undefined || active.isInternal) return undefined
  if (active.isNewTab) return active.id
  if (active.tunnelChoice === undefined || url === undefined) return undefined
  const origin = originFromUrl(url)
  return origin !== null && isApp(origin) ? undefined : active.id
}
