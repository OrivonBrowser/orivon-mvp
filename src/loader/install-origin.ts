// Split out of fetch-bundle.ts (docs/development/code-guidelines.md Rule 2 --
// adding this pushed that file to 524 lines). Tested through fetch-bundle.ts's
// own suite, the same way manifest-capabilities.ts is tested through
// manifest.test.ts rather than a file of its own -- this module has no
// caller-visible contract beyond what fetchBundle() already exercises.

import { canonicalAddress, classifyAddress, isPublicUnicast } from '../broker/policy/address.js'
import { MAX_ANSWERS } from '../broker/policy/connect.js'
import type { Resolver } from '../broker/policy/connect.js'
import { isLocalhostName } from '../broker/policy/origin.js'

/**
 * `ensurePublicUnicastOrigin`'s success case: the validated, canonical
 * address literal(s) its resolution actually produced.
 *
 * THE WHOLE POINT OF THIS SHAPE (F2). The previous version of this function
 * resolved, validated every answer, and then returned only `null` --
 * discarding the very addresses it had just checked. `fetchBundle` then had
 * nothing to dial but the HOSTNAME again, so every fetch it made was a
 * SECOND, independent resolution -- by a different resolver
 * (`node:dns/promises` here vs. Chromium's own resolver inside the real
 * `Fetch`), at a different time, free to disagree with this one. That is a
 * TOCTOU/DNS-rebinding hole with no attacker required, only an ordinary
 * low-TTL answer. `connect.ts`'s own header names the fix: "resolve once,
 * validate every returned address, and hand the caller the validated
 * literals to dial" -- never name the host a second time. `addresses` is
 * that hand-off; `fetchBundle` threads it into every fetch this install
 * makes (F5), so the injected `resolveFn` below runs exactly once per
 * install, never once per request.
 *
 * A single-element array for a literal host (nothing to resolve) or a
 * literal already-installed origin; the resolver's full, deduplicated,
 * canonical answer set otherwise.
 */
export interface InstallOriginOk {
  readonly ok: true
  readonly addresses: readonly string[]
}

export interface InstallOriginRejected {
  readonly ok: false
  /** Developer-facing, same stance as fetch-bundle.ts's own FetchBundleRejected -- never shown to an end user as-is. */
  readonly reason: string
}

export type InstallOriginResult = InstallOriginOk | InstallOriginRejected

/**
 * T12/A46: the install origin's hostname must resolve -- or, for a literal,
 * classify -- as public-unicast before fetch-bundle.ts's first network
 * request (the manifest fetch) ever happens. This is the shell itself,
 * unsandboxed, issuing that request; it needs no grant and no manifest to
 * reach here, unlike an app's own `orivon.net.connect` traffic. Mirrors
 * `policy/connect.ts`'s own "resolve once, validate every returned address"
 * discipline exactly, reusing `classifyAddress`/`isPublicUnicast`/
 * `canonicalAddress`/`MAX_ANSWERS` rather than a second implementation
 * (Rule 3) -- see InstallOriginResult's own comment for why this function
 * hands the literals back rather than only a yes/no.
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
export async function ensurePublicUnicastOrigin (canonicalOrigin: string, resolveFn: Resolver): Promise<InstallOriginResult> {
  const url = new URL(canonicalOrigin)
  const host = url.hostname

  // F7/T13c: an on-path attacker can substitute the bundle of a cleartext
  // install outright, with nothing left to detect it -- there is no TLS
  // certificate to have been wrong. Checked first, and for free: no
  // resolution has happened yet, so refusing here costs nothing beyond the
  // string compare. Mirrors ./policy/origin.ts's `isPersistableOrigin`,
  // which refuses `http:` for the same reason (T13c), one layer up.
  if (url.protocol !== 'https:') return { ok: false, reason: `install origin must be https, not ${url.protocol}` }

  // F8: `localhost`/`app.localhost` are names, not address literals, so
  // `classifyAddress` below cannot see them -- they would otherwise fall
  // through to `resolveFn`, whose answer is resolver-dependent, while
  // Chromium maps the WHOLE `.localhost` subtree to loopback per RFC 6761
  // without ever consulting DNS. Checked before resolving so the guard and
  // the real fetch can never disagree about this name the way a resolved
  // answer could. Reuses ./policy/origin.ts's own check (Rule 3) rather than
  // a second copy of the RFC 6761 reasoning.
  if (isLocalhostName(host)) return { ok: false, reason: `install origin's host is in the .localhost namespace: ${host}` }

  // Never resolved when it's already a literal -- resolving a literal is
  // meaningless and risks a resolver treating it as a DNS label instead
  // (connect.ts's own header names this exact hazard for `2130706433`).
  if (classifyAddress(host) !== 'unparseable') {
    if (!isPublicUnicast(host)) return { ok: false, reason: `install origin's host is not a public address: ${host}` }
    // Fails closed on a literal classifyAddress accepts but canonicalAddress
    // does not -- a public global-unicast IPv6 address still carrying a zone
    // id (`2606:4700::1%eth0`) is the reachable case: classifyAddress strips
    // the zone and classifies the address underneath as public, but no
    // canonical spelling of a zone-scoped address exists to hand onward (see
    // address.ts's own comment on canonicalAddress's second, deliberate
    // null case).
    const canonical = canonicalAddress(host)
    if (canonical === null) return { ok: false, reason: `install origin's host is not a canonical address literal: ${host}` }
    return { ok: true, addresses: [canonical] }
  }

  let answers: readonly string[]
  try {
    answers = await resolveFn(host)
  } catch (error) {
    return { ok: false, reason: `could not resolve the install origin's host (${host}): ${error instanceof Error ? error.message : String(error)}` }
  }
  // Fail closed on an empty answer, same reasoning as connect.ts:
  // `[].every(...)` is true, and a check built on it would wave through
  // exactly the host whose nameserver returned nothing.
  if (answers.length === 0) return { ok: false, reason: `install origin's host resolved to no addresses: ${host}` }
  // F9: the answer count is DNS-controlled, not grant-controlled the way
  // connect.ts's pattern count is -- reusing its own MAX_ANSWERS (Rule 3)
  // bounds the loop below the same way, against the same T11b class of cost
  // connect.ts's own MAX_ANSWERS comment measured (13.9s of synchronous CPU
  // for an unbounded answer list).
  if (answers.length > MAX_ANSWERS) return { ok: false, reason: `install origin's host resolved to too many addresses: ${host}` }

  const addresses: string[] = []
  for (const answer of answers) {
    if (typeof answer !== 'string' || !isPublicUnicast(answer)) {
      return { ok: false, reason: `install origin's host resolved to a non-public address: ${host}` }
    }
    // Every answer must be a CANONICAL literal, spelled exactly the way
    // canonicalAddress would spell it -- not merely something isPublicUnicast
    // accepts (which, like classifyAddress, is deliberately permissive on
    // the deny side; see address.ts's header). `addresses` is what
    // fetchBundle hands to a real Fetch to dial, so anything that would be
    // re-resolved downstream defeats the whole point of resolving here.
    const canonical = canonicalAddress(answer)
    if (canonical === null) return { ok: false, reason: `install origin's host resolved to an address in non-canonical form: ${host}` }
    if (!addresses.includes(canonical)) addresses.push(canonical)
  }
  return { ok: true, addresses }
}
