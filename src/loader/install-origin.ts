// Split out of fetch-bundle.ts (docs/development/code-guidelines.md Rule 2 --
// adding this pushed that file to 524 lines). Tested through fetch-bundle.ts's
// own suite, the same way manifest-capabilities.ts is tested through
// manifest.test.ts rather than a file of its own -- this module has no
// caller-visible contract beyond what fetchBundle() already exercises.

import { classifyAddress, isPublicUnicast } from '../broker/policy/address.js'
import type { Resolver } from '../broker/policy/connect.js'

/**
 * T12/A46: the install origin's hostname must resolve -- or, for a literal,
 * classify -- as public-unicast before fetch-bundle.ts's first network
 * request (the manifest fetch) ever happens. This is the shell itself,
 * unsandboxed, issuing that request; it needs no grant and no manifest to
 * reach here, unlike an app's own `orivon.net.connect` traffic. Mirrors
 * `policy/connect.ts`'s own "resolve once, validate every returned address"
 * discipline exactly, reusing `classifyAddress`/`isPublicUnicast` rather than
 * a second implementation (Rule 3) -- this function does not need
 * `connect.ts`'s own canonical-literal-to-dial contract, only a yes/no.
 *
 * Returns `null` when installable, or a developer-facing rejection reason
 * otherwise -- a plain string rather than fetch-bundle.ts's own
 * `FetchBundleRejected` shape, so this file does not need to import that
 * type back from its one caller.
 *
 * NO LOOPBACK CARVE-OUT. `docs/open-questions.md` A46 (owner decision)
 * permits installing a user-TYPED loopback literal -- but the only discovery
 * trigger this loader is ever wired to is a page-supplied hint
 * (`README.md`), which is exactly the case A46 says loopback must NEVER be
 * reachable from. A user-initiated local-development path is deferred
 * (build step 9, developer mode); until it ships, every private, loopback,
 * link-local, CGNAT and cloud-metadata range is refused outright here, with
 * no exception -- stated plainly rather than silently routed around.
 */
export async function ensurePublicUnicastOrigin (canonicalOrigin: string, resolveFn: Resolver): Promise<string | null> {
  const host = new URL(canonicalOrigin).hostname

  // Never resolved when it's already a literal -- resolving a literal is
  // meaningless and risks a resolver treating it as a DNS label instead
  // (connect.ts's own header names this exact hazard for `2130706433`).
  if (classifyAddress(host) !== 'unparseable') {
    return isPublicUnicast(host) ? null : `install origin's host is not a public address: ${host}`
  }

  let answers: readonly string[]
  try {
    answers = await resolveFn(host)
  } catch (error) {
    return `could not resolve the install origin's host (${host}): ${error instanceof Error ? error.message : String(error)}`
  }
  // Fail closed on an empty answer, same reasoning as connect.ts:
  // `[].every(...)` is true, and a check built on it would wave through
  // exactly the host whose nameserver returned nothing.
  if (answers.length === 0) return `install origin's host resolved to no addresses: ${host}`
  for (const answer of answers) {
    if (!isPublicUnicast(answer)) return `install origin's host resolved to a non-public address: ${host}`
  }
  return null
}
