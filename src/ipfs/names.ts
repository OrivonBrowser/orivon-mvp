// The names an IPNS or DNSLink value can hold, parsed into one canonical
// form each, or refused.

import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { base58btc } from 'multiformats/bases/base58'
import * as Digest from 'multiformats/hashes/digest'
import type { MultihashDigest } from 'multiformats/hashes/interface'

const LIBP2P_KEY = 0x72
const DNS_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

export type PathTarget =
  | { readonly kind: 'ipfs', readonly cid: CID }
  | { readonly kind: 'ipns-key', readonly key: string }
  | { readonly kind: 'dnslink', readonly domain: string }

/** A key as a CIDv1 libp2p-key in base36, whichever of its forms it came in. */
export function canonicalKey (name: string): string | undefined {
  let multihash: MultihashDigest | undefined
  try {
    multihash = CID.parse(name, name.startsWith('k') ? base36 : undefined).multihash
  } catch {
    try {
      // A bare base58 peer ID ("12D3Koo...", "Qm..."), which has no multibase prefix.
      multihash = Digest.decode(base58btc.baseDecode(name))
    } catch {
      return undefined
    }
  }
  return CID.createV1(LIBP2P_KEY, multihash).toString(base36)
}

export function dnsName (name: string): string | undefined {
  const lower = name.toLowerCase()
  const labels = lower.split('.')
  if (lower.length > 253 || labels.length < 2 || !labels.every((l) => DNS_LABEL.test(l))) return undefined
  return lower
}

/**
 * `/ipfs/<cid>`, `/ipns/<key>` or `/ipns/<domain>`. A path after the name is
 * refused rather than followed: a site root inside another DAG is not
 * something this build serves.
 */
export function parseContentPath (value: string): PathTarget | undefined {
  const match = /^\/(ipfs|ipns)\/([^/]+)\/?$/.exec(value.trim())
  if (match === null) return undefined
  const [, namespace, name] = match as unknown as [string, 'ipfs' | 'ipns', string]
  if (namespace === 'ipfs') {
    try {
      return { kind: 'ipfs', cid: CID.parse(name) }
    } catch {
      return undefined
    }
  }
  if (name.includes('.')) {
    const domain = dnsName(name)
    return domain === undefined ? undefined : { kind: 'dnslink', domain }
  }
  const key = canonicalKey(name)
  return key === undefined ? undefined : { kind: 'ipns-key', key }
}
