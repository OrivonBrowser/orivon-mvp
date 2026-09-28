// The decisions behind a `<webview>` attaching inside an app tab
// (ADR-0039), with no `electron` import so they run under plain vitest:
// what the guest's webPreferences and attributes become whatever the app
// wrote, which partition its pages live in, and whether a document request
// inside it may proceed. ./embed-host.ts wires these to Electron.

import type { WebPreferences } from 'electron'
import { originHash } from '../../broker/grants/origin-hash.js'
import { classifyAddress, isPublicUnicast } from '../../broker/policy/address.js'
import { embedAdmissionKind, embedDocumentAllowed } from '../../broker/policy/embed-origin.js'
import type { Pattern } from '../../contracts/index.js'

const PARTITION_PREFIX = 'persist:embed-'

/**
 * The one session every page `appOrigin` shows runs in: `persist:`, so a
 * shown site keeps the person signed in across restarts, and hashed like
 * the app's own partition (`origin-hash.ts`'s `partitionFor`) but under a
 * different prefix, so it can never coincide with it.
 */
export function embedPartitionFor (appOrigin: string): string {
  return `${PARTITION_PREFIX}${originHash(appOrigin)}`
}

/** The `<webview>` attributes an app may set that the shell overrides or drops. */
const DROPPED_PARAMS = ['nodeintegration', 'nodeintegrationinsubframes', 'disablewebsecurity', 'enableblinkfeatures', 'plugins', 'allowpopups', 'webpreferences'] as const

export interface GuestSettings {
  /** The shell's own guest preload, `out/preload/embed.js`. */
  readonly preloadPath: string
  readonly partition: string
  /** Developer mode only: the guest's DevTools. */
  readonly devTools: boolean
}

/**
 * Rewrites, in place, what a `<webview>` asked for into what it gets. Every
 * field an app could use to widen the guest's power is set or deleted here
 * rather than checked and refused: refusing would destroy the guest with no
 * event the app can act on, while rewriting keeps every attach working with
 * the security properties holding whatever the app wrote (ADR-0039).
 */
export function hardenGuest (webPreferences: WebPreferences, params: Record<string, string>, settings: GuestSettings): void {
  webPreferences.preload = settings.preloadPath
  webPreferences.partition = settings.partition
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.webviewTag = false
  webPreferences.plugins = false
  webPreferences.devTools = settings.devTools
  delete webPreferences.additionalArguments
  delete webPreferences.enableBlinkFeatures
  delete webPreferences.session
  for (const name of DROPPED_PARAMS) delete params[name]
  params.partition = settings.partition
  params.preload = settings.preloadPath
}

/** Request types that load a document: the only ones the grant judges. */
const DOCUMENT_TYPES: ReadonlySet<string> = new Set(['mainFrame', 'subFrame'])

/**
 * Whether a request inside a shown page may proceed under `patterns`. A
 * subresource always may: the grant names which sites the app shows, and
 * what those sites load is their own business. A document load, top frame
 * or subframe, must pass the grant (`embedDocumentAllowed`), and with no
 * live grant at all nothing loads.
 */
export function guestRequestAllowed (url: string, resourceType: string, patterns: readonly Pattern[] | undefined): boolean {
  if (patterns === undefined) return false
  if (!DOCUMENT_TYPES.has(resourceType)) return true
  return embedDocumentAllowed(url, patterns)
}

/**
 * `guestRequestAllowed`'s async counterpart -- C-7/A286: no cancellable
 * Electron webRequest event carries the address a document load actually
 * connects to, so this checks the NAME first, through `resolve` (the guest
 * session's own `Session.resolveHost`, ./embed-host.ts's job to inject --
 * it shares Chromium's host cache with the load that follows, so a static
 * name already answers from that same cache).
 *
 * `embedAdmissionKind`'s pure hostname gate (`reachableByWildcard`) stays
 * the FIRST gate: a `localhost` name or a non-public address literal named
 * IN THE URL is refused with no lookup, exactly as before. What this adds
 * is for the case that gate cannot see -- a name that only resolves to a
 * private/loopback address once asked: an EXACT origin match never
 * resolves at all (ADR-0039 lets a named origin be private); a `"*"` match
 * whose host is already an address literal (`classifyAddress` parses it)
 * needs no lookup either, since `reachableByWildcard` already proved it
 * public; only a `"*"` match whose host is a genuine NAME is resolved, and
 * refused unless `resolve` returns at least one address and every one of
 * them is public unicast. `resolve` throwing refuses, same as everything
 * else here: fail closed. The residual this cannot close -- a TTL-0 name
 * that answers differently between this check and the connection -- is
 * A286, the same class A196 already accepts for `connectSecure`.
 */
export async function guestRequestAllowedAsync (
  url: string,
  resourceType: string,
  patterns: readonly Pattern[] | undefined,
  resolve: (host: string) => Promise<readonly string[]>
): Promise<boolean> {
  if (patterns === undefined) return false
  if (!DOCUMENT_TYPES.has(resourceType)) return true
  const admission = embedAdmissionKind(url, patterns)
  if (admission.kind === 'refused') return false
  if (admission.kind === 'exact') return true
  if (classifyAddress(admission.hostname) !== 'unparseable') return true
  let addresses: readonly string[]
  try {
    addresses = await resolve(admission.hostname)
  } catch {
    return false
  }
  return addresses.length > 0 && addresses.every(isPublicUnicast)
}
