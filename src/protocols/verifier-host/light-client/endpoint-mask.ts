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

/** The address with its scheme, masked as `maskEndpoint` masks it: how a server is named on a screen, in a log or in a sentence. */
export function displayEndpoint (url: string): string {
  const parsed = parse(url)
  return parsed === undefined ? maskEndpoint(url) : `${parsed.protocol}//${maskEndpoint(url)}`
}

/**
 * Every string that would give the address's secret away if it were printed: the address as typed, any key-like path segment or
 * query value, the path and query as a whole when they hold one or the address has a query, a key-like host label, and the
 * credentials. An ordinary path (`/eth`) is not one by itself, because it would blank every other line that holds the same
 * letters. The address of a server with a path is named even then, since it is shown masked. Empty for an address that holds
 * neither.
 */
export function secretParts (url: string): string[] {
  const parsed = parse(url)
  if (parsed === undefined) return []
  const parts = new Set<string>()
  const holdsPath = hasPath(parsed) || parsed.search !== ''
  for (const segment of parsed.pathname.split('/')) if (KEY_PART.test(segment)) parts.add(segment)
  for (const [, value] of parsed.searchParams) if (KEY_PART.test(value)) parts.add(value)
  if (parts.size > 0 || parsed.search !== '') parts.add(`${parsed.pathname}${parsed.search}`)
  const label = bareHost(parsed.hostname).split('.').find(isKeyLabel)
  if (label !== undefined && canonicalAddress(bareHost(parsed.hostname)) === null) parts.add(label)
  if (parsed.username !== '') parts.add(decodeURIComponent(parsed.username))
  if (parsed.password !== '') parts.add(decodeURIComponent(parsed.password))
  if (parts.size === 0 && !holdsPath) return []
  parts.add(url)
  if (url.endsWith('/')) parts.add(url.slice(0, -1))
  return [...parts]
}

/** `text` with each of `urls` shown masked, and no secret part of any of them left in it. */
export function maskText (text: string, urls: readonly string[]): string {
  let masked = text
  for (const url of urls) {
    if (parse(url) === undefined) continue
    const parts = secretParts(url).sort((a, b) => b.length - a.length)
    const shown = displayEndpoint(url)
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
