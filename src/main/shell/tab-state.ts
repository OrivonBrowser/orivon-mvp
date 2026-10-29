// One tab's TabState, the record the chrome UI renders from -- read off the
// tab's record and live webContents at the moment state is pushed.
import type { WebContents } from 'electron'
import { internalPageIcon } from '../pages/internal-icons.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { BLANK_URL } from './tab-factory.js'
import { signalState } from './tab-signals.js'
import type { TabRecord, TabState } from './tab-types.js'

/** What a TabState reads that is not on the record or the page. */
export interface TabStateEnv {
  /** The dashboard's resolved URL, to tell a still-showing dashboard tab from one that navigated away. */
  readonly dashboardUrl: string
  /** The tab shown beside `id` in a split, or null. */
  readonly partnerOf: (id: string) => string | null
}

/** `record` and `wc` are undefined for a tab already gone or whose webContents is destroyed. */
export function buildTabState (id: string, record: TabRecord | undefined, wc: WebContents | undefined, env: TabStateEnv): TabState {
  const url = wc?.getURL() ?? ''
  const state: TabState = {
    id,
    url,
    displayUrl: BUILTIN_ADDRESSES.displayUrl(url),
    title: wc?.getTitle() ?? '',
    canGoBack: wc?.navigationHistory.canGoBack() ?? false,
    canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    loading: wc?.isLoading() ?? false,
    // The shell's own page carries the shell's icon for it, whatever the page declares.
    favicon: record?.internalPage != null ? internalPageIcon(record.internalPage) : record?.favicon ?? null,
    // The dashboard's tab is the new tab from the moment it exists: its page has no address until the dashboard commits, and the chrome draws the tab (and the tunnel button on it) before that.
    isNewTab: url === BLANK_URL || (record?.isDashboardTab === true && (url === '' || url === env.dashboardUrl)),
    splitWith: env.partnerOf(id),
    isInternal: record?.internalPage != null,
    connection: 'none',
    pinned: record?.pinned ?? false,
    muted: record?.muted ?? false,
    audible: false,
    crashed: record?.crashed ?? null,
    // Only the dashboard's tab is a new tab to the tunnel button: any other blank page may be a popup its opener writes into, in any session.
    ...(url === BLANK_URL && record?.isDashboardTab === false ? { blankPage: true } : {}),
    ...(record?.tunnelChoice === undefined ? {} : { tunnelChoice: record.tunnelChoice }),
    ...(record === undefined ? {} : signalState(record, wc))
  }
  // The pages the tab's view does not hold are still Back and Forward (tab-outer-history.ts).
  const outer = record?.outer
  if (outer === undefined) return state
  return { ...state, canGoBack: state.canGoBack || outer.back.length > 0, canGoForward: state.canGoForward || outer.forward.length > 0 }
}
