// ENSIP-7: a contenthash is a varint protocol code followed by that
// protocol's value, which for IPFS, IPNS and Swarm is a binary CID.

import { varint } from 'multiformats'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { dnsName } from '../resolution/dns-name.js'
import type { ContentPointer } from '../resolution/records.js'

const IPFS_NS = 0xe3
const SWARM_NS = 0xe4
const SWARM_MANIFEST = 0xfa
const KECCAK_256 = 0x1b
const IPNS_NS = 0xe5
const LIBP2P_KEY = 0x72
const IDENTITY = 0x00

const OTHER_PROTOCOLS: ReadonlyMap<number, string> = new Map([
  [0x01bc, 'onion'],
  [0x01bd, 'onion3'],
  [0xb19910, 'skynet'],
  [0xb29910, 'arweave']
])

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

/**
 * A Swarm value is a CID whose multihash is the root chunk's keccak-256
 * address. Whatever codec it carries, the content is self-describing and fully
 * verified, so it is canonicalised to swarm-manifest.
 */
function swarmPointer (value: Uint8Array): ContentPointer {
  const cid = parseCid(value)
  if (cid === undefined || cid.multihash.code !== KECCAK_256 || cid.multihash.digest.length !== 32) return unsupported('swarm (malformed)')
  return { kind: 'swarm', cid: CID.createV1(SWARM_MANIFEST, cid.multihash).toString() }
}

function domainIn (digest: Uint8Array): string | undefined {
  try {
    return dnsName(new TextDecoder('utf-8', { fatal: true }).decode(digest))
  } catch {
    return undefined
  }
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
    const domain = domainIn(cid.multihash.digest)
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
  if (code === SWARM_NS) return swarmPointer(value)
  return unsupported(OTHER_PROTOCOLS.get(code) ?? `0x${code.toString(16)}`)
}
