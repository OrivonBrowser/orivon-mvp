// `Manifest.domain` (contracts/manifest.ts carries the meaning): the one ENS name or DNS
// host an app names as its home. The grammar is the host spelling a URL gives, so the shell
// compares it to an origin's host as a plain string.

import { describeValue, isAny, reject } from './manifest.js'
import { ownProperty } from '../../broker/policy/own-property.js'

const MAX_DOMAIN_LENGTH = 253
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const ALL_DIGITS = /^[0-9]+$/

function domainRejection (domain: string): string | null {
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return `must be 1 to ${MAX_DOMAIN_LENGTH} characters`
  let canonical: string
  try {
    canonical = new URL(`https://${domain}`).hostname
  } catch {
    return 'is not a host name'
  }
  if (canonical !== domain) return 'must be a bare host name in lower case, with no scheme, port, path, user or trailing dot'
  const labels = domain.split('.')
  if (labels.length < 2) return 'must have at least two labels'
  if (!labels.every((label) => LABEL.test(label))) return 'has a label that is not letters, digits and inner hyphens, 63 characters at most'
  if (ALL_DIGITS.test(labels[labels.length - 1]!)) return 'must not be an IP address'
  const last = labels[labels.length - 1]
  if (last === 'localhost' || last === 'orivon') return `must not end in .${last}`
  return null
}

/** Absent is legal and left out of the manifest; a present value must be a valid host. */
export function readDomain (value: Record<string, unknown>): string | undefined {
  const raw = ownProperty(value, 'domain', isAny)
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') reject(`domain must be a string, got ${describeValue(raw)}`)
  const problem = domainRejection(raw)
  if (problem !== null) reject(`domain ${problem}: ${describeValue(raw)}`)
  return raw
}
