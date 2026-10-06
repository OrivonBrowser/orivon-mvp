// What a cold start opens, decided from plain values: the start-up choice, the pages list, the addresses on the
// command line and the previous session. Nothing here touches a window.
import { localFileKey } from '../../broker/policy/origin.js'
import { parseOmniboxInput } from '../browsing/omnibox.js'
import { MAX_LISTED_ADDRESSES } from '../settings/address-checks.js'
import type { SavedSession, SavedWindow } from '../session-restore/session-types.js'
import type { TabSnapshot } from '../session-restore/tab-snapshot.js'

export type StartupMode = 'newTab' | 'continue' | 'pages'

export interface StartupInput {
  readonly mode: StartupMode
  /** `startup.pages`: one address per line. */
  readonly pages: string
  /** The http(s) addresses the process was started with. */
  readonly argvUrls: readonly string[]
  readonly previous: SavedSession | null
  readonly isPrivate: boolean
}

export interface StartupPlan {
  readonly first: {
    /** Opened in order, behind. */
    readonly tabs: readonly TabSnapshot[]
    /** Opened after `tabs`, the first of them in front. */
    readonly urls: readonly string[]
    /** The window the tabs came from: its size, place and which tab was in front. */
    readonly saved?: SavedWindow
  }
  /** Windows opened after the first one exists. */
  readonly more: readonly SavedWindow[]
}

/** The addresses the list holds as the address bar would load them: a line that is not one, or repeats an earlier one, is skipped. */
export function parsePages (text: string): string[] {
  const pages: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const result = parseOmniboxInput(line)
    if (result.kind !== 'url' || pages.includes(result.url)) continue
    pages.push(result.url)
    if (pages.length === MAX_LISTED_ADDRESSES) break
  }
  return pages
}

/** A window worth reopening: one whose tabs survived being read again. */
export function usableWindows (previous: SavedSession | null): SavedWindow[] {
  return previous === null ? [] : previous.windows.filter((window) => window.tabs.length > 0)
}

export function planStartup (input: StartupInput): StartupPlan {
  const urls = input.argvUrls
  // A private session is a browser of its own: it neither restores the last session nor is restored.
  const mode = input.isPrivate ? 'newTab' : input.mode
  if (mode === 'pages') {
    return { first: { tabs: parsePages(input.pages).map((url) => ({ url, title: '', pinned: false })), urls }, more: [] }
  }
  const [saved, ...more] = mode === 'continue' ? usableWindows(input.previous) : []
  if (saved === undefined) return { first: { tabs: [], urls }, more: [] }
  return { first: { tabs: saved.tabs, urls, saved }, more }
}

/** Whether the plan puts a local file in a tab, so that the first window must wait for the binary's fuse to be read (`../local-files/file-fuse.ts`) before it opens it. */
export function planOpensLocalFile (plan: StartupPlan): boolean {
  const isFile = (url: string): boolean => localFileKey(url) !== null
  const windows = plan.first.saved === undefined ? [] : [plan.first.saved, ...plan.more]
  return plan.first.urls.some(isFile) || plan.first.tabs.some((tab) => isFile(tab.url)) || windows.some((window) => window.tabs.some((tab) => isFile(tab.url)))
}

/** After a crash the bar offers the session back, unless the start-up choice already brought it. */
export function shouldOfferRestore (mode: StartupMode, previous: SavedSession | null, isPrivate: boolean): boolean {
  return !isPrivate && mode !== 'continue' && previous?.clean === false && usableWindows(previous).length > 0
}
