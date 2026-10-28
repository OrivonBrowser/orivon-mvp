// How an Ethereum server the person typed in is shown and scrubbed. An address may carry a key (in its path, its query or a
// host label), and nothing that reaches a screen, a log, a report or an error may carry it. Pure: no I/O.

import { canonicalAddress, classifyAddress } from '../../../broker/policy/address.js'

/** What stands in for the part of an address that may be a key. */
export const MASK = '••••'

/** A host label that reads as an access key: long, no hyphen, letters and digits both (a name does not look like this). */
const KEY_LABEL = /^(?=(?:.*\d){2})(?=(?:.*[a-z]){2})[a-z0-9]{16,}$/i
/** A path segment or query value long enough, with a digit, to be a key. */
const KEY_PART = /^(?=.*\d)[\w.~-]{8,}$/

const isKeyLabel = (label: string): boolean => KEY_LABEL.test(label)
const bareHost = (host: string): string => host.replace(/^\[|\]$/g, '')

function parse (url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/** The host with any key-like label hidden. An address literal has no labels. */
function shownHost (parsed: URL): string {
  const host = bareHost(parsed.hostname)
  if (canonicalAddress(host) !== null) return parsed.hostname
  return host.split('.').map((label) => isKeyLabel(label) ? MASK : label).join('.')
}

const hasPath = (parsed: URL): boolean => parsed.pathname !== '/' && parsed.pathname !== ''

/**
 * The address as it may be shown: `host[:port]`, then `/••••` when the address has a path or a query, and any label of the
 * host that looks like a key hidden. Credentials in the address are dropped. Text that is not an address is never echoed.
 */
export function maskEndpoint (url: string): string {
  const parsed = parse(url)
  if (parsed === undefined) return 'an address that cannot be read'
  const port = parsed.port === '' ? '' : `:${parsed.port}`
  return `${shownHost(parsed)}${port}${hasPath(parsed) || parsed.search !== '' ? `/${MASK}` : ''}`
}

/**
 * Every string that would give the address's secret away if it were printed: the address as typed, its path and query, any
 * key-like path segment or query value, a key-like host label, and the credentials. Empty for an address that holds none.
 */
export function secretParts (url: string): string[] {
  const parsed = parse(url)
  if (parsed === undefined) return []
  const parts = new Set<string>()
  const pathAndQuery = hasPath(parsed) || parsed.search !== '' ? `${parsed.pathname}${parsed.search}` : undefined
  if (pathAndQuery !== undefined) {
    parts.add(pathAndQuery)
    for (const segment of parsed.pathname.split('/')) if (KEY_PART.test(segment)) parts.add(segment)
    for (const [, value] of parsed.searchParams) if (KEY_PART.test(value)) parts.add(value)
  }
  const label = bareHost(parsed.hostname).split('.').find(isKeyLabel)
  if (label !== undefined && canonicalAddress(bareHost(parsed.hostname)) === null) parts.add(label)
  if (parsed.username !== '') parts.add(decodeURIComponent(parsed.username))
  if (parsed.password !== '') parts.add(decodeURIComponent(parsed.password))
  if (parts.size === 0) return []
  parts.add(url)
  if (url.endsWith('/')) parts.add(url.slice(0, -1))
  return [...parts]
}

/** `text` with each of `urls` shown masked, and no secret part of any of them left in it. */
export function maskText (text: string, urls: readonly string[]): string {
  let masked = text
  for (const url of urls) {
    const parsed = parse(url)
    if (parsed === undefined) continue
    const parts = secretParts(url).sort((a, b) => b.length - a.length)
    const shown = `${parsed.protocol}//${maskEndpoint(url)}`
    for (const part of parts) masked = masked.split(part).join(part === url || part === url.slice(0, -1) ? shown : MASK)
  }
  return masked
}

/**
 * Whether `host` is `localhost` or an address literal, in its canonical spelling, that is loopback or private (RFC 1918, unique
 * local): a computer the person owns, on this machine or their home network. Never a name that resolves, and never link-local.
 */
export function isLocalLiteral (host: string): boolean {
  const bare = bareHost(host)
  if (bare === 'localhost') return true
  if (canonicalAddress(bare) !== bare) return false
  const kind = classifyAddress(bare)
  return kind === 'loopback' || kind === 'private'
}
