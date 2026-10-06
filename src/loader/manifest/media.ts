// `capabilities.media` (ADR-0032, ADR-0055), split out of ./capabilities.ts (docs/development/code-guidelines.md
// Rule 2). Same stance as manifest.ts: THE INPUT IS ADVERSARIAL, every check REJECTS rather than repairs, and every
// rejection reason is developer-facing.

import type { MediaCapability } from '../../contracts/index.js'
import { ownProperty } from '../../broker/policy/own-property.js'
import { describeValue, extraKey, isAny, isRecord, reject } from './manifest.js'

/** The parity guard (scripts/check-manifest-parity.mjs) reads this list against the contract's `MediaCapability`. */
const MEDIA_CAPABILITY_KEYS = ['camera', 'microphone', 'screen'] as const

/**
 * Presence is the ask, so a flag is `true` or absent: `false` would read as a declaration that declares nothing,
 * and an empty object the same, and a manifest that means "none" says nothing.
 */
export function readMedia (raw: unknown, path: string): MediaCapability {
  if (!isRecord(raw)) reject(`${path} must be an object, got ${describeValue(raw)}`)
  const extra = extraKey(raw, MEDIA_CAPABILITY_KEYS)
  if (extra !== null) reject(`${path} has an unrecognised field: ${describeValue(extra)}`)

  const result: { camera?: true, microphone?: true, screen?: true } = {}
  for (const flag of MEDIA_CAPABILITY_KEYS) {
    const value = ownProperty(raw, flag, isAny)
    if (value === undefined) continue
    if (value !== true) reject(`${path}.${flag} must be true or omitted, got ${describeValue(value)}`)
    result[flag] = true
  }
  if (Object.keys(result).length === 0) reject(`${path} declares nothing: name camera, microphone or screen as true, or omit media`)
  return result
}
