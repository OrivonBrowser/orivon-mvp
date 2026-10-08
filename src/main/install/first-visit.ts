// A published app's first visit (ADR-0074): the person is asked as soon as the manifest is read, the
// files are downloaded and checked against what the site declared before the page is entered, and a
// no opens the site as a plain website. No Electron: the tab's screens and its way into the app are
// the `SetupHost` the caller brings.

import { originFromUrl } from '../../broker/policy/origin.js'
import type { LoadInstalled, Loader } from '../../loader/index.js'
import { requestInstallConsent } from '../consent/install-consent.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from '../consent/install-consent.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { judgeBundle, visitKind } from './first-visit-decisions.js'
import { withOriginQueue } from './origin-queue.js'
import { revokeAllGrants } from './revoke-all-grants.js'

export interface FirstVisitDeps {
  readonly broker: Broker
  readonly loader: Pick<Loader, 'readManifest' | 'fetchForInstall' | 'installFetched' | 'pinFor'>
  readonly consent?: InstallConsentPrompt | undefined
  readonly perCapabilityConsent?: PerCapabilityConsentPrompt | undefined
}

/** What the tab's screen says: the person is being asked, or the files are being downloaded and checked. */
export interface SetupStage {
  readonly kind: 'asking' | 'verifying'
  readonly name: string
}

/** A sheet over the tab. `blocked` has no way forward; `download-failed` offers Try again. */
export type SetupSheet =
  | {
    readonly kind: 'blocked'
    readonly name: string
    readonly differing: readonly string[]
    readonly differingCount: number
    readonly rootMatches: boolean
    /** Set when the bundle was refused for being bad (a file missing or unacceptable) rather than for differing from the declaration. */
    readonly invalid?: string
  }
  | { readonly kind: 'download-failed', readonly name: string, readonly reason: string }

/** The tab a first visit happens in. */
export interface SetupHost {
  show: (stage: SetupStage) => void
  /** Resolves what the person chose; a sheet with no way forward resolves `leave`. */
  sheet: (sheet: SetupSheet) => Promise<'retry' | 'leave'>
  /** The files are in: the tab goes into the app. */
  enter: () => void
  /** The site opens as a plain website: not an app, or the person said no. */
  plain: () => void
  /** The visit ends with the tab showing neither: the screens are taken away. */
  end: () => void
}

export type FirstVisitResult =
  | { readonly outcome: 'entered', readonly installed: LoadInstalled }
  /** Another visit finished first: the origin is an app Orivon holds now, or the person said no there. The host was not used. */
  | { readonly outcome: 'known' | 'declined' }
  | { readonly outcome: 'plain', readonly why: 'website' | 'unread' | 'denied' }
  | { readonly outcome: 'blocked', readonly differing: readonly string[] }
  | { readonly outcome: 'failed', readonly reason: string }
  | { readonly outcome: 'left' }
  | { readonly outcome: 'rejected', readonly reason: string }

/**
 * Runs one first visit to `hintedUrl`, whose origin must be `hintingOrigin`. Never rejects. The grants
 * the person gave stay through a failed download and are all removed when the files differ from the
 * site's own declaration; nothing is pinned, registered or served before the files are let in.
 */
export async function runFirstVisit (deps: FirstVisitDeps, hintingOrigin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost): Promise<FirstVisitResult> {
  const origin = originFromUrl(hintedUrl)
  if (origin === null) return { outcome: 'rejected', reason: `hintedUrl is not a valid app origin: ${hintedUrl}` }
  if (hintingOrigin !== origin) return { outcome: 'rejected', reason: `a hint from ${hintingOrigin} may only install its own origin's app, not ${origin}` }

  for (;;) {
    const read = await deps.loader.readManifest(hintedUrl)
    if (read.kind === 'website') { host.plain(); return { outcome: 'plain', why: 'website' } }
    if (read.kind === 'unread') { host.plain(); return { outcome: 'plain', why: 'unread' } }
    const { name } = read.manifest

    host.show({ kind: 'asking', name })
    const answer = await requestInstallConsent(deps.broker, deps.consent, origin, read.manifest, deps.perCapabilityConsent, caller)
    if (answer === 'left') { host.end(); return { outcome: 'left' } }
    if (answer === 'declined') { host.plain(); return { outcome: 'plain', why: 'denied' } }

    host.show({ kind: 'verifying', name })
    const bundle = await deps.loader.fetchForInstall(read, hintedUrl)
    if (bundle.ok && caller !== undefined && !caller.stillOn(origin)) {
      await bundle.discard()
      host.end()
      return { outcome: 'left' }
    }

    let failure: string
    if (!bundle.ok && bundle.transient !== true) {
      // Retrying would fetch the same bad files: like files that differ from the declaration, never entered.
      await revokeAllGrants(deps.broker, origin).catch((error: unknown) => { console.error('[first-visit] grants of a blocked app remain', origin, error) })
      await host.sheet({ kind: 'blocked', name, differing: [], differingCount: 0, rootMatches: true, invalid: bundle.reason })
      host.end()
      return { outcome: 'blocked', differing: [] }
    } else if (!bundle.ok) {
      failure = bundle.reason
    } else {
      const judgement = judgeBundle(bundle.tree, bundle.declaration)
      if (judgement.kind === 'block') {
        await bundle.discard()
        await revokeAllGrants(deps.broker, origin).catch((error: unknown) => { console.error('[first-visit] grants of a blocked app remain', origin, error) })
        await host.sheet({ kind: 'blocked', name, differing: judgement.differing, differingCount: judgement.differingCount, rootMatches: judgement.rootMatches })
        host.end()
        return { outcome: 'blocked', differing: judgement.differing }
      }
      const installed = await deps.loader.installFetched(bundle.canonicalOrigin, bundle.manifest, bundle.tree, bundle.entries, bundle.declaration, bundle.content)
      if (installed.outcome === 'installed') {
        try {
          await deps.broker.registerApp(installed.canonicalOrigin, installed.manifest)
        } catch (error) {
          console.error('[first-visit] registerApp failed after a successful install; the bundle is installed but its version floor was not persisted', installed.canonicalOrigin, error)
        }
        host.enter()
        return { outcome: 'entered', installed }
      }
      await bundle.discard()
      failure = installed.reason
    }

    const choice = await host.sheet({ kind: 'download-failed', name, reason: failure })
    if (choice !== 'retry') { host.end(); return { outcome: 'failed', reason: failure } }
  }
}

/** What the tab's two ways in need of a first visit: whether an origin is one, and running it. */
export interface FirstVisit {
  kindOf: (origin: string) => Promise<'first' | 'declined' | 'known'>
  /** Serialised per origin, and judged again when its turn comes: two tabs on one origin ask once. */
  run: (origin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost) => Promise<FirstVisitResult>
}

export interface FirstVisitOptions {
  readonly deps: FirstVisitDeps
  /** True for an origin the first visit never applies to: a local file, a loopback or developer origin, anything not https. */
  readonly untouched: (origin: string) => boolean
  /** The origin is served from Orivon's own copy of an app. */
  readonly servedFromCache: (origin: string) => boolean
}

export function createFirstVisit (options: FirstVisitOptions): FirstVisit {
  const { deps } = options

  async function kindOf (origin: string): Promise<'first' | 'declined' | 'known'> {
    if (options.untouched(origin) || deps.broker.app.isRegisteredSync(origin) || options.servedFromCache(origin)) return 'known'
    return visitKind({
      registered: false,
      pinned: await deps.loader.pinFor(origin) !== null,
      versionFloor: await deps.broker.versionFloorFor(origin),
      declined: await deps.broker.declinedCapabilitiesFor(origin) !== undefined,
      holdsGrants: deps.broker.app.hasGrantsSync(origin)
    })
  }

  async function run (origin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost): Promise<FirstVisitResult> {
    const canonical = originFromUrl(hintedUrl)
    if (canonical === null || canonical !== origin) return await runFirstVisit(deps, origin, hintedUrl, caller, host)
    return await withOriginQueue(origin, async () => {
      const kind = await kindOf(origin)
      if (kind !== 'first') return { outcome: kind }
      return await runFirstVisit(deps, origin, hintedUrl, caller, host)
    })
  }

  return { kindOf, run }
}
