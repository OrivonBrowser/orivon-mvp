// When a page may hand a link to another app on the computer. A page opening
// mailto:, magnet:, bitcoin: or any scheme the browser does not handle
// itself reaches the permission gate as `openExternal`; answering yes makes
// Electron pass the URL to the OS's default app for that scheme, so this
// never launches anything itself. The person is asked every time. A
// `magnet:` link is additionally checked against its own strict grammar
// before it is even offered -- see `isWellFormedMagnetLink` below.
import { originFromUrl } from '../../broker/policy/origin.js'
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
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

/**
 * RFC 3986's `scheme` production, `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
 * `URL` already enforces this when it parses one -- `parsed.protocol` cannot
 * disagree -- but handing a string to the OS is sensitive enough a decision
 * to check its own assumption explicitly rather than inherit it silently.
 */
const SCHEME_GRAMMAR = /^[a-z][a-z0-9+.-]*$/

/**
 * BEP 0009's info-hash shapes: 40 hex characters (SHA-1, hex) or 32 base32
 * characters (SHA-1, base32) -- the only two `xt=urn:btih:` may carry.
 */
const BTIH_HEX = /^[0-9a-f]{40}$/i
const BTIH_BASE32 = /^[a-z2-7]{32}$/i

/**
 * Every magnet parameter this browser will pass on to the OS: BEP 0009's own
 * set (`xt`, `dn`, `tr`, `xl`, `kt`, `ws`, `as`, `xs`) plus `mt`/`so`, in wide
 * client use for a manifest torrent and a webtorrent-style source selection.
 * Not a registry of every parameter any client has ever invented -- a fixed
 * list all the same: one outside it is refused rather than passed through
 * unexamined.
 */
const KNOWN_MAGNET_PARAMS: ReadonlySet<string> = new Set(['xt', 'dn', 'tr', 'xl', 'kt', 'ws', 'as', 'xs', 'mt', 'so'])

/**
 * Whether a `magnet:` URL is well-formed enough to hand to the OS: no path
 * before its query, no parameter outside the known set, and exactly one
 * `xt=urn:btih:<hash>` with a hash BEP 0009 could have produced. T23's own
 * fix for protocol-handler argument injection -- refuse anything a strict
 * grammar does not recognise, rather than pass it on to whatever the OS
 * associates with the scheme.
 */
function isWellFormedMagnetLink (parsed: URL): boolean {
  if (parsed.pathname !== '') return false
  const params = new URLSearchParams(parsed.search)
  for (const name of params.keys()) {
    if (!KNOWN_MAGNET_PARAMS.has(name)) return false
  }
  const xt = params.getAll('xt')
  if (xt.length !== 1) return false
  const hash = /^urn:btih:(.+)$/i.exec(xt[0] ?? '')?.[1]
  return hash !== undefined && (BTIH_HEX.test(hash) || BTIH_BASE32.test(hash))
}

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
  if (!SCHEME_GRAMMAR.test(scheme)) return null
  // A protocol's address loads in the browser (../shell/tab-view.ts), never in whatever app claims the scheme.
  if (NEVER_EXTERNAL.has(scheme) || scheme.startsWith(INTERNAL_SCHEME_PREFIX) || BUILTIN_ADDRESSES.servesScheme(scheme)) return null
  if (scheme === 'magnet' && !isWellFormedMagnetLink(parsed)) return null
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
