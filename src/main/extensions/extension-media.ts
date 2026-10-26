// The rules for an extension's own page that asks for the camera or the
// microphone: which requests they own, what is remembered per extension, when
// the person is asked, and what the page is told. Pure over its dependencies,
// so every rule is unit-tested without a window. `extension-media-asker.ts`
// adapts it to the permission gate; the sheet the person sees is
// `permission-prompt-overlay.ts`.
import type { QueryState } from '../sessions/site-asks.js'
import { checkOf, requestOf } from '../site-settings/electron-names.js'
import type { SiteKind } from '../site-settings/kinds.js'
import type { ExtensionMediaAnswers, MediaAnswer } from './extension-prefs.js'
import type { NagLimit } from './permission-nag-limit.js'

export type MediaKind = 'camera' | 'microphone'

/** What the person did with the question: `dismiss` is closing it without choosing, and decides nothing. */
export type MediaChoice = MediaAnswer | 'dismiss'

export interface ExtensionMediaDeps<T extends object, P> {
  /** The extension is installed and enabled, so its origin is one this module speaks for. */
  isLoaded: (extensionId: string, contents: T | null) => boolean
  answers: (extensionId: string) => ExtensionMediaAnswers
  save: (extensionId: string, kind: MediaKind, answer: MediaAnswer) => void
  /** Settings' default for the kind is block: an undecided kind is refused without asking. */
  blockedByDefault: (kind: MediaKind) => boolean
  /** Where the person would see a question for this page, or undefined when nowhere (an offscreen document, a hidden window). */
  placeOf: (contents: T) => P | undefined
  ask: (place: P, extensionId: string, kinds: readonly MediaKind[]) => Promise<MediaChoice>
  nag: NagLimit
}

export interface ExtensionMedia<T extends object> {
  /** The page's answer, or undefined when the request is not an extension page's device request (the gate's own rules then decide). */
  request: (contents: T, permission: string, details: unknown) => Promise<boolean> | undefined
  /** True only for a stored allow; undefined when the check is not about a loaded extension's device. Reads the store, never asks. */
  check: (contents: T | null, permission: string, requestingOrigin: string, details: unknown) => boolean | undefined
  /**
   * What the page's top frame reads from `navigator.permissions.query` for the web name `permission`: the answer a
   * request from it would get, and `prompt` where a request would ask. Reads, never asks. Undefined for a name an
   * extension page is never asked about and for a page that is not a loaded extension's.
   */
  query: (contents: T, permission: string, frameOrigin: string) => QueryState | undefined
}

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([^/]+)/

const isMediaKind = (kind: SiteKind): kind is MediaKind => kind === 'camera' || kind === 'microphone'

/** The names `navigator.permissions.query` takes for the two devices an extension page is asked about. */
const queryKindOf = (name: string): MediaKind | undefined => name === 'camera' || name === 'microphone' ? name : undefined

const idOf = (url: unknown): string | undefined => typeof url === 'string' ? EXTENSION_ORIGIN.exec(url)?.[1] : undefined

function field (details: unknown, name: string): unknown {
  return typeof details === 'object' && details !== null ? (details as Record<string, unknown>)[name] : undefined
}

export function createExtensionMedia<T extends object, P> (deps: ExtensionMediaDeps<T, P>): ExtensionMedia<T> {
  /** One question per extension and set of kinds at a time: a page that asks twice while the first is open shares its answer. */
  const pending = new Map<string, Promise<MediaChoice>>()

  function askOnce (place: P, extensionId: string, kinds: readonly MediaKind[]): Promise<MediaChoice> {
    const key = `${extensionId} ${[...kinds].sort().join(',')}`
    const existing = pending.get(key)
    if (existing !== undefined) return existing
    const answer = deps.ask(place, extensionId, kinds).catch((): MediaChoice => 'dismiss').finally(() => { pending.delete(key) })
    pending.set(key, answer)
    return answer
  }

  async function decide (contents: T, extensionId: string, kinds: readonly MediaKind[]): Promise<boolean> {
    const stored = deps.answers(extensionId)
    if (kinds.some((kind) => stored[kind] === 'block')) return false
    const undecided = kinds.filter((kind) => stored[kind] === undefined)
    if (undecided.length === 0) return true
    if (undecided.some((kind) => deps.blockedByDefault(kind))) return false
    // A page nobody can see could time a question the person never meets: it gets a stored answer or nothing.
    const place = deps.placeOf(contents)
    if (place === undefined || deps.nag.suspended(extensionId)) return false

    const choice = await askOnce(place, extensionId, undecided)
    // The extension was removed or turned off while the question was open: the answer was about something that is gone.
    if (!deps.isLoaded(extensionId, contents)) return false
    if (choice === 'dismiss') {
      deps.nag.denied(extensionId)
      return false
    }
    // Stored once by whichever request asked: a request that shared the question finds it already there.
    for (const kind of undecided) if (deps.answers(extensionId)[kind] === undefined) deps.save(extensionId, kind, choice)
    if (choice === 'allow') deps.nag.allowed(extensionId)
    return choice === 'allow'
  }

  return {
    request (contents, permission, details) {
      if (permission !== 'media') return undefined
      const kinds = requestOf('media', details)?.kinds.filter(isMediaKind)
      const extensionId = idOf(field(details, 'securityOrigin'))
      if (kinds === undefined || kinds.length === 0 || extensionId === undefined || !deps.isLoaded(extensionId, contents)) return undefined
      // The page asking must be the extension's own top document: a frame is someone else's code, and a URL of another origin is not the page it claims.
      if (field(details, 'isMainFrame') !== true) return Promise.resolve(false)
      const url = field(details, 'requestingUrl')
      if (url !== undefined && idOf(url) !== extensionId) return Promise.resolve(false)
      return decide(contents, extensionId, kinds).catch((): boolean => false)
    },

    check (contents, permission, requestingOrigin, details) {
      if (permission !== 'media') return undefined
      const extensionId = idOf(field(details, 'securityOrigin') ?? requestingOrigin)
      if (extensionId === undefined || !deps.isLoaded(extensionId, contents)) return undefined
      // Measured: a check from an extension's own top page names the extension itself as `embeddingOrigin` (and omits
      // `securityOrigin`); a frame inside another page names that page, and never borrows the extension's answer.
      const embedding = field(details, 'embeddingOrigin')
      if (field(details, 'isMainFrame') !== true || (embedding !== undefined && idOf(embedding) !== extensionId)) return false
      if (idOf(requestingOrigin) !== extensionId) return false
      const kind = checkOf('media', details)
      return kind !== undefined && kind !== 'unknown' && isMediaKind(kind) && deps.answers(extensionId)[kind] === 'allow'
    },

    query (contents, permission, frameOrigin) {
      const kind = queryKindOf(permission)
      const extensionId = idOf(frameOrigin)
      if (kind === undefined || extensionId === undefined || !deps.isLoaded(extensionId, contents)) return undefined
      const stored = deps.answers(extensionId)[kind]
      if (stored !== undefined) return stored === 'allow' ? 'granted' : 'denied'
      // The steps `decide` takes before it asks. A page with no visible place is not one of them: its request is
      // refused for now and not for good, which is no answer of the person's.
      return deps.blockedByDefault(kind) || deps.nag.suspended(extensionId) ? 'denied' : 'prompt'
    }
  }
}
