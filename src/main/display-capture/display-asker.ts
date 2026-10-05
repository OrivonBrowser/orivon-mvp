// The per-site asker that owns the `media` request with no device type: the one Electron raises for both
// `getDisplayMedia` and the legacy `getUserMedia({ chromeMediaSource })`. It grants only against a ticket (ADR-0055),
// and is registered before the site-permissions asker so the request never reaches the general rules.
import type { WebContents } from 'electron'
import type { SiteAsker } from '../sessions/site-asks.js'
import type { DisplayTickets } from './display-tickets.js'
import { mainFrameKey } from './frame-key.js'

export interface DisplayAskerDeps {
  tickets: Pick<DisplayTickets<unknown>, 'request' | 'awaitingDisplay' | 'void'>
  /** An ordinary tab or an app's tab, as opposed to an embed, an extension's page or a shell view. */
  isTab: (contents: WebContents) => boolean
  /** The origin the tab's top frame committed, or null when it has none. */
  mainFrameOrigin: (contents: WebContents) => string | null
  /** Whether the page may show the picker, from what is decided already: false where sharing is blocked. */
  mayAsk: (contents: WebContents, origin: string) => boolean
  endUnexpectedCapture: (contents: WebContents) => void
}

function field<T> (details: unknown, key: string, is: (value: unknown) => value is T): T | undefined {
  const value = typeof details === 'object' && details !== null ? (details as Record<string, unknown>)[key] : undefined
  return is(value) ? value : undefined
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isArray = (value: unknown): value is unknown[] => Array.isArray(value)

/** The request the asker owns: `media` that names no device. */
function isDisplayRequest (permission: string, details: unknown): boolean {
  return permission === 'media' && field(details, 'mediaTypes', isArray)?.length === 0
}

export function createDisplayAsker (deps: DisplayAskerDeps): SiteAsker {
  return {
    name: 'display-capture',

    request (contents, permission, details) {
      if (!isDisplayRequest(permission, details) || !deps.isTab(contents)) return undefined
      // An extension's tab capture names the captured tab as `contents` and its own origin as the requester: not ours.
      const origin = deps.mainFrameOrigin(contents)
      if (origin === null || field(details, 'securityOrigin', isString) !== origin) return undefined
      const key = mainFrameKey(contents)
      if (key === undefined || (details as { isMainFrame?: unknown }).isMainFrame !== true) return Promise.resolve(false)
      return deps.tickets.request(key)
    },

    check (contents, permission, requestingOrigin, details) {
      if (permission !== 'display-capture' || contents === null || !deps.isTab(contents)) return undefined
      const embedding = field(details, 'embeddingOrigin', isString)
      if ((details as { isMainFrame?: unknown } | null)?.isMainFrame !== true || embedding !== undefined) return false
      return deps.mainFrameOrigin(contents) === requestingOrigin && deps.mayAsk(contents, requestingOrigin)
    },

    afterGrant (contents, permission, details) {
      if (!isDisplayRequest(permission, details)) return
      const key = mainFrameKey(contents)
      if (key === undefined || !deps.tickets.awaitingDisplay(key)) return
      deps.tickets.void(key)
      deps.endUnexpectedCapture(contents)
    }
  }
}
