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
import { startNavigation } from './leave-page-prompt.js'
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

  const contents = record.view.webContents
  // A page that asks "Leave this page?" and is stayed on rejects the load as aborted: that is the answer, not a failure.
  startNavigation(contents, () => { void load(contents, target) })
}

async function load (contents: WebContents, target: string): Promise<void> {
  try {
    await contents.loadURL(target)
  } catch { /* aborted by the page's own question, or failed: either is shown by the tab itself */ }
}

export function goBack (env: NavigationEnv, id: string): void {
  const contents = env.liveWebContents(id)
  const history = contents?.navigationHistory
  if (contents !== undefined && history?.canGoBack() === true) startNavigation(contents, () => { history.goBack() })
}

export function goForward (env: NavigationEnv, id: string): void {
  const contents = env.liveWebContents(id)
  const history = contents?.navigationHistory
  if (contents !== undefined && history?.canGoForward() === true) startNavigation(contents, () => { history.goForward() })
}

export function reloadTab (env: NavigationEnv, id: string): void {
  const contents = env.liveWebContents(id)
  if (contents !== undefined) startNavigation(contents, () => { contents.reload() })
}

/** Rejected omnibox input (a dangerous scheme, or empty) never reaches `loadURL` -- it falls back
 * to a plain blank page, never the dashboard (BLANK_URL's own doc), so a bad paste is visible and safe. */
function resolveTarget (env: NavigationEnv, rawInput: string): string {
  const result = parseOmniboxInput(rawInput, isDevEthName, env.searchUrl)
  if (result.kind === 'reject') return BLANK_URL
  return result.url
}
