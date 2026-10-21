// `Manifest.support` (contracts/manifest.ts carries the meaning): where the publisher wants a
// problem with the app reported. The shell shows the address as a link, so it is held to one
// absolute https: URL that names a host and carries no credentials.

import { UNSAFE_TEXT_CHARS, describeValue, isAny, isRecord, reject } from './manifest.js'
import { ownProperty } from '../../broker/policy/own-property.js'

const MAX_ISSUES_LENGTH = 2048

function issuesRejection (issues: string): string | null {
  if (issues.length === 0 || issues.length > MAX_ISSUES_LENGTH) return `must be 1 to ${MAX_ISSUES_LENGTH} characters`
  if (UNSAFE_TEXT_CHARS.test(issues) || /\s/.test(issues)) return 'must not contain whitespace or an unsafe character (a control code, bidi override or zero-width character)'
  let url: URL
  try {
    url = new URL(issues)
  } catch {
    return 'is not an absolute URL'
  }
  if (url.protocol !== 'https:' || !issues.startsWith('https://')) return 'must be an https: URL written with "https://"'
  if (url.username !== '' || url.password !== '') return 'must not carry a user name or password'
  return null
}

/**
 * Absent is legal and left out of the manifest; a present value must be an object holding `issues`.
 * A key of `support` this build does not know is skipped, as an unknown top-level field is, so a
 * later Orivon can add one without locking out an app an older build installed.
 */
export function readSupport (value: Record<string, unknown>): { readonly issues: string } | undefined {
  const raw = ownProperty(value, 'support', isAny)
  if (raw === undefined) return undefined
  if (!isRecord(raw)) reject(`support must be an object, got ${describeValue(raw)}`)
  const issues = ownProperty(raw, 'issues', isAny)
  if (issues === undefined) reject('support.issues is required when support is present')
  if (typeof issues !== 'string') reject(`support.issues must be a string, got ${describeValue(issues)}`)
  const problem = issuesRejection(issues)
  if (problem !== null) reject(`support.issues ${problem}: ${describeValue(issues)}`)
  return { issues }
}
