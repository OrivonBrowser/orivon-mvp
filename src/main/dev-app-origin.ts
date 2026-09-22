// Developer mode's half of the discovery trigger: a loopback origin gets its
// capabilities GRANTED without being INSTALLED.
//
// Granting capabilities to a URL and installing an app are separate features
// (owner, 2026-09-17). `tab-view.ts`'s `appTabArgsFor` already reads only
// `broker.app.isRegisteredSync(origin)`, never a pin, so registration alone
// is what an app tab needs. This file supplies that registration for the one
// case `app-install.ts` structurally cannot serve: a developer's own
// `http://127.0.0.1:PORT`, which `install-origin.ts` refuses before consent
// is ever considered (it is not https, and not public unicast).
//
// NO BUNDLE IS FETCHED, HASHED, PINNED OR SERVED FROM CACHE. The page keeps
// being served by whatever server actually hosts it, which is the whole point:
// the app's host stays a plain static file server.
//
// A46 PERMITS THIS SHAPE AND BOUNDS IT. Its refusal is aimed at a
// PAGE-SUPPLIED hint naming a loopback origin on an ordinary user's machine.
// Here the eligible origin is the one the page was itself loaded from, the
// shell was started by `npm run dev`, and a person still answers the same
// consent prompt a real install shows. The provenance refinement A46
// describes -- proving the navigation was user-typed -- is NOT enforced yet.

import { parseManifest } from '../loader/manifest.js'
import { requestInstallConsent } from './install-consent.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from './install-consent.js'
import type { Broker } from '../broker/broker-contracts.js'
import { patternSetFromGrants, widensAuthority } from '../broker/policy/update.js'
import type { PatternSet } from '../broker/policy/update.js'
import { patternSetFromCapabilities } from '../broker/policy/manifest-patterns.js'
import type { CapabilityKind, Pattern } from '../contracts/index.js'

/** Loopback literals only. A hostname that merely RESOLVES to loopback is not eligible: that is resolver-dependent, and the whole point of a literal is that it cannot be moved by DNS. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1'])

/**
 * orivon-ports' own convention for a fake name over one of its plain
 * loopback servers -- never real ENS, and this file grants no more trust to
 * it than it already grants a bare port number. Deliberately NOT the same
 * exception as `LOOPBACK_HOSTS` above, and worth being honest about the
 * difference: a `.eth` name is a STRING, and this function does not resolve
 * it, so unlike a literal it is NOT guaranteed to actually reach loopback --
 * that guarantee is what the PAC or `--host-resolver-rules` orivon-ports
 * generates is for, not this check. What makes it acceptable anyway, all
 * three required together: this whole path is already `ORIVON_DEV_ORIGINS=1`
 * only, set by nothing but `npm run dev`; `grantDevOrigin` still requires a
 * real, parseable manifest fetched from the exact typed origin; and a person
 * still answers the same consent prompt A46 already accepts residual risk
 * on for the loopback-literal case (this file's own header, "NOT enforced
 * yet"). `.eth` is not a name a real DNS root could ever hand back a
 * different registrant for -- there is no registrant -- so the one new risk
 * this adds is a developer's OWN machine having a resolver override that
 * misdirects an `.eth` name, and https:// is refused for it outright, since
 * no `.eth` name is ever going to present a certificate that could make that
 * attempt indistinguishable from a real one.
 */
const ETH_NAME = /^[a-z0-9][a-z0-9-]*\.eth$/

export const MAX_DEV_MANIFEST_BYTES = 64 * 1024

/**
 * Whether `origin` may take this path. `enabled` is the caller's developer-
 * mode decision -- production wiring passes whether `ORIVON_DEV_ORIGINS=1`,
 * which only `npm run dev` sets -- kept as a parameter so this stays a pure
 * function with no Electron import.
 */
export function isDevGrantableOrigin (origin: string, enabled: boolean): boolean {
  if (!enabled) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (LOOPBACK_HOSTS.has(url.hostname)) return true
  return url.protocol === 'http:' && ETH_NAME.test(url.hostname)
}

export interface DevGrantDeps {
  readonly broker: Broker
  readonly fetchManifest: (url: string) => Promise<{ ok: boolean, status: number, text: string }>
  readonly consent?: InstallConsentPrompt
  readonly perCapabilityConsent?: PerCapabilityConsentPrompt
}

/**
 * A fourth `installApp` outcome, deliberately NOT one of `LoadResult`'s own
 * (`../loader/index.ts`): nothing was fetched, hashed or pinned, so there is
 * no `PinRecord` to report and calling this 'installed' would be a lie in the
 * one field that proves an install happened.
 */
export interface DevGranted {
  readonly outcome: 'dev-granted'
  readonly canonicalOrigin: string
  /** False when this origin was already registered, so a caller can skip a reload it does not need. */
  readonly newlyRegistered: boolean
}

export type DevGrantOutcome =
  | DevGranted
  | { readonly outcome: 'rejected', readonly reason: string }

/**
 * Whether `declared` asks for more than `held` on a capability kind the origin
 * ALREADY holds. Kinds not yet held are left out on purpose: a new capability
 * is what the consent prompt exists to ask about. A widened HELD one is not --
 * an all-or-nothing accept re-grants it at the new patterns under a row the
 * prompt labels as already allowed. Same `widensAuthority` the installed
 * path's update decision uses, restricted to held kinds.
 */
function widensHeldGrants (held: PatternSet, declared: PatternSet): boolean {
  const heldKindsOnly: Partial<Record<CapabilityKind, readonly Pattern[]>> = {}
  for (const kind of Object.keys(held) as CapabilityKind[]) {
    const wanted = declared[kind]
    if (wanted !== undefined) heldKindsOnly[kind] = wanted
  }
  return widensAuthority(held, heldKindsOnly)
}

/**
 * Fetches `origin`'s well-known manifest, registers the origin against it,
 * and asks for consent -- the same `registerApp` + `requestInstallConsent`
 * pair `update-outcomes.ts`'s `finaliseInstall` runs, minus everything to do
 * with a bundle.
 *
 * Registration happens BEFORE consent, matching `finaliseInstall`'s own
 * order: `requestInstallConsent` reads `broker.app.grants(origin)` and grants
 * against the registered manifest, so an unregistered origin has nothing for
 * it to grant against.
 */
export async function grantDevOrigin (deps: DevGrantDeps, origin: string): Promise<DevGrantOutcome> {
  let response: { ok: boolean, status: number, text: string }
  try {
    response = await deps.fetchManifest(`${origin}/.well-known/orivon.json`)
  } catch (error) {
    return { outcome: 'rejected', reason: `manifest fetch failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { outcome: 'rejected', reason: `manifest fetch returned HTTP ${String(response.status)}` }
  if (response.text.length > MAX_DEV_MANIFEST_BYTES) {
    return { outcome: 'rejected', reason: `manifest exceeds ${String(MAX_DEV_MANIFEST_BYTES)} bytes` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(response.text)
  } catch {
    return { outcome: 'rejected', reason: 'manifest is not valid JSON' }
  }
  const result = parseManifest(parsed)
  if (!result.ok) return { outcome: 'rejected', reason: `manifest rejected: ${result.reason}` }

  const alreadyRegistered = deps.broker.app.isRegisteredSync(origin)
  // Checked BEFORE registerApp, so a refused manifest never replaces the one
  // the person actually consented to. Grants here are session-only (T13c),
  // so a restart is the route to being asked again.
  if (alreadyRegistered) {
    const held = patternSetFromGrants(await deps.broker.app.grants(origin))
    if (widensHeldGrants(held, patternSetFromCapabilities(result.manifest.capabilities))) {
      return { outcome: 'rejected', reason: 'the manifest now asks for more than this session granted; restart Orivon to be asked again' }
    }
  }
  await deps.broker.registerApp(origin, result.manifest)
  await requestInstallConsent(deps.broker, deps.consent, origin, result.manifest, deps.perCapabilityConsent)
  return { outcome: 'dev-granted', canonicalOrigin: origin, newlyRegistered: !alreadyRegistered }
}
