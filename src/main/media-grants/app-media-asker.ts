// The permission gate's answer for the camera and the microphone on a registered app's page (ADR-0032): the app's
// grant decides, asked at run time when the manifest declares the kind and none is held, and never a per-site
// prompt. It answers `undefined` for everything else, so a website, an embed and a request with no device type (a
// screen or tab capture, which the display gate owns) reach the askers and rules behind it. Pure over its
// dependencies.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { SiteAsker } from '../sessions/site-asks.js'
import type { AppMediaGrants, AppMediaKind } from '../display-capture/types.js'

export interface AppMediaAskerDeps {
  /** An ordinary tab, as opposed to an embed, an extension's page or a shell view. */
  isTab: (contents: WebContents) => boolean
  urlOf: (tab: WebContents) => string
  /** A registered app's origin, held grants or not: a declined install leaves an app with none. */
  isApp: (origin: string) => boolean
  /**
   * The person's stored or default block for the kind applies to this origin: true only where their site rules still
   * apply (a registered origin that holds no grant and is not served from the cache, which site settings show as a
   * website). It wins over the app's grant.
   */
  blocked: (origin: string, kind: AppMediaKind) => boolean
  grants: AppMediaGrants
}

interface Details {
  isMainFrame?: unknown
  securityOrigin?: unknown
  requestingUrl?: unknown
  embeddingOrigin?: unknown
  mediaTypes?: unknown
  mediaType?: unknown
}

const asDetails = (details: unknown): Details => (typeof details === 'object' && details !== null ? details : {}) as Details

/** The device kinds a request names, or undefined when it names none or a type that is not a device (a capture). */
function requestedKinds (types: unknown): AppMediaKind[] | undefined {
  if (!Array.isArray(types)) return undefined
  const kinds: AppMediaKind[] = []
  for (const type of types) {
    if (type === 'video') { if (!kinds.includes('media.camera')) kinds.push('media.camera') } else if (type === 'audio') { if (!kinds.includes('media.microphone')) kinds.push('media.microphone') } else return undefined
  }
  return kinds.length === 0 ? undefined : kinds
}

function checkedKind (type: unknown): AppMediaKind | undefined {
  return type === 'video' ? 'media.camera' : type === 'audio' ? 'media.microphone' : undefined
}

const asOrigin = (value: unknown): string | null => typeof value === 'string' ? originFromUrl(value) : null

export function createAppMediaAsker (deps: AppMediaAskerDeps): SiteAsker {
  const tabOrigin = (tab: WebContents): string | null => originFromUrl(deps.urlOf(tab))

  async function decide (tab: WebContents, origin: string, kinds: readonly AppMediaKind[], details: Details): Promise<boolean> {
    // A frame never asks: the page's own code is the only caller an app's grant is for.
    if (details.isMainFrame !== true) return false
    if (asOrigin(details.securityOrigin ?? details.requestingUrl) !== origin) return false
    // The person's block is read before any question is asked: a page wanting a blocked kind is asked about none.
    if (kinds.some((kind) => deps.blocked(origin, kind))) return false
    // One at a time, and none after a no: a page that wants both and is refused the first has its answer.
    for (const kind of kinds) {
      if (!await deps.grants.request(tab, origin, kind)) return false
      if (tabOrigin(tab) !== origin) return false
    }
    return true
  }

  return {
    name: 'app-media',
    request (contents, permission, details) {
      if (permission !== 'media') return undefined
      const given = asDetails(details)
      const kinds = requestedKinds(given.mediaTypes)
      if (kinds === undefined || !deps.isTab(contents)) return undefined
      const origin = tabOrigin(contents)
      if (origin === null || !deps.isApp(origin)) return undefined
      return decide(contents, origin, kinds, given)
    },
    check (contents, permission, requestingOrigin, details) {
      if (permission !== 'media' || contents === null || !deps.isTab(contents)) return undefined
      const given = asDetails(details)
      const kind = checkedKind(given.mediaType)
      const origin = originFromUrl(requestingOrigin)
      if (origin === null || !deps.isApp(origin)) return undefined
      // A check about a capture or an unknown type is not this asker's; the site asker refuses it for an app.
      if (kind === undefined) return undefined
      if (given.isMainFrame !== true) return false
      if (given.embeddingOrigin !== undefined && asOrigin(given.embeddingOrigin) !== origin) return false
      if (given.securityOrigin !== undefined && asOrigin(given.securityOrigin) !== origin) return false
      if (tabOrigin(contents) !== origin) return false
      return !deps.blocked(origin, kind) && deps.grants.held(origin, kind)
    }
  }
}
