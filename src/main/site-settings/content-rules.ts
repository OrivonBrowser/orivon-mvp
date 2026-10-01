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
