import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { hexToBytes } from 'viem'
import { parseContentPath } from '../ipfs/names.js'
import type { ContentPointer, NameRecord } from '../resolution/records.js'
import { referenceCid } from '../swarm/reference.js'
import { CONTRACT_KEY, REGISTRY_CONTENT, TEXT_KEYS } from './pins.js'

// What a `.og` name's counted records become on this build: one `contenthash` record each, in the fixed order of the keys, then the
// registry's own `content` slot. A record whose content this build loads (IPFS, IPNS, DNSLink, Swarm) is a pointer; one it does not
// (Arweave, a magnet link, EthFS, a web address, a DDOC bundle, a contract's web3:// site) is an `unsupported` pointer naming its
// protocol, so a name with only such a record says so, and a name with an IPFS record opens that one. A value that is not a
// well-formed address of its kind is no record. Every value is read again by the gatherer that loads it: nothing here is trusted.

/** The longest value read: the registry stores any length, and a longer one is no address. */
export const MAX_VALUE = 2048

const NOT_VISIBLE_ASCII = /[^\x21-\x7e]/
const HEX_64 = /^[0-9a-fA-F]{64}$/
/** A reference to encrypted content: the chunk's address and the key to decrypt it. */
const HEX_128 = /^[0-9a-fA-F]{128}$/
const ARWEAVE_ID = /^[A-Za-z0-9_-]{43}$/
const BUNDLE_HASH = /^sha256:[0-9a-f]{64}$/
const ETHFS_ADDRESS = /^eth:\/\/0x[0-9a-fA-F]{40}$/
const CONTRACT_ADDRESS = /^(?:web3:\/\/)?(?:0x)?[0-9a-fA-F]{40}(?::1)?$/
const SLOT = /^0x[0-9a-fA-F]{64}$/
const SHA2_256 = 0x12
const DAG_PB = 0x70

/**
 * What follows `prefix` or `slashed` in `value`, or the whole value when it carries neither, without one trailing slash
 * (`ipfs://<cid>/` is the address `ipfs://<cid>` names); a path, query or fragment gives nothing.
 */
function rootOf (value: string, prefix: string, slashed?: string): string | null {
  let rest = value
  if (value.startsWith(prefix)) rest = value.slice(prefix.length)
  else if (slashed !== undefined && value.startsWith(slashed)) rest = value.slice(slashed.length)
  if (rest.endsWith('/')) rest = rest.slice(0, -1)
  return rest === '' || /[/?#]/.test(rest) ? null : rest
}

function webAddress (scheme: 'https' | 'http', value: string): boolean {
  if (!value.startsWith(`${scheme}://`) || /[?#\\]/.test(value)) return false
  const authority = value.slice(scheme.length + 3).split('/')[0] ?? ''
  if (authority === '' || authority.includes('@')) return false
  try {
    const url = new URL(value)
    return url.protocol === `${scheme}:` && url.hostname !== '' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/** The IPFS side of the `content.ipfs` key: a CID, an IPNS key or a DNSLink name, in any of the forms an address takes. */
function ipfsPointer (value: string): ContentPointer | null {
  const isIpns = value.startsWith('ipns://') || value.startsWith('/ipns/')
  const name = isIpns ? rootOf(value, 'ipns://', '/ipns/') : rootOf(value, 'ipfs://', '/ipfs/')
  if (name === null) return null
  const target = parseContentPath(`/${isIpns ? 'ipns' : 'ipfs'}/${name}`)
  if (target === undefined) return null
  switch (target.kind) {
    case 'ipfs': return { kind: 'ipfs', cid: target.cid.toString() }
    case 'ipns-key': return { kind: 'ipns-key', key: target.key }
    case 'dnslink': return { kind: 'dnslink', domain: target.domain }
  }
}

/** The pointer of a text record `value` of a listed `type`, or null when it is not a well-formed one. */
export function pointerOf (type: string, value: string): ContentPointer | null {
  if (value === '' || value.length > MAX_VALUE || NOT_VISIBLE_ASCII.test(value)) return null
  switch (type) {
    case 'ipfs': return ipfsPointer(value)
    case 'bzz': {
      const reference = rootOf(value, 'bzz://')
      if (reference === null) return null
      if (HEX_128.test(reference)) return { kind: 'unsupported', protocol: 'bzz-encrypted' }
      return HEX_64.test(reference) ? { kind: 'swarm', cid: referenceCid(reference.toLowerCase()) } : null
    }
    case 'arw': {
      const id = rootOf(value, 'ar://')
      return id !== null && ARWEAVE_ID.test(id) ? { kind: 'unsupported', protocol: 'arweave' } : null
    }
    case 'magnet': return /^magnet:\?(?:.*&)?xt=urn:bt[im]h:/i.test(value) ? { kind: 'unsupported', protocol: 'magnet' } : null
    case 'ethfs': return ETHFS_ADDRESS.test(value) ? { kind: 'unsupported', protocol: 'ethfs' } : null
    case 'https': case 'http': return webAddress(type, value) ? { kind: 'unsupported', protocol: type } : null
    case 'ddoc': return BUNDLE_HASH.test(value) ? { kind: 'unsupported', protocol: 'ddoc' } : null
    case 'web3': return CONTRACT_ADDRESS.test(value) ? { kind: 'unsupported', protocol: 'web3' } : null
    default: return null
  }
}

/**
 * The pointer the registry's `content` slot stands for: its 32 bytes read as the sha2-256 digest of a dag-pb node, which is how the names that
 * use the slot write it (a directory or file added to IPFS). The slot holds no type, so this is the one reading: a value that is anything else
 * names a file no one serves and fails to load; it can never open another site.
 */
export function slotPointer (value: string): { readonly kind: 'ipfs', readonly cid: string } | null {
  return SLOT.test(value) ? { kind: 'ipfs', cid: CID.createV1(DAG_PB, Digest.create(SHA2_256, hexToBytes(value as `0x${string}`))).toString() } : null
}

/** Every key an answer is read from, with the type its value is read as: the content keys, then the contract's. */
const ANSWERED: readonly (readonly [string, string])[] = Object.freeze([...TEXT_KEYS, [CONTRACT_KEY, 'web3'] as const])

/**
 * @param counted the values of the keys that counted, by text key, and the registry's slot under `REGISTRY_CONTENT`
 * @param block the block they were read at
 */
export function recordsOf (counted: Readonly<Record<string, string | null | undefined>>, block: number): NameRecord[] {
  const records: NameRecord[] = []
  const add = (pointer: ContentPointer): void => { records.push({ type: 'contenthash', pointer, provenance: { via: 'chain', block, offchain: false } }) }
  for (const [key, type] of ANSWERED) {
    const raw = counted[key]
    const pointer = typeof raw === 'string' ? pointerOf(type, raw) : null
    if (pointer !== null) add(pointer)
  }
  const slot = counted[REGISTRY_CONTENT]
  const fromSlot = typeof slot === 'string' ? slotPointer(slot) : null
  if (fromSlot !== null && !records.some((one) => one.pointer.kind === 'ipfs' && one.pointer.cid === fromSlot.cid)) add(fromSlot)
  return records
}
