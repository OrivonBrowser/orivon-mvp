// A published app's first visit (ADR-0074): the person is asked as soon as the manifest is read, the files are
// downloaded and checked against what the site declared before the page is entered, and a Deny opens the site as a
// plain website. Nothing is granted, pinned or registered until the files are let in: what the person answered waits
// as a pending consent. No Electron: the tab's screens and its way into the app are the `SetupHost` the caller brings.

import { originFromUrl } from '../../broker/policy/origin.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { LoadInstalled, Loader } from '../../loader/index.js'
import { applyInstallConsent, askInstallConsent } from '../consent/install-consent-ask.js'
import type { InstallAsk } from '../consent/install-consent-ask.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from '../consent/install-consent.js'
import type { DialogCaller } from '../consent/request-grant.js'
import type { DeclinedApps } from './declined-apps.js'
import { judgeBundle, visitKind } from './first-visit-decisions.js'
import { withOriginQueue } from './origin-queue.js'
import { revokeAllGrants } from './revoke-all-grants.js'

export interface FirstVisitDeps {
  readonly broker: Broker
  readonly loader: Pick<Loader, 'readManifest' | 'fetchForInstall' | 'installFetched' | 'pinFor'>
  readonly consent?: InstallConsentPrompt | undefined
  readonly perCapabilityConsent?: PerCapabilityConsentPrompt | undefined
  /** The origins whose question was answered Deny: written by a pressed Deny and by nothing else. */
  readonly declined: Pick<DeclinedApps, 'has' | 'add'>
}

/** What the tab's screen says: the person is being asked, or the files are being downloaded and checked. */
export interface SetupStage {
  readonly kind: 'asking' | 'verifying'
  readonly name: string
}

/**
 * A sheet over the tab. `blocked` has no way forward: the files differ from the declaration, or the verifier
 * proved them not what their address names (`invalid`). `download-failed` offers Try again. `too-large` has no
 * Try again either: no gateway makes the app smaller.
 */
export type SetupSheet =
  | {
    readonly kind: 'blocked'
    readonly name: string
    readonly differing: readonly string[]
    readonly differingCount: number
    readonly rootMatches: boolean
    /** The verifier's own reason, set when the files could not be verified rather than differing from a declaration. */
    readonly invalid?: string
  }
  | { readonly kind: 'download-failed', readonly name: string, readonly reason: string }
  | { readonly kind: 'too-large', readonly name: string }

/** The tab a first visit happens in. */
export interface SetupHost {
  /** The first stage may take the running page of an https app down, which is why it is awaited. */
  show: (stage: SetupStage) => void | Promise<void>
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

/** The longest the first look at an address waits to learn whether it is an app: a page that is no app, or a gateway that is slow, is let through as an ordinary page after this. */
export const MANIFEST_PROBE_MS = 10_000

/** What a question was asked about: a manifest that asks for more than the person was shown must be asked about again. */
function askedAbout (manifest: { readonly capabilities: unknown, readonly consentGranularity?: string }): string {
  return JSON.stringify([manifest.capabilities, manifest.consentGranularity])
}

/**
 * Runs one first visit to `hintedUrl`, whose origin must be `hintingOrigin`. Never rejects. `signal` aborts the
 * download when the tab closes or leaves. Nothing is granted before the files are let in, so a block has nothing
 * live to take back (grants an earlier version of Orivon left are revoked all the same); a failed download keeps
 * the answer for Try again; and the tab is entered only if it is still where the visit began.
 */
export async function runFirstVisit (deps: FirstVisitDeps, hintingOrigin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost, signal?: AbortSignal): Promise<FirstVisitResult> {
  const origin = originFromUrl(hintedUrl)
  if (origin === null) return { outcome: 'rejected', reason: `hintedUrl is not a valid app origin: ${hintedUrl}` }
  if (hintingOrigin !== origin) return { outcome: 'rejected', reason: `a hint from ${hintingOrigin} may only install its own origin's app, not ${origin}` }

  const gone = (): boolean => signal?.aborted === true || (caller !== undefined && !caller.stillOn(origin))
  const left = (): FirstVisitResult => { host.end(); return { outcome: 'left' } }
  let pending: { readonly ask: InstallAsk, readonly about: string, readonly name: string } | undefined
  let rechecked = false

  for (;;) {
    // Only the first look is bounded: it is the wait of a page that may turn out to be no app at all. Once the person has
    // answered, a slow read is the path to the files, not a reason to open the site unchecked.
    const read = await deps.loader.readManifest(hintedUrl, pending === undefined ? MANIFEST_PROBE_MS : undefined)
    if (gone()) return left()
    if (read.kind === 'website') { host.plain(); return { outcome: 'plain', why: 'website' } }
    if (read.kind === 'unread') {
      if (pending === undefined) { host.plain(); return { outcome: 'plain', why: 'unread' } }
      const choice = await host.sheet({ kind: 'download-failed', name: pending.name, reason: read.reason })
      if (choice !== 'retry') { host.end(); return { outcome: 'failed', reason: read.reason } }
      continue
    }
    const { name } = read.manifest

    const about = askedAbout(read.manifest)
    if (pending?.about !== about) {
      pending = undefined
      await host.show({ kind: 'asking', name })
      const ask = await askInstallConsent(deps.broker, deps.consent, origin, read.manifest, deps.perCapabilityConsent, caller)
      if (ask.outcome === 'left' || gone()) return left()
      if (ask.outcome === 'denied') {
        deps.declined.add(origin)
        host.plain()
        return { outcome: 'plain', why: 'denied' }
      }
      pending = { ask, about, name }
    }
    if (pending === undefined) return left()

    await host.show({ kind: 'verifying', name })
    const bundle = await deps.loader.fetchForInstall(read, hintedUrl, signal)
    if (gone()) {
      if (bundle.ok) await bundle.discard()
      return left()
    }

    const block = async (sheet: SetupSheet): Promise<FirstVisitResult> => {
      if (bundle.ok) await bundle.discard()
      pending = undefined
      await revokeAllGrants(deps.broker, origin).catch((error: unknown) => { console.error('[first-visit] grants of a blocked app remain', origin, error) })
      await host.sheet(sheet)
      host.end()
      return { outcome: 'blocked', differing: sheet.kind === 'blocked' ? sheet.differing : [] }
    }

    let failure: string
    if (!bundle.ok) {
      // Only a failed verification is the content being wrong; a size cap is plain news; every other failure is the path to the files.
      if (bundle.integrity === true) return await block({ kind: 'blocked', name, differing: [], differingCount: 0, rootMatches: true, invalid: bundle.reason })
      if (bundle.tooLarge === true) {
        await host.sheet({ kind: 'too-large', name })
        host.end()
        return { outcome: 'failed', reason: bundle.reason }
      }
      failure = bundle.reason
    } else {
      const judgement = judgeBundle(bundle.tree, bundle.declaration)
      // An https site may have been deployed while its files came down: look once more before calling it tampering.
      if (judgement.kind === 'block' && bundle.content === undefined && !rechecked) {
        rechecked = true
        await bundle.discard()
        continue
      }
      if (judgement.kind === 'block') return await block({ kind: 'blocked', name, differing: judgement.differing, differingCount: judgement.differingCount, rootMatches: judgement.rootMatches })

      const installed = await deps.loader.installFetched(bundle.canonicalOrigin, bundle.manifest, bundle.tree, bundle.entries, bundle.declaration, bundle.content)
      if (installed.outcome === 'installed' && installed.servingFailed !== true) {
        try {
          await deps.broker.registerApp(installed.canonicalOrigin, installed.manifest)
        } catch (error) {
          console.error('[first-visit] registerApp failed after a successful install; the bundle is installed but its version floor was not persisted', installed.canonicalOrigin, error)
        }
        await applyInstallConsent(deps.broker, origin, installed.manifest, pending.ask)
        // The person may have left while the files were being saved: installed, granted, but nobody is there to enter.
        if (gone()) return left()
        console.log(`[orivon] installed ${installed.canonicalOrigin}; entering the tab as the app`)
        host.enter()
        return { outcome: 'entered', installed }
      }
      await bundle.discard()
      failure = installed.outcome === 'rejected' ? installed.reason : 'the app could not be made ready to open'
    }

    const choice = await host.sheet({ kind: 'download-failed', name, reason: failure })
    if (choice !== 'retry') { host.end(); return { outcome: 'failed', reason: failure } }
  }
}

/** What the tab's two ways in need of a first visit: whether an origin is one, and running it. */
export interface FirstVisit {
  kindOf: (origin: string) => Promise<'first' | 'declined' | 'known'>
  /** Serialised per origin, and judged again when its turn comes: two tabs on one origin ask once. `signal` aborts the download. */
  run: (origin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost, signal?: AbortSignal) => Promise<FirstVisitResult>
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
      declined: deps.declined.has(origin)
    })
  }

  async function run (origin: string, hintedUrl: string, caller: DialogCaller | undefined, host: SetupHost, signal?: AbortSignal): Promise<FirstVisitResult> {
    const canonical = originFromUrl(hintedUrl)
    if (canonical === null || canonical !== origin) return await runFirstVisit(deps, origin, hintedUrl, caller, host, signal)
    return await withOriginQueue(origin, async () => {
      const kind = await kindOf(origin)
      if (kind !== 'first') return { outcome: kind }
      return await runFirstVisit(deps, origin, hintedUrl, caller, host, signal)
    })
  }

  return { kindOf, run }
}
