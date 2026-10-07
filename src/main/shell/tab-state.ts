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
  return {
    id,
    url,
    displayUrl: BUILTIN_ADDRESSES.displayUrl(url),
    title: wc?.getTitle() ?? '',
    canGoBack: wc?.navigationHistory.canGoBack() ?? false,
    canGoForward: wc?.navigationHistory.canGoForward() ?? false,
    loading: wc?.isLoading() ?? false,
    // The shell's own page carries the shell's icon for it, whatever the page declares.
    favicon: record?.internalPage != null ? internalPageIcon(record.internalPage) : record?.favicon ?? null,
    isNewTab: url === BLANK_URL || (record?.isDashboardTab === true && url === env.dashboardUrl),
    splitWith: env.partnerOf(id),
    isInternal: record?.internalPage != null,
    connection: 'none',
    pinned: record?.pinned ?? false,
    muted: record?.muted ?? false,
    audible: false,
    crashed: record?.crashed ?? null,
    ...(record === undefined ? {} : signalState(record, wc))
  }
}
