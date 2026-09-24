// ENSIP-7: a contenthash is a varint protocol code followed by that
// protocol's value, which for IPFS and IPNS is a binary CID.

import { varint } from 'multiformats'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import type { ContentPointer } from '../resolution/records.js'

const IPFS_NS = 0xe3
const IPNS_NS = 0xe5
const LIBP2P_KEY = 0x72
const IDENTITY = 0x00

const OTHER_PROTOCOLS: ReadonlyMap<number, string> = new Map([
  [0xe4, 'swarm'],
  [0x01bc, 'onion'],
  [0x01bd, 'onion3'],
  [0xb19910, 'skynet'],
  [0xb29910, 'arweave']
])

/** Letters, digits and inner hyphens, 1-63 per label, two labels at least. */
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const MAX_DNS_NAME = 253

function unsupported (protocol: string): ContentPointer {
  return { kind: 'unsupported', protocol }
}

function parseCid (bytes: Uint8Array): CID | undefined {
  try {
    return CID.decode(bytes)
  } catch {
    return undefined
  }
}

function dnsName (digest: Uint8Array): string | undefined {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(digest).toLowerCase()
  } catch {
    return undefined
  }
  const labels = text.split('.')
  if (text.length > MAX_DNS_NAME || labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) return undefined
  return text
}

/**
 * An IPNS value is a key, or (in identity-hash form, under any codec but
 * libp2p-key) a DNS name to follow through DNSLink. A key is returned in its
 * canonical form, a CIDv1 libp2p-key in base36, whatever form it was stored in.
 */
function ipnsPointer (value: Uint8Array): ContentPointer {
  const cid = parseCid(value)
  if (cid === undefined) return unsupported('ipns (malformed)')
  if (cid.multihash.code === IDENTITY && cid.code !== LIBP2P_KEY) {
    const domain = dnsName(cid.multihash.digest)
    return domain === undefined ? unsupported('ipns (malformed)') : { kind: 'dnslink', domain }
  }
  return { kind: 'ipns-key', key: CID.createV1(LIBP2P_KEY, cid.multihash).toString(base36) }
}

/** `undefined` for an empty contenthash, which means no record. */
export function decodeContenthash (bytes: Uint8Array): ContentPointer | undefined {
  if (bytes.length === 0) return undefined
  let code: number
  let offset: number
  try {
    [code, offset] = varint.decode(bytes)
  } catch {
    return unsupported('malformed')
  }
  const value = bytes.subarray(offset)
  if (code === IPFS_NS) {
    const cid = parseCid(value)
    return cid === undefined ? unsupported('ipfs (malformed)') : { kind: 'ipfs', cid: cid.toV1().toString() }
  }
  if (code === IPNS_NS) return ipnsPointer(value)
  return unsupported(OTHER_PROTOCOLS.get(code) ?? `0x${code.toString(16)}`)
}
