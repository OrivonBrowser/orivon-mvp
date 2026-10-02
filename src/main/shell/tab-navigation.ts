// Where a tab's page goes next: the address bar's and the dashboard's navigate,
// back, forward, reload, and asking a page to leave HTML fullscreen. Functions
// over the tab lookup TabManager gives them, so none of it holds tab state.
import type { WebContents } from 'electron'
import { parseOmniboxInput } from '../browsing/omnibox.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import { aliasToInternal, viewSourceTarget } from '../pages/internal-aliases.js'
import { parseInternalUrl } from '../pages/internal-pages.js'
import type { InternalPageId } from '../pages/internal-pages.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { BLANK_URL } from './tab-factory.js'
import { repartitionView } from './tab-parking.js'
import type { TabRecord } from './tab-types.js'
import { appTabFlagChanged, EXIT_FULLSCREEN_WORLD_ID, partitionChanged } from './tab-view.js'

export interface NavigationEnv {
  readonly record: (id: string) => TabRecord | undefined
  readonly liveWebContents: (id: string) => WebContents | undefined
  readonly openInternal: (page: InternalPageId, path: string) => void
  /** The source of an http(s) address in a tab beside the active one. False when none opened. */
  readonly viewSource: (url: string) => boolean
  /** A getter: the broker may still be undefined when the tab collection is made. */
  readonly broker: () => Broker | undefined
  readonly searchUrl: ((query: string) => string) | undefined
}

/** Asks a tab's page to leave HTML fullscreen. In an isolated world, where
 * the page's own script cannot replace `document.exitFullscreen` and so
 * keep the screen. */
export function exitHtmlFullscreen (env: NavigationEnv, id: string): void {
  void env.liveWebContents(id)
    ?.executeJavaScriptInIsolatedWorld(EXIT_FULLSCREEN_WORLD_ID, [{ code: 'document.exitFullscreen()' }])
    // Rejects when the page already left, which is the outcome wanted.
    .catch(() => {})
}

/** Where the omnibox and the dashboard's navigate command both land (ipc.ts, newtab-ipc.ts). Repartitions
 * via repartitionView() when the target's session, or its app-tab flag, differs (appTabFlagChanged).
 * BLANK_URL has no origin, so a rejected navigation never swaps: the tab keeps its preload. */
export function navigateTab (env: NavigationEnv, id: string, rawInput: string): void {
  const record = env.record(id)
  if (record === undefined || record.view.webContents.isDestroyed()) return
  // The address bar and the dashboard's search box are the person typing:
  // an address of one of the shell's own pages opens that page.
  const internal = aliasToInternal(rawInput) ?? parseInternalUrl(rawInput)
  if (internal !== null) {
    env.openInternal(internal.page, internal.path)
    return
  }
  // `view-source:` followed by anything but a web address is an ordinary search, as before.
  const source = viewSourceTarget(rawInput)
  if (source !== null && env.viewSource(source)) return
  const target = resolveTarget(env, rawInput)

  const swap = partitionChanged(target, record.partition)
  if (swap !== undefined || appTabFlagChanged(target, record.view, env.broker())) {
    // swap.to can itself be undefined (PartitionSwap's own doc) -- ??
    // would wrongly read that as "no swap" and keep the old partition.
    repartitionView(id, record, target, swap !== undefined ? swap.to : record.partition)
    return
  }

  void record.view.webContents.loadURL(target)
}

export function goBack (env: NavigationEnv, id: string): void {
  const history = env.liveWebContents(id)?.navigationHistory
  if (history?.canGoBack() === true) history.goBack()
}

export function goForward (env: NavigationEnv, id: string): void {
  const history = env.liveWebContents(id)?.navigationHistory
  if (history?.canGoForward() === true) history.goForward()
}

/** The address of the last committed entry: `getURL()` can already read a navigation that is still in flight. */
function committedUrl (wc: WebContents): string | undefined {
  const entry = wc.navigationHistory.getEntryAtIndex(wc.navigationHistory.getActiveIndex()) as { url: string } | null
  return entry?.url
}

/** Reload, or while a navigation has started and not committed, a restart of that navigation: `wc.reload()` would
 * drop it and reload the page before it. Only a web address restarts, through the address bar's own path, so a
 * scheme the page itself was refused never loads as if browser-initiated. */
export function reloadTab (env: NavigationEnv, id: string): void {
  const wc = env.liveWebContents(id)
  if (wc === undefined) return
  const pending = env.record(id)?.inflightUrl
  if (pending !== undefined && wc.isLoadingMainFrame() && /^https?:\/\//i.test(pending) && pending !== committedUrl(wc)) {
    navigateTab(env, id, pending)
    return
  }
  wc.reload()
}

/** Rejected omnibox input (a dangerous scheme, or empty) never reaches `loadURL` -- it falls back
 * to a plain blank page, never the dashboard (BLANK_URL's own doc), so a bad paste is visible and safe. */
function resolveTarget (env: NavigationEnv, rawInput: string): string {
  const result = parseOmniboxInput(rawInput, isDevEthName, env.searchUrl)
  if (result.kind === 'reject') return BLANK_URL
  return result.url
}
