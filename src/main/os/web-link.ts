// The https address any browser opens for what the address bar shows: `ipfs://name.eth/x` is not a link another
// browser follows, `https://name.eth.limo/x` is. Pure string work; an address with no such form has none, and the
// caller offers no item for it rather than a link that goes somewhere else.
import { canonicalCid, canonicalKey } from '../../protocols/ipfs/names.js'
import { ADDRESS_SUFFIX } from '../../protocols/protocol.js'
import { dnsName } from '../../protocols/resolution/dns-name.js'

const ADDRESS = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/
/** A label of a host: what a subdomain gateway can carry, so a longer CID or key has no such link. */
const MAX_LABEL = 63

/** The menu wording: it names what the link does for a reader elsewhere, and claims nothing about how it was checked. */
export const WEB_LINK_LABEL = 'Copy web link (opens in any browser)'

const ETH_GATEWAY = 'limo'
const IPFS_GATEWAY = 'ipfs.dweb.link'
const IPNS_GATEWAY = 'ipns.dweb.link'

/** `https://<host><path><query><fragment>` as the URL parser spells it, or undefined when it is not one. */
function httpsUrl (host: string, path: string, query: string, fragment: string): string | undefined {
  const target = `${path === '' ? '/' : path}${query}${fragment}`
  try {
    return new URL(`https://${host}${target.startsWith('/') ? '' : '/'}${target}`).href
  } catch {
    return undefined
  }
}

/** A `.eth` name as lowercase ASCII labels, or undefined: no port, no user, no empty label. */
function ethName (host: string): string | undefined {
  const name = dnsName(host)
  return name !== undefined && name.endsWith('.eth') ? name : undefined
}

/** The CID a subdomain carries: CIDv1 in lowercase base32 (a CIDv0 converted, an uppercase spelling lowered), at most one label long. */
function cidLabel (name: string): string | undefined {
  const cid = canonicalCid(name) ?? (name.startsWith('B') ? canonicalCid(name.toLowerCase()) : undefined)
  return cid !== undefined && cid.length <= MAX_LABEL && cid === cid.toLowerCase() ? cid : undefined
}

/** An IPNS key as a CIDv1 libp2p-key in base36, which fits one label when it is a 256-bit key. */
function keyLabel (name: string): string | undefined {
  if (!/^[A-Za-z0-9]+$/.test(name)) return undefined
  const key = canonicalKey(name)
  return key !== undefined && key.length <= MAX_LABEL ? key : undefined
}

/**
 * The https address that opens `address` in any browser, or undefined when it has none: a `.eth` name through
 * `eth.limo`, an IPFS or IPNS content address through `dweb.link`, and a web address as it is. Orivon's own pages,
 * `file:`, other schemes, a DNSLink domain and a name or CID that cannot be one host label have none.
 */
export function webLinkFor (address: string): string | undefined {
  const text = address.trim()
  if (text === '' || CONTROL_OR_SPACE.test(text)) return undefined
  const match = ADDRESS.exec(text)
  if (match === null) return undefined
  const [, rawScheme = '', host = '', path = '', query = '', fragment = ''] = match
  const scheme = rawScheme.toLowerCase()
  if (scheme === 'http' || scheme === 'https') {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return undefined
    }
    const labels = parsed.hostname.split('.')
    const last = labels[labels.length - 1]
    if (last === ADDRESS_SUFFIX) return undefined
    if (last !== 'eth') return text
    if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return undefined
    const name = ethName(parsed.hostname)
    return name === undefined ? undefined : httpsUrl(`${name}.${ETH_GATEWAY}`, parsed.pathname, parsed.search, parsed.hash)
  }
  if (scheme !== 'ipfs' && scheme !== 'ipns') return undefined
  const eth = ethName(host)
  if (eth !== undefined) return httpsUrl(`${eth}.${ETH_GATEWAY}`, path, query, fragment)
  if (host.includes('.')) return undefined
  const label = scheme === 'ipfs' ? cidLabel(host) : keyLabel(host)
  return label === undefined ? undefined : httpsUrl(`${label}.${scheme === 'ipfs' ? IPFS_GATEWAY : IPNS_GATEWAY}`, path, query, fragment)
}

/** `webLinkFor`, but only when it says something the address does not already: a web page's own address is what Copy link copies. */
export function webLinkDiffering (address: string): string | undefined {
  const link = webLinkFor(address)
  return link === undefined || link === address.trim() ? undefined : link
}
