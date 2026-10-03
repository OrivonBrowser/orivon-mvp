// Which sites have JavaScript, images or sound switched off, and the response
// header that switches scripts off. A page's setting is its top-level site's:
// a frame from another site follows the page it sits in. A registered app is
// never touched (its own policy and grants are its contract), and only
// `http(s)` pages have a setting at all. Pure: no `electron` import.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { SiteDecision, SiteSettingsStore } from './site-settings-store.js'

export type ContentKind = 'javascript' | 'images' | 'sound' | 'popups'

export interface ContentRulesDeps {
  readonly store: Pick<SiteSettingsStore, 'get'>
  /** What a site gets when it has no answer of its own. */
  readonly defaultFor: (kind: ContentKind) => SiteDecision
  /** A registered app's origin: it holds grants or is served from the cache. */
  readonly isApp: (origin: string) => boolean
}

export interface ContentRules {
  /** The site's effective answer for `kind` on the page at `topUrl`, or undefined when the page has no setting (not `http(s)`, or an app). */
  valueFor: (kind: ContentKind, topUrl: string | undefined) => SiteDecision | undefined
  scriptsBlocked: (topUrl: string | undefined) => boolean
  imagesBlocked: (topUrl: string | undefined) => boolean
  soundBlocked: (topUrl: string | undefined) => boolean
}

const isWebAddress = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://')

export function createContentRules (deps: ContentRulesDeps): ContentRules {
  const valueFor = (kind: ContentKind, topUrl: string | undefined): SiteDecision | undefined => {
    if (topUrl === undefined || !isWebAddress(topUrl)) return undefined
    const origin = originFromUrl(topUrl)
    if (origin === null || deps.isApp(origin)) return undefined
    return deps.store.get(origin, kind) ?? deps.defaultFor(kind)
  }
  return {
    valueFor,
    scriptsBlocked: (topUrl) => valueFor('javascript', topUrl) === 'block',
    imagesBlocked: (topUrl) => valueFor('images', topUrl) === 'block',
    soundBlocked: (topUrl) => valueFor('sound', topUrl) === 'block'
  }
}

/** What Electron's request details offer, described structurally so a test needs no Electron. */
export interface RequestPageFacts {
  readonly frame?: { readonly parent?: unknown, readonly top?: { readonly url: string } | null } | null
  readonly referrer?: string
  readonly webContents?: { readonly getURL: () => string } | undefined
  /** Where the tab's top frame is going, or last went: its latest main-frame navigation, when one is known. */
  readonly navigating?: string | undefined
}

const originOf = (url: string | undefined): string | undefined => {
  try { return url === undefined ? undefined : new URL(url).origin } catch { return undefined }
}

/**
 * The page a request belongs to: the top frame's address, else the address that sent the request, else the
 * tab's. The first that is a website wins, because the tab's own address can still be the page it is leaving
 * while a navigation is under way. Every read can throw (a frame that navigated or died): that answer is "unknown".
 *
 * A request the top document sent is the exception: its referrer names that document, while the frame's
 * address can still be the page it is leaving for the first requests of a navigation. A request a stylesheet sent
 * carries the stylesheet's address instead, so the referrer is taken first only when it is the page the tab is
 * navigating to.
 */
export function requestPage (details: RequestPageFacts): string | undefined {
  const documentSent = (): boolean => details.navigating === undefined || originOf(details.referrer) === originOf(details.navigating)
  const reads: Array<() => string | undefined> = [
    () => details.frame?.parent === null && documentSent() ? details.referrer : undefined,
    () => details.frame?.top?.url,
    () => details.referrer,
    () => details.webContents?.getURL()
  ]
  for (const read of reads) {
    try {
      const url = read()
      if (url !== undefined && isWebAddress(url)) return url
    } catch {
      // A detached frame or a destroyed tab: try the next.
    }
  }
  return undefined
}

/** A second policy beside whatever the page sends: policies intersect, so this only ever removes what a script may do. Inline handlers and `javascript:` addresses are covered as well as script files. */
export const SCRIPT_BLOCK_POLICY = "script-src 'none'"

/** `headers` with the script block added as another policy. The input is not changed, and an existing policy header is kept (under whatever case it came in). */
export function withScriptBlock (headers: Readonly<Record<string, string[]>>): Record<string, string[]> {
  const existing = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy')
  if (existing === undefined) return { ...headers, 'Content-Security-Policy': [SCRIPT_BLOCK_POLICY] }
  return { ...headers, [existing]: [...(headers[existing] ?? []), SCRIPT_BLOCK_POLICY] }
}

/** A PDF is shown by the browser's own viewer, which a script block on the response would break. */
export function isPdf (headers: Readonly<Record<string, string[]>>): boolean {
  const name = Object.keys(headers).find((key) => key.toLowerCase() === 'content-type')
  return name !== undefined && (headers[name] ?? []).some((value) => value.trim().toLowerCase().startsWith('application/pdf'))
}
