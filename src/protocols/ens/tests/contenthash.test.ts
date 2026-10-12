import { describe, expect, it } from 'vitest'
import { varint } from 'multiformats'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { identity } from 'multiformats/hashes/identity'
import { sha256 } from 'multiformats/hashes/sha2'
import * as Digest from 'multiformats/hashes/digest'
import { hexToBytes } from 'viem'
import { decodeContenthash } from '../contenthash.js'
import { referenceCid } from '../../swarm/reference.js'
import { SWARM_ETH } from '../../swarm/tests/live-vectors.js'

const DAG_PB = 0x70
const RAW = 0x55
const LIBP2P_KEY = 0x72
const SWARM_MANIFEST = 0xfa
const KECCAK_256 = 0x1b

function contenthash (protocol: number, value: Uint8Array): Uint8Array {
  const prefix = varint.encodeTo(protocol, new Uint8Array(varint.encodingLength(protocol)))
  const out = new Uint8Array(prefix.length + value.length)
  out.set(prefix)
  out.set(value, prefix.length)
  return out
}

const content = await sha256.digest(new TextEncoder().encode('hello'))
const dagPb = CID.createV1(DAG_PB, content)
// An Ed25519 public key, protobuf-wrapped as libp2p does, is small enough to inline as an identity multihash.
const ed25519Key = identity.digest(new Uint8Array([0x08, 0x01, 0x12, 0x20, ...new Uint8Array(32).fill(7)]))
const keyName = CID.createV1(LIBP2P_KEY, ed25519Key).toString(base36)

describe('decodeContenthash', () => {
  it('reads nothing from an empty contenthash', () => {
    expect(decodeContenthash(new Uint8Array())).toBeUndefined()
  })

  it('decodes ipfs to a CIDv1 string', () => {
    expect(decodeContenthash(contenthash(0xe3, dagPb.bytes))).toEqual({ kind: 'ipfs', cid: dagPb.toString() })
    const raw = CID.createV1(RAW, content)
    expect(decodeContenthash(contenthash(0xe3, raw.bytes))).toEqual({ kind: 'ipfs', cid: raw.toString() })
  })

  it('upgrades a stored CIDv0 to v1', () => {
    const v0 = CID.createV0(content)
    expect(decodeContenthash(contenthash(0xe3, v0.bytes))).toEqual({ kind: 'ipfs', cid: v0.toV1().toString() })
  })

  it('decodes an ipns key to its canonical base36 libp2p-key form', () => {
    expect(decodeContenthash(contenthash(0xe5, CID.createV1(LIBP2P_KEY, ed25519Key).bytes))).toEqual({ kind: 'ipns-key', key: keyName })
  })

  it('canonicalises a key stored under another codec, as older records do', () => {
    const peerId = CID.createV1(DAG_PB, content)
    expect(decodeContenthash(contenthash(0xe5, peerId.bytes))).toEqual({ kind: 'ipns-key', key: CID.createV1(LIBP2P_KEY, content).toString(base36) })
  })

  it('decodes a DNS name in identity-hash form as DNSLink, lowercased', () => {
    const domain = CID.createV1(DAG_PB, identity.digest(new TextEncoder().encode('App.Uniswap.org')))
    expect(decodeContenthash(contenthash(0xe5, domain.bytes))).toEqual({ kind: 'dnslink', domain: 'app.uniswap.org' })
  })

  it('refuses an identity-hash value that is not a DNS name', () => {
    for (const text of ['localhost', 'a..b', '-a.com', 'a b.com', 'x'.repeat(64) + '.com']) {
      const cid = CID.createV1(DAG_PB, identity.digest(new TextEncoder().encode(text)))
      expect(decodeContenthash(contenthash(0xe5, cid.bytes))).toEqual({ kind: 'unsupported', protocol: 'ipns (malformed)' })
    }
    const notUtf8 = CID.createV1(DAG_PB, identity.digest(new Uint8Array([0xff, 0x2e, 0x63])))
    expect(decodeContenthash(contenthash(0xe5, notUtf8.bytes))).toEqual({ kind: 'unsupported', protocol: 'ipns (malformed)' })
  })

  it('names the other protocols as unsupported', () => {
    expect(decodeContenthash(contenthash(0xb29910, new Uint8Array([1, 2])))).toEqual({ kind: 'unsupported', protocol: 'arweave' })
    expect(decodeContenthash(contenthash(0x1234, new Uint8Array([1])))).toEqual({ kind: 'unsupported', protocol: '0x1234' })
  })

  describe('Swarm', () => {
    const reference = new Uint8Array(32).fill(7)
    const cidWith = (codec: number, hashCode = KECCAK_256) => CID.createV1(codec, Digest.create(hashCode, reference))

    it('reads the live swarm.eth value as a swarm CID of that keccak-256 reference', () => {
      expect(decodeContenthash(hexToBytes(SWARM_ETH.contenthash as `0x${string}`))).toEqual({ kind: 'swarm', cid: referenceCid(SWARM_ETH.feedManifestRoot) })
    })

    it('canonicalises whatever codec a value carries, since the content is verified by its hash alone', () => {
      const expected = { kind: 'swarm', cid: cidWith(SWARM_MANIFEST).toString() }
      expect(decodeContenthash(contenthash(0xe4, cidWith(0x03fa).bytes))).toEqual(expected)
      expect(decodeContenthash(contenthash(0xe4, cidWith(RAW).bytes))).toEqual(expected)
    })

    it('refuses a value that is not a keccak-256 CID of 32 bytes', () => {
      expect(decodeContenthash(contenthash(0xe4, new Uint8Array([1, 2])))).toEqual({ kind: 'unsupported', protocol: 'swarm (malformed)' })
      expect(decodeContenthash(contenthash(0xe4, cidWith(SWARM_MANIFEST, 0x12).bytes))).toEqual({ kind: 'unsupported', protocol: 'swarm (malformed)' })
      expect(decodeContenthash(contenthash(0xe4, new Uint8Array([...cidWith(SWARM_MANIFEST).bytes, 0])))).toEqual({ kind: 'unsupported', protocol: 'swarm (malformed)' })
    })
  })

  it('refuses a malformed CID or trailing bytes, never guessing', () => {
    expect(decodeContenthash(contenthash(0xe3, new Uint8Array([1, 2, 3])))).toEqual({ kind: 'unsupported', protocol: 'ipfs (malformed)' })
    expect(decodeContenthash(contenthash(0xe3, new Uint8Array([...dagPb.bytes, 0])))).toEqual({ kind: 'unsupported', protocol: 'ipfs (malformed)' })
    expect(decodeContenthash(contenthash(0xe5, new Uint8Array([9])))).toEqual({ kind: 'unsupported', protocol: 'ipns (malformed)' })
  })

  it('refuses a truncated varint', () => {
    expect(decodeContenthash(new Uint8Array([0xe3]))).toEqual({ kind: 'unsupported', protocol: 'malformed' })
  })
})
