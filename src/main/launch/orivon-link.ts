// An `orivon:open?u=<target>` link handed to the browser by another program: what it may name, and the address it opens.
// The text is untrusted input from outside the process, so every check fails closed and nothing here throws. Pure.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'

export interface OrivonLink {
  /** What would be typed in the address bar: `name.eth/path`, `ipfs://<name>/path` or `ipns://<name>/path`. */
  readonly target: string
  /** An id of the shape `FLAVOUR_ID`; absent when the link carries none, or one that is malformed or repeated. */
  readonly flavour?: string
}

/** The shape of a flavour id. Whoever applies a flavour looks the id up in its own list; the shape only keeps a tag from carrying anything else. */
export const FLAVOUR_ID = /^[a-z0-9]{2,24}$/
/** Longest link read. Windows limits a command line to 32767 characters and a registry command passes the link whole. */
export const MAX_ORIVON_LINK = 2048

const MAX_PARAMETERS = 8
/** The characters of RFC 3986 a link may be written with, minus the ones that can end a quoted command-line argument. Anything else is percent-encoded or refused. */
const LINK_ALPHABET = /^[A-Za-z0-9\-._~:/?[\]@!$&'()*+,;=%]+$/
const LINK_FORM = /^orivon:(?:\/\/open\/?|open)\?(.*)$/
/** Whitespace, controls, bidirectional and invisible formatting, surrogates and unassigned or private-use code points, and the characters a path must not hold. */
const FORBIDDEN_IN_TARGET = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}\\"<>]/u
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/
const ADDRESS_SCHEMES: ReadonlySet<string> = new Set(['ipfs', 'ipns'])
const NAME_SHAPE = /^[A-Za-z0-9._~-]{1,253}$/
const ETH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/** A path segment that climbs or stays, as the URL parser reads it, and an escape of a separator or a dot that survived the one decoding. */
const DOT_SEGMENT = /^(?:\.|\.\.|%2e|\.%2e|%2e\.|%2e%2e)$/i
const ESCAPED_SEPARATOR = /%(?:2f|5c)/i

function decode (text: string): string | undefined {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

/** The parameter `name` of `pairs`: undefined when absent, null when it appears more than once. */
function single (pairs: readonly (readonly [string, string])[], name: string): string | undefined | null {
  const found = pairs.filter(([key]) => key === name)
  if (found.length > 1) return null
  return found[0]?.[1]
}

/** Whether `rest` (everything after the host: path, query, fragment) climbs out of the name or hides a separator. */
function pathIsSafe (rest: string): boolean {
  if (ESCAPED_SEPARATOR.test(rest)) return false
  const path = rest.split(/[?#]/)[0] ?? ''
  return !path.split('/').some((segment) => DOT_SEGMENT.test(segment))
}

/** The target, in its one spelling, when it is a `.eth` name or an ipfs:// or ipns:// address. */
function canonicalTarget (target: string): string | undefined {
  if (target === '' || FORBIDDEN_IN_TARGET.test(target)) return undefined
  const scheme = SCHEME.exec(target)?.[1]?.toLowerCase()
  if (scheme !== undefined) {
    if (!ADDRESS_SCHEMES.has(scheme)) return undefined
    const match = /^[^:]+:\/\/([^/?#]+)([/?#][^]*)?$/.exec(target)
    const name = match?.[1]
    const rest = match?.[2] ?? ''
    if (name === undefined || !NAME_SHAPE.test(name) || !pathIsSafe(rest)) return undefined
    const canonical = `${scheme}://${name}${rest}`
    return BUILTIN_ADDRESSES.servedUrl(canonical) === undefined ? undefined : canonical
  }
  const match = /^([^/?#]+)([/?#][^]*)?$/.exec(target)
  const host = match?.[1]?.toLowerCase()
  const rest = match?.[2] ?? ''
  if (host === undefined || !host.endsWith('.eth') || !pathIsSafe(rest)) return undefined
  const labels = host.split('.')
  return labels.length >= 2 && labels.every((label) => ETH_LABEL.test(label)) ? `${host}${rest}` : undefined
}

/** What the link names, or undefined when it is not an `orivon:open` link or names anything but a `.eth` name, an ipfs:// address or an ipns:// address. */
export function parseOrivonLink (text: string): OrivonLink | undefined {
  if (typeof text !== 'string' || text.length > MAX_ORIVON_LINK || !LINK_ALPHABET.test(text)) return undefined
  // The scheme is read in any case, as every scheme is; the action after it is `open` and nothing else.
  const query = LINK_FORM.exec(`${text.slice(0, 7).toLowerCase()}${text.slice(7)}`)?.[1]
  // A fragment is never part of the link: an unencoded `#` inside u= is ambiguous, so it is refused rather than guessed at.
  if (query === undefined || query.includes('#')) return undefined
  const parts = query.split('&')
  if (parts.length > MAX_PARAMETERS) return undefined
  const pairs = parts.map((part): readonly [string, string] => {
    const at = part.indexOf('=')
    return at === -1 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)]
  })
  const raw = single(pairs, 'u')
  if (raw === undefined || raw === null) return undefined
  const decoded = decode(raw)
  const target = decoded === undefined ? undefined : canonicalTarget(decoded)
  if (target === undefined) return undefined
  // A flavour that is repeated or malformed is dropped and the target still opens: the tag is a hint, the target is what was asked for.
  const named = single(pairs, 'flavour')
  const flavour = named === undefined || named === null ? undefined : decode(named)
  return flavour !== undefined && FLAVOUR_ID.test(flavour) ? { target, flavour } : { target }
}

/** The address a link opens, as a web address the tab loads, and the flavour it carries. Undefined for a link that is refused. */
export function openableOrivonLink (text: string): { readonly url: string, readonly flavour?: string } | undefined {
  const link = parseOrivonLink(text)
  if (link === undefined) return undefined
  const served = BUILTIN_ADDRESSES.servedUrl(link.target)
  let url: string
  try {
    url = served ?? new URL(`https://${link.target}`).toString()
  } catch {
    return undefined
  }
  return link.flavour === undefined ? { url } : { url, flavour: link.flavour }
}

/** The addresses that the `orivon:` links among `argv` open, in order, at most `limit`. Every other argument is skipped. */
export function orivonLinkAddresses (argv: readonly string[], limit = 8): string[] {
  const urls: string[] = []
  for (const argument of argv) {
    if (urls.length >= limit) break
    const open = openableOrivonLink(argument)
    if (open !== undefined) urls.push(open.url)
  }
  return urls
}
