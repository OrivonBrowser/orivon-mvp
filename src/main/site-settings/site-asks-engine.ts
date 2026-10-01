// The rules for a site that asks for the camera, a location or another
// permission: who may ask, what is remembered, when the person is asked, and
// what the page is told. Pure over its dependencies, so every rule is
// unit-tested without a window. `site-asker.ts` adapts it to the permission
// gate; `ask-site.ts` is the question the person sees.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { SiteRequest } from './electron-names.js'
import type { SiteKind, SiteValue } from './kinds.js'
import type { NavigatingTab, PageAccess } from './page-access.js'
import type { SiteDecision, SiteSettingsStore } from './site-settings-store.js'

/** What the person answered: `dismiss` is closing the question without choosing, and decides nothing. */
export type SiteAnswer = SiteDecision | 'dismiss'

/** The parts of a permission request the rules read. */
export interface RequestDetails {
  isMainFrame?: boolean | undefined
  requestingUrl?: string | undefined
  /** Set for `media`: the origin of the frame that asked. */
  securityOrigin?: string | undefined
}

/** The parts of a permission check the rules read. `embeddingOrigin` is set only for a cross-origin frame. */
export interface CheckDetails {
  isMainFrame?: boolean | undefined
  embeddingOrigin?: string | undefined
  /** Set for `media`: the origin of the frame the check is about, which is not always the page's own. */
  securityOrigin?: string | undefined
}

export interface SiteAsksDeps<T extends NavigatingTab & object> {
  store: Pick<SiteSettingsStore, 'get' | 'set'>
  /** What a site gets when it has no answer of its own: `block` refuses without asking. */
  defaultFor: (kind: SiteKind) => Exclude<SiteValue, 'allow'>
  /** An ordinary tab, as opposed to an embed, an extension's page or a shell view. */
  isTab: (contents: T) => boolean
  urlOf: (tab: T) => string
  /** A registered app's origin: its permissions are the manifest's, never a prompt's. */
  isApp: (origin: string) => boolean
  /** The tab is on screen in a window; a background tab's question would land over another page. */
  showing: (tab: T) => boolean
  ask: (kinds: readonly SiteKind[], tab: T, request: { sysex: boolean }) => Promise<SiteAnswer>
  access: PageAccess<T>
}

export interface SiteAsksEngine<T extends NavigatingTab & object> {
  /** The page's answer, or undefined when `contents` is not a tab (the gate's own rules then decide). */
  request: (request: SiteRequest, contents: T | null, details: RequestDetails) => Promise<boolean> | undefined
  /** True only for a stored allow on the tab's own site; undefined for a non-tab. Reads the store, never asks. */
  check: (kind: SiteKind | 'unknown', contents: T | null, requestingOrigin: string, details: CheckDetails) => boolean | undefined
}

/**
 * Kinds Orivon has no backing service for on every platform. An allow is remembered, so it applies the day a service
 * exists, but the page is told no: nothing here can promise that a system provider would not answer a `true`.
 */
const WITHOUT_SERVICE: ReadonlySet<SiteKind> = new Set<SiteKind>(['location'])

const reachable = (kinds: readonly SiteKind[]): boolean => !kinds.some((kind) => WITHOUT_SERVICE.has(kind))

const stateOf = (value: SiteDecision): 'allowed' | 'blocked' => value === 'allow' ? 'allowed' : 'blocked'

export function createSiteAsksEngine<T extends NavigatingTab & object> (deps: SiteAsksDeps<T>): SiteAsksEngine<T> {
  /** One question per tab and set of kinds at a time: a page that asks twice while the first is open shares its answer. */
  const pending = new WeakMap<T, Map<string, Promise<SiteAnswer>>>()

  function askOnce (tab: T, origin: string, kinds: readonly SiteKind[], sysex: boolean): Promise<SiteAnswer> {
    const key = `${origin} ${[...kinds].sort().join(',')}`
    let open = pending.get(tab)
    if (open === undefined) pending.set(tab, open = new Map())
    const existing = open.get(key)
    if (existing !== undefined) return existing
    const answer = deps.ask(kinds, tab, { sysex }).catch((): SiteAnswer => 'dismiss').finally(() => { open.delete(key) })
    open.set(key, answer)
    return answer
  }

  const tabOrigin = (tab: T): string | null => originFromUrl(deps.urlOf(tab))

  async function decide (request: SiteRequest, tab: T, details: RequestDetails): Promise<boolean> {
    const asked = details.securityOrigin ?? details.requestingUrl ?? ''
    const origin = originFromUrl(asked)
    // Only a website has an origin to remember an answer against; a shell page or an extension's page has none.
    if (origin === null || deps.isApp(origin)) return false
    if (tabOrigin(tab) !== origin) return false

    const stored = request.kinds.map((kind) => deps.store.get(origin, kind))
    // A frame never asks: the question would name the page's own site, and a frame is someone else's code.
    if (details.isMainFrame !== true) return reachable(request.kinds) && stored.every((value) => value === 'allow')

    request.kinds.forEach((kind, index) => {
      const value = stored[index]
      if (value !== undefined) deps.access.note(tab, origin, kind, stateOf(value))
    })
    if (stored.includes('block')) return false

    const undecided = request.kinds.filter((_, index) => stored[index] === undefined)
    if (undecided.length === 0) return reachable(request.kinds)
    for (const kind of undecided) {
      if (deps.defaultFor(kind) === 'block') {
        deps.access.note(tab, origin, kind, 'blocked')
        return false
      }
    }
    if (undecided.some((kind) => deps.access.wasDismissed(tab, origin, kind))) return false
    if (!deps.showing(tab)) return false

    const loads = deps.access.loads(tab, origin)
    const answer = await askOnce(tab, origin, undecided, request.sysex)
    // The page moved on while the question was open (another site, or the same one loaded again): the answer was
    // about a page that is no longer here, and decides nothing about this one.
    if (tabOrigin(tab) !== origin || deps.access.loads(tab, origin) !== loads) return false
    if (answer === 'dismiss') {
      deps.access.dismiss(tab, origin, undecided)
      return false
    }
    for (const kind of undecided) {
      deps.store.set(origin, kind, answer)
      deps.access.note(tab, origin, kind, stateOf(answer))
    }
    return answer === 'allow' && reachable(request.kinds)
  }

  return {
    request (request, contents, details) {
      if (contents === null || !deps.isTab(contents)) return undefined
      return decide(request, contents, details)
    },

    check (kind, contents, requestingOrigin, details) {
      if (contents === null || !deps.isTab(contents)) return undefined
      if (kind === 'unknown') return false
      const origin = originFromUrl(requestingOrigin)
      if (origin === null || deps.isApp(origin)) return false
      // A cross-origin frame names the page that embeds it: it never borrows that page's answer.
      if (details.embeddingOrigin !== undefined && originFromUrl(details.embeddingOrigin) !== origin) return false
      if (details.isMainFrame !== true && tabOrigin(contents) !== origin) return false
      // A media check describes the page's main document in `requestingOrigin`; the frame it is about is `securityOrigin`.
      if (details.securityOrigin !== undefined && originFromUrl(details.securityOrigin) !== origin) return false
      if (deps.store.get(origin, kind) !== 'allow') return false
      if (!reachable([kind])) return false
      // Chromium does not always make a request once a check passes, so the page's chip learns of the allowance here.
      if (details.isMainFrame === true && tabOrigin(contents) === origin) deps.access.note(contents, origin, kind, 'allowed')
      return true
    }
  }
}
