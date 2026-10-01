// Which requests are third-party, for the "block third-party cookies" choice.
// A request is third-party when it is not the page's own navigation and its
// site differs from the top document's. The decision is made from the request's
// own facts, and is answered "first party" whenever the top document is not a
// web page or cannot be read: a request the browser cannot place is left alone
// rather than stripped, so an extension's or a worker's request is never
// broken by a guess. Pure: no `electron` import.
import { sameSite } from './site-of.js'

export interface RequestFacts {
  readonly resourceType: string
  readonly url: string
  /** The top document's address, or undefined when it is not known. */
  readonly topUrl: string | undefined
}

/** What Electron's request details offer, described structurally so a test needs no Electron. */
export interface RequestDetailsLike {
  readonly url: string
  readonly resourceType: string
  readonly frame?: { readonly top?: { readonly url: string } | null } | null
  readonly webContents?: { readonly getURL: () => string } | undefined
}

const isWebAddress = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://')

/** A WebSocket handshake carries cookies like a request does, and its response may set them. */
const isRequestAddress = (url: string): boolean => isWebAddress(url) || url.startsWith('ws://') || url.startsWith('wss://')

/**
 * The address of the page the request belongs to: the top frame's, else the
 * tab's own. Both reads can throw (a frame that navigated or died), and an
 * unreadable answer is "unknown".
 */
export function topUrlOf (details: RequestDetailsLike): string | undefined {
  try {
    const fromFrame = details.frame?.top?.url
    if (fromFrame !== undefined && fromFrame !== '') return fromFrame
  } catch {
    // A detached frame: fall back to the tab.
  }
  try {
    const fromTab = details.webContents?.getURL()
    if (fromTab !== undefined && fromTab !== '') return fromTab
  } catch {
    // A destroyed tab: unknown.
  }
  return undefined
}

export function isThirdParty (facts: RequestFacts): boolean {
  if (facts.resourceType === 'mainFrame') return false
  if (facts.topUrl === undefined || !isWebAddress(facts.topUrl) || !isRequestAddress(facts.url)) return false
  return !sameSite(facts.url, facts.topUrl)
}

export function requestIsThirdParty (details: RequestDetailsLike): boolean {
  return isThirdParty({ resourceType: details.resourceType, url: details.url, topUrl: topUrlOf(details) })
}

/** Request ids seen as third-party, so the response side strips the same requests even when its frame is gone. Oldest forgotten first. */
export interface ThirdPartyMemory {
  note: (id: number) => void
  has: (id: number) => boolean
  readonly size: () => number
}

export const THIRD_PARTY_MEMORY_LIMIT = 2000

export function createThirdPartyMemory (limit: number = THIRD_PARTY_MEMORY_LIMIT): ThirdPartyMemory {
  const ids = new Set<number>()
  return {
    note (id) {
      ids.delete(id)
      ids.add(id)
      if (ids.size > limit) {
        const oldest = ids.values().next()
        if (oldest.done !== true) ids.delete(oldest.value)
      }
    },
    has: (id) => ids.has(id),
    size: () => ids.size
  }
}
