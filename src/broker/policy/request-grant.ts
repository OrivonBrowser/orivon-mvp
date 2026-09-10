// app.requestGrant's policy (contracts/capability-api.ts's own doc: "Resolves
// false if declined or not declared."). This file is the "not declared" half
// AND the half that proves a grant can never exceed the manifest -- item
// 4.1's own security shape, point 1 (docs/planning/unattended-build-queue.md).
// Pure, no I/O -- see ../README.md's "policy/ decides" convention. The
// consent question ("did a person actually accept?") is deliberately NOT
// this file's job; see ../../main/request-grant.ts for where that and the
// resulting broker.grant() call happen.

import { widensAuthority } from './update.js'
import { patternSetFromCapabilities } from './manifest-patterns.js'
import type { CapabilityKind, Manifest, Pattern } from '../../contracts/index.js'

const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  'tcp.connect', 'tcp.listen', 'udp.bind', 'udp.send', 'https.connect', 'fs', 'id'
]

/**
 * True for exactly the seven `CapabilityKind` literals -- the guard an
 * UNTRUSTED string needs before it may be treated as one. Two independent
 * callers need it: `../../main/request-grant.ts`'s `request.capability` (an
 * app's raw IPC payload) and `../grants/grant-persistence.ts`'s hydration
 * path (a JSON property name read off disk). Moved here, out of
 * `main/request-grant.ts` where it first shipped (queue item 4.1), once the
 * second caller made it a shared idea rather than that file's own private
 * check (code-guidelines.md Rule 3).
 */
export function isCapabilityKind (value: string): value is CapabilityKind {
  return (CAPABILITY_KINDS as readonly string[]).includes(value)
}

export interface GrantRequestDecision {
  readonly allowed: boolean
  /**
   * What to actually grant if the user accepts. EMPTY, never
   * `requestedPatterns`, when `allowed` is false -- a caller that ignores
   * `allowed` and grants `patterns` anyway still creates nothing.
   */
  readonly patterns: readonly Pattern[]
}

/**
 * Decides whether a `requestGrant(capability, patterns)` call may proceed to
 * a person at all.
 *
 * `requestedPatterns` undefined means "whatever the manifest already
 * declares for this capability" -- the natural default for a capability like
 * `fs`/`id` that carries none, and for a caller that just wants everything
 * its own manifest already promised.
 *
 * THE SUBSET CHECK IS `widensAuthority` (./update.ts), REUSED, NOT
 * REIMPLEMENTED -- one capability's declared patterns stand in for
 * `granted`, the request's patterns for `requested`. Same direction, same
 * reasoning, same file: a second copy of "is this pattern set contained in
 * that one" is exactly the kind of duplicate docs/development/code-
 * guidelines.md Rule 3 exists to prevent, and this is security-critical
 * enough that reuse also means it inherits update.ts's own mutation-tested
 * coverage rather than starting from zero.
 */
export function decideGrantRequest (
  manifest: Manifest,
  capability: CapabilityKind,
  requestedPatterns: readonly Pattern[] | undefined
): GrantRequestDecision {
  const declared = patternSetFromCapabilities(manifest.capabilities)
  const declaredForKind = declared[capability]
  // Absent means "not declared" -- capability-api.ts's own wording, and the
  // one branch that must never fall through to a prompt.
  if (declaredForKind === undefined) return { allowed: false, patterns: [] }

  const wanted = requestedPatterns ?? declaredForKind
  const declaredSet = { [capability]: declaredForKind } as Partial<Record<CapabilityKind, readonly Pattern[]>>
  const requestedSet = { [capability]: wanted } as Partial<Record<CapabilityKind, readonly Pattern[]>>
  if (widensAuthority(declaredSet, requestedSet)) return { allowed: false, patterns: [] }

  return { allowed: true, patterns: wanted }
}
