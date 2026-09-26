// The site-info popover's one door to the broker and loader -- mirrors
// ./permissions.ts's own `PermissionsController` (its header: "nothing
// bypasses PermissionsController") for the per-site surface, kept as a
// sibling rather than folded into that file so neither grows into a
// single god-object covering both the all-sites list and the per-site
// popover (code-guidelines.md Rule 2).

import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { SubsystemContext } from '../registry.js'
import { buildSiteInfo } from './site-info.js'
import type { SiteInfo } from './site-info.js'
import { turnOffCapability, turnOnCapability } from './site-switches.js'
import type { TurnOnResult } from './site-switches.js'
import { buildSiteTrust } from '../browsing/site-trust.js'
import type { SiteTrust } from '../browsing/site-trust.js'
import type { DeliveryLevel, PinCoverageEvidence } from '../../trust/delivery-ladder.js'
import type { ScoreLevel } from '../../trust/website-level.js'
import type { PinRecord } from '../../broker/policy/pin.js'
import type { NameEvidence } from '../verifier/name-evidence.js'

export interface SiteSummary {
  /** Whether the site has asked for at least one Orivon capability or
   * picked a file/folder -- what the toolbar key's visibility switches on. */
  readonly asked: boolean
  readonly warning: boolean
}

const EMPTY_SITE_INFO = (origin: string): SiteInfo => ({
  origin, displayOrigin: origin, claimedName: undefined, asked: false, capabilityRows: [], pickedPathRows: [], consentGranularity: 'all-or-nothing'
})

/** The loader-adjacent facts `../browsing/site-trust.js` needs but does not
 * read itself (its own header: pure, no `electron-serve.js` import) --
 * `isOriginServedFromCacheSync`/`pinCoverageFor` real implementations live
 * in `../../loader/electron/serve.js`; injected here, defaulted at the
 * real construction site (`../shell/window.ts`), so this controller stays
 * testable against a fake rather than a live Electron session. */
export interface SiteTrustSources {
  readonly isOriginServedFromCacheSync: (origin: string) => boolean
  readonly pinCoverageFor: (origin: string) => PinCoverageEvidence | undefined
  /** How a `.eth` name led to this origin's content; undefined for any other origin. */
  readonly nameEvidenceFor: (origin: string, pin: PinRecord | null, servedFromCache: boolean) => Promise<NameEvidence | undefined>
  /** A developer-only Website level override for this origin, or `undefined` (`../dev/score-levels.ts`). */
  readonly levelOverrideFor: (origin: string) => ScoreLevel | undefined
  /** The same, for the Delivery level. */
  readonly deliveryOverrideFor: (origin: string) => DeliveryLevel | undefined
}

export interface StorageDeclaration {
  readonly filesQuotaBytes: number | undefined
  readonly codeVersion: string | undefined
}

export interface SiteInfoController {
  siteSummaryFor: (url: string) => Promise<SiteSummary>
  siteInfoFor: (url: string) => Promise<SiteInfo>
  siteTrustFor: (url: string) => Promise<SiteTrust | null>
  /** What the manifest and the pin declare about storage -- the two facts
   * `../permissions/site-data-runner.js`'s disk measurements need but
   * cannot read themselves (that file stays broker/loader-free). `null`
   * for an unregistered origin: nothing here to declare. */
  storageDeclarationFor: (url: string) => Promise<StorageDeclaration | null>
  turnOn: (origin: string, capability: CapabilityKind, shownPatterns: readonly Pattern[]) => Promise<TurnOnResult>
  turnOff: (origin: string, capability: CapabilityKind) => Promise<void>
  revokePickedPath: (origin: string, pickId: string) => Promise<void>
}

export function createSiteInfoController (ctx: SubsystemContext, trustSources: SiteTrustSources): SiteInfoController {
  async function siteInfoFor (url: string): Promise<SiteInfo> {
    const origin = originFromUrl(url)
    // No canonical origin (about:, chrome://, a malformed url) -- nothing
    // to show, and no address for `broker` to look anything up under.
    if (origin === null) return EMPTY_SITE_INFO(url)
    const broker = ctx.broker
    if (broker === undefined || !broker.app.isRegisteredSync(origin)) return EMPTY_SITE_INFO(origin)
    try {
      const [manifest, grants, pickedPaths] = await Promise.all([
        broker.app.manifest(origin),
        broker.app.grants(origin),
        broker.app.pickedPaths(origin)
      ])
      return buildSiteInfo(origin, manifest, grants, pickedPaths, true, trustSources.levelOverrideFor(origin))
    } catch {
      // A registered origin whose manifest read transiently fails -- the
      // same "drop the row rather than throw into a renderer" stance
      // permissions.ts's own describeOrigin takes.
      return EMPTY_SITE_INFO(origin)
    }
  }

  return {
    async siteSummaryFor (url) {
      const info = await siteInfoFor(url)
      return { asked: info.asked, warning: info.capabilityRows.some((r) => r.warning) || info.pickedPathRows.some((r) => r.warning) }
    },

    siteInfoFor,

    async siteTrustFor (url) {
      const loader = ctx.loader
      const origin = originFromUrl(url)
      if (loader === undefined || origin === null) return null
      const [pin, published] = await Promise.all([loader.pinFor(origin), loader.ddocFor(origin)])
      const servedFromCache = trustSources.isOriginServedFromCacheSync(origin)
      const name = await trustSources.nameEvidenceFor(origin, pin, servedFromCache)
      return buildSiteTrust(
        origin, pin, servedFromCache, trustSources.pinCoverageFor(origin), published, Date.now(), name,
        trustSources.levelOverrideFor(origin), trustSources.deliveryOverrideFor(origin)
      )
    },

    async storageDeclarationFor (url) {
      const origin = originFromUrl(url)
      const broker = ctx.broker
      if (origin === null || broker === undefined || !broker.app.isRegisteredSync(origin)) return null
      let manifest
      try {
        manifest = await broker.app.manifest(origin)
      } catch {
        return null
      }
      const pin = ctx.loader === undefined ? null : await ctx.loader.pinFor(origin)
      return { filesQuotaBytes: manifest.capabilities.fs?.quotaBytes, codeVersion: pin?.version }
    },

    async turnOn (origin, capability, shownPatterns) {
      const broker = ctx.broker
      if (broker === undefined) return 'not-registered'
      return await turnOnCapability(broker, origin, capability, shownPatterns)
    },

    async turnOff (origin, capability) {
      const broker = ctx.broker
      if (broker === undefined) return
      await turnOffCapability(broker, origin, capability)
    },

    async revokePickedPath (origin, pickId) {
      const broker = ctx.broker
      if (broker === undefined) return
      await broker.revokeUserSelectedPath(origin, pickId)
    }
  }
}
