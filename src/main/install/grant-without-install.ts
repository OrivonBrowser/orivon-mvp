// An origin gets its capabilities GRANTED without being INSTALLED: its
// manifest is read, the origin registered against it, and the person asked,
// while the page keeps being served by whatever server hosts it. NO BUNDLE IS
// FETCHED, HASHED, PINNED OR SERVED FROM CACHE, so that host stays a plain
// static file server. Registration alone is what an app tab needs:
// `tab-view.ts`'s `appTabArgsFor` reads `broker.app.isRegisteredSync(origin)`,
// never a pin.
//
// It serves the origins `app-install.ts` structurally cannot, since
// `install-origin.ts` refuses them before consent (not https, not public
// unicast): a loopback origin, in every build, and in developer mode an
// orivon-ports `.eth` name. The manifest is read only from the origin the
// page was itself loaded from, never one the page names, and nothing proves
// the address was typed: a link to a loopback URL leads to the same prompt,
// which the person still answers. Grants here are session-only (T13c).

import { MAX_MANIFEST_BYTES, parseManifest } from '../../loader/manifest/manifest.js'
import { requestInstallConsent } from '../consent/install-consent.js'
import type { InstallConsentPrompt, PerCapabilityConsentPrompt } from '../consent/install-consent.js'
import type { Broker } from '../../broker/broker-contracts.js'
import { patternSetFromGrants, widensAuthority } from '../../broker/policy/update.js'
import type { PatternSet } from '../../broker/policy/update.js'
import { patternSetFromCapabilities } from '../../broker/policy/manifest-patterns.js'
import type { CapabilityKind, Pattern } from '../../contracts/index.js'
import { isLoopbackHost } from '../../broker/policy/origin.js'

/**
 * orivon-ports' own convention for a fake name over one of its plain
 * loopback servers -- never real ENS, and this file grants no more trust to
 * it than it already grants a bare port number. Unlike a loopback host, a
 * `.eth` name is a STRING this function does not resolve, so it is NOT
 * guaranteed to reach loopback; that is what the `--host-resolver-rules`
 * clauses from orivon-ports' names file are for. What makes it acceptable
 * anyway, all three required together: the `.eth` half is developer-mode
 * only (../dev/dev-mode.ts); `grantWithoutInstall` still requires a real,
 * parseable manifest fetched from the exact origin; and a person still
 * answers the same consent prompt. `.eth` is not a name a real DNS root could
 * ever hand back a different registrant for -- there is no registrant -- so
 * the one new risk this adds is a developer's OWN machine having a resolver
 * override that misdirects an `.eth` name, and https:// is refused for it
 * outright, since no `.eth` name is ever going to present a certificate that
 * could make that attempt indistinguishable from a real one.
 */
const ETH_NAME = /^[a-z0-9][a-z0-9-]*\.eth$/

/**
 * Whether `origin` may take this path: a loopback host over http or https,
 * always, or a plain-http `.eth` name when `devMode` is on. `devMode` is
 * ../dev/dev-mode.ts's answer, kept as a parameter so this stays a pure
 * function with no Electron import.
 */
export function grantableWithoutInstall (origin: string, devMode: boolean): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (isLoopbackHost(url.hostname)) return true
  return devMode && url.protocol === 'http:' && ETH_NAME.test(url.hostname)
}

export interface GrantWithoutInstallDeps {
  readonly broker: Broker
  readonly fetchManifest: (url: string) => Promise<{ ok: boolean, status: number, text: string }>
  readonly consent?: InstallConsentPrompt
  readonly perCapabilityConsent?: PerCapabilityConsentPrompt
}

/**
 * A fourth `installApp` outcome, deliberately NOT one of `LoadResult`'s own
 * (`../../loader/index.ts`): nothing was fetched, hashed or pinned, so there is
 * no `PinRecord` to report and calling this 'installed' would be a lie in the
 * one field that proves an install happened.
 */
export interface GrantedWithoutInstall {
  readonly outcome: 'granted-without-install'
  readonly canonicalOrigin: string
  /** False when this origin was already registered, so a caller can skip a reload it does not need. */
  readonly newlyRegistered: boolean
}

export type GrantWithoutInstallOutcome =
  | GrantedWithoutInstall
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
export async function grantWithoutInstall (deps: GrantWithoutInstallDeps, origin: string): Promise<GrantWithoutInstallOutcome> {
  let response: { ok: boolean, status: number, text: string }
  try {
    response = await deps.fetchManifest(`${origin}/.well-known/orivon.json`)
  } catch (error) {
    return { outcome: 'rejected', reason: `manifest fetch failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { outcome: 'rejected', reason: `manifest fetch returned HTTP ${String(response.status)}` }
  if (new TextEncoder().encode(response.text).length > MAX_MANIFEST_BYTES) {
    return { outcome: 'rejected', reason: `manifest exceeds ${String(MAX_MANIFEST_BYTES)} bytes` }
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
  return { outcome: 'granted-without-install', canonicalOrigin: origin, newlyRegistered: !alreadyRegistered }
}
