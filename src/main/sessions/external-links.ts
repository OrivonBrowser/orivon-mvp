// When a page may hand a link to another app on the computer. A page opening
// mailto:, magnet:, bitcoin: or any scheme the browser does not handle
// itself reaches the permission gate as `openExternal`; answering yes makes
// Electron pass the URL to the OS's default app for that scheme, so this
// never launches anything itself. The person is asked every time.
import { originFromUrl } from '../../broker/policy/origin.js'
import { tabPromptState, type PromptingTab } from './tab-prompts.js'

/** What the confirm dialog names. */
export interface ExternalLinkQuestion {
  readonly scheme: string
  readonly url: string
  /** The page asking, so the person can judge who wants this. */
  readonly origin: string
}

/**
 * Schemes never handed to the OS, whatever the person would answer. The
 * browser's own schemes, the ones that reach local files or run script, and
 * Chrome's list of OS handlers that must never be launched from a page,
 * plus `ms-msdt` and `search-ms`, the Windows handlers that turned one click
 * into code execution. Most cannot reach `openExternal` at all; this does
 * not rely on that.
 */
const NEVER_EXTERNAL: ReadonlySet<string> = new Set([
  'about', 'blob', 'chrome', 'chrome-extension', 'chrome-search', 'chrome-untrusted', 'data',
  'devtools', 'file', 'filesystem', 'http', 'https', 'javascript', 'view-source', 'ws', 'wss',
  'afp', 'disk', 'disks', 'hcp', 'ie.http', 'livescript', 'mhtml', 'mk', 'ms-help', 'msdaipp',
  'res', 'shell', 'vbscript', 'vnd.ms.radio',
  'ms-msdt', 'search-ms'
])

/** Every scheme this browser might ever serve itself starts with this. */
const INTERNAL_SCHEME_PREFIX = 'orivon'

/** The scheme to ask about, lower-cased and without its colon, or null for
 * one the person is never asked about. */
export function askableScheme (url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme = parsed.protocol.slice(0, -1)
  if (NEVER_EXTERNAL.has(scheme) || scheme.startsWith(INTERNAL_SCHEME_PREFIX)) return null
  return scheme
}

export interface ExternalLinkDeps<W> {
  /** The window the tab is on screen in, or undefined for a background tab. */
  windowShowing: (tab: PromptingTab) => W | undefined
  /** True only if the person chose to open it. */
  confirm: (window: W, question: ExternalLinkQuestion) => Promise<boolean>
}

/** The `openExternal` request handler's decision: true launches the URL. */
export function createExternalLinks<W> (deps: ExternalLinkDeps<W>) {
  return async function request (tab: PromptingTab, details: { externalURL?: string | undefined, requestingUrl?: string | undefined }): Promise<boolean> {
    const url = details.externalURL
    if (url === undefined) return false
    const scheme = askableScheme(url)
    const origin = originFromUrl(details.requestingUrl ?? '')
    if (scheme === null || origin === null) return false

    // Electron asks whether or not the page was clicked, so a page could
    // loop the question. After one ask, the next waits for the person to act
    // in the page, as Chrome does; one question per tab is ever open.
    const state = tabPromptState(tab)
    if (state.prompting || !state.touched) return false
    const window = deps.windowShowing(tab)
    if (window === undefined) return false

    state.prompting = true
    state.touched = false
    try {
      return await deps.confirm(window, { scheme, url, origin })
    } catch {
      return false
    } finally {
      state.prompting = false
    }
  }
}
