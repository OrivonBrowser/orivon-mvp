import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { MAX_VALUE, pointerOf, recordsOf, slotPointer } from '../answer.js'
import { CONTRACT_KEY, REGISTRY_CONTENT, TEXT_KEYS } from '../pins.js'
import { referenceCid } from '../../swarm/reference.js'

const CID_V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CID_V0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8'
const REFERENCE = 'ab'.repeat(32)
const ARWEAVE = 'A'.repeat(43)
const MAGNET = `magnet:?xt=urn:btih:${'1'.repeat(40)}`

describe('pointerOf', () => {
  it('reads a CID of the ipfs key in any of the forms an address takes, as a CIDv1 in base32', () => {
    const expected = { kind: 'ipfs', cid: CID_V1 }
    expect(pointerOf('ipfs', `ipfs://${CID_V1}`)).toEqual(expected)
    expect(pointerOf('ipfs', `/ipfs/${CID_V1}`)).toEqual(expected)
    expect(pointerOf('ipfs', CID_V1)).toEqual(expected)
    expect(pointerOf('ipfs', `ipfs://${CID_V0}`)).toEqual({ kind: 'ipfs', cid: CID.parse(CID_V0).toV1().toString() })
  })

  it('reads an IPNS key or a DNSLink name of the ipfs key', () => {
    expect(pointerOf('ipfs', `ipns://${IPNS_KEY}`)).toEqual({ kind: 'ipns-key', key: IPNS_KEY })
    expect(pointerOf('ipfs', `/ipns/${IPNS_KEY}`)).toEqual({ kind: 'ipns-key', key: IPNS_KEY })
    expect(pointerOf('ipfs', 'ipns://example.org')).toEqual({ kind: 'dnslink', domain: 'example.org' })
    expect(pointerOf('ipfs', '/ipns/Example.ORG')).toEqual({ kind: 'dnslink', domain: 'example.org' })
  })

  it('reads a Swarm reference of the bzz key as the CID of its root chunk, in either case', () => {
    expect(pointerOf('bzz', `bzz://${REFERENCE.toUpperCase()}`)).toEqual({ kind: 'swarm', cid: referenceCid(REFERENCE) })
    expect(pointerOf('bzz', REFERENCE)).toEqual({ kind: 'swarm', cid: referenceCid(REFERENCE) })
  })

  it('reads exactly one trailing slash after the address as the same address, and nothing after it', () => {
    expect(pointerOf('ipfs', `ipfs://${CID_V1}/`)).toEqual({ kind: 'ipfs', cid: CID_V1 })
    expect(pointerOf('ipfs', `/ipfs/${CID_V1}/`)).toEqual({ kind: 'ipfs', cid: CID_V1 })
    expect(pointerOf('ipfs', `ipns://${IPNS_KEY}/`)).toEqual({ kind: 'ipns-key', key: IPNS_KEY })
    expect(pointerOf('ipfs', `/ipns/${IPNS_KEY}/`)).toEqual({ kind: 'ipns-key', key: IPNS_KEY })
    expect(pointerOf('ipfs', 'ipns://example.org/')).toEqual({ kind: 'dnslink', domain: 'example.org' })
    expect(pointerOf('bzz', `bzz://${REFERENCE}/`)).toEqual({ kind: 'swarm', cid: referenceCid(REFERENCE) })
    for (const value of [`ipfs://${CID_V1}//`, `ipfs://${CID_V1}/ `, `ipfs://${CID_V1}/?x=1`, `ipfs://${CID_V1}/#x`, `/ipfs/${CID_V1}//`, `ipns://${IPNS_KEY}//`, `ipfs:///`, 'ipfs://', '/ipfs//', `/ipfs/${CID_V1}/index.html`]) {
      expect(pointerOf('ipfs', value), value).toBeNull()
    }
    for (const value of [`bzz://${REFERENCE}//`, `bzz://${REFERENCE}/index`, 'bzz:///']) expect(pointerOf('bzz', value), value).toBeNull()
  })

  it('reads a 128-digit (encrypted) Swarm reference as a record this build cannot load, never as no record or as the first half', () => {
    const encrypted = 'ab'.repeat(64)
    expect(pointerOf('bzz', `bzz://${encrypted}`)).toEqual({ kind: 'unsupported', protocol: 'bzz-encrypted' })
    expect(pointerOf('bzz', encrypted.toUpperCase())).toEqual({ kind: 'unsupported', protocol: 'bzz-encrypted' })
    expect(pointerOf('bzz', `bzz://${encrypted}/`)).toEqual({ kind: 'unsupported', protocol: 'bzz-encrypted' })
    for (const value of ['ab'.repeat(63), 'ab'.repeat(65), `${'ab'.repeat(63)}a`, `bzz://${encrypted}/index`, `${REFERENCE}${'zz'.repeat(32)}`]) expect(pointerOf('bzz', value), value).toBeNull()
  })

  it('answers a name with only an encrypted Swarm reference as one record this build cannot load', () => {
    expect(recordsOf({ 'content.bzz': `bzz://${'ab'.repeat(64)}` }, 1).map((record) => record.pointer)).toEqual([{ kind: 'unsupported', protocol: 'bzz-encrypted' }])
  })

  it('reads a well-formed value of every other key as a protocol this build does not load', () => {
    expect(pointerOf('arw', `ar://${ARWEAVE}`)).toEqual({ kind: 'unsupported', protocol: 'arweave' })
    expect(pointerOf('magnet', MAGNET)).toEqual({ kind: 'unsupported', protocol: 'magnet' })
    expect(pointerOf('ethfs', `eth://0x${'ab'.repeat(20)}`)).toEqual({ kind: 'unsupported', protocol: 'ethfs' })
    expect(pointerOf('https', 'https://example.com/app')).toEqual({ kind: 'unsupported', protocol: 'https' })
    expect(pointerOf('http', 'http://example.com')).toEqual({ kind: 'unsupported', protocol: 'http' })
    expect(pointerOf('ddoc', `sha256:${'cd'.repeat(32)}`)).toEqual({ kind: 'unsupported', protocol: 'ddoc' })
    for (const value of [`0x${'ab'.repeat(20)}`, `${'AB'.repeat(20)}`, `web3://0x${'ab'.repeat(20)}`, `0x${'ab'.repeat(20)}:1`]) expect(pointerOf('web3', value), value).toEqual({ kind: 'unsupported', protocol: 'web3' })
  })

  it('leaves out a value that is not well-formed for its type', () => {
    const bad: [string, string][] = [
      ['ipfs', `ipfs://${CID_V1}/path`], ['ipfs', 'ipfs://'], ['ipfs', 'ipns://'], ['ipfs', `ipfs://${CID_V1}?x=1`], ['ipfs', 'ipfs://not-a-cid'], ['ipfs', 'ipns://not a key'], ['ipfs', 'ipns://-bad-.org'],
      ['bzz', 'bzz://abcd'], ['bzz', `bzz://${REFERENCE}/index`], ['bzz', 'abcd'],
      ['arw', `ar://${'A'.repeat(42)}`], ['arw', `ar://${ARWEAVE}/x`],
      ['magnet', 'magnet:?dn=x'], ['magnet', 'https://example.com'],
      ['ethfs', 'eth://0x12'], ['ethfs', `https://0x${'ab'.repeat(20)}`],
      ['https', 'http://example.com'], ['https', 'https://user:pass@example.com'], ['https', 'https://example.com/?q=1'], ['https', 'https://'], ['https', 'https://example.com\\evil.com'],
      ['http', 'https://example.com'],
      ['ddoc', `sha256:${'cd'.repeat(31)}`], ['ddoc', `sha1:${'cd'.repeat(20)}`],
      ['web3', 'example.eth'], ['web3', `0x${'ab'.repeat(20)}:5`], ['web3', `0x${'ab'.repeat(19)}`],
      ['other', 'anything'], ['ipfs', ''], ['ipfs', ` ipfs://${CID_V1}`], ['https', `https://example.com/${'a'.repeat(MAX_VALUE)}`]
    ]
    for (const [type, value] of bad) expect(pointerOf(type, value), `${type} ${value}`).toBeNull()
  })

  it('leaves out a value with anything but visible ASCII', () => {
    for (const value of [`ipfs://${CID_V1}\n`, `ipfs://${CID_V1} `, 'https://exämple.com/', `bzz://${REFERENCE}\u0000`]) {
      expect(pointerOf(value.startsWith('bzz') ? 'bzz' : value.startsWith('ipfs') ? 'ipfs' : 'https', value), value).toBeNull()
    }
  })
})

describe('slotPointer', () => {
  const JSUNBLAZE = '0xc452c1d588b1e9f01a272fee57ff9d29b22d163fbbb4fd8733f6e25a7dcbef34'

  it("turns the 32 bytes of the registry's slot into the CID of the file whose sha2-256 digest they are", () => {
    expect(slotPointer(JSUNBLAZE)).toEqual({ kind: 'ipfs', cid: 'bafybeigekla5lcfr5hybujzp5zl77hjjwiwrmp53wt6yom7w4jnh3s7pgq' })
    expect(slotPointer(`0x${JSUNBLAZE.slice(2).toUpperCase()}`)).toEqual(slotPointer(JSUNBLAZE))
  })

  it('is null for anything that is not 0x and 64 hexadecimal digits: the registry says nothing of what shorter or longer bytes mean', () => {
    for (const value of ['', '0x', JSUNBLAZE.slice(0, -2), `${JSUNBLAZE}00`, JSUNBLAZE.slice(2), `0x${'zz'.repeat(32)}`, ` ${JSUNBLAZE}`]) expect(slotPointer(value), value).toBeNull()
  })
})

describe('recordsOf', () => {
  const SLOT = `0x${'12'.repeat(32)}`
  const FROM_SLOT = { kind: 'ipfs', cid: slotPointer(SLOT)?.cid }
  const provenance = { via: 'chain', block: 26_000_000, offchain: false }

  it('lists the records that counted in the fixed order of the keys, each a contenthash record proven at the block', () => {
    const records = recordsOf({ 'content.https': 'https://example.com/', 'content.ipfs': `ipfs://${CID_V1}`, 'content.bzz': `bzz://${REFERENCE}` }, 26_000_000)
    expect(records).toEqual([
      { type: 'contenthash', pointer: { kind: 'ipfs', cid: CID_V1 }, provenance },
      { type: 'contenthash', pointer: { kind: 'swarm', cid: referenceCid(REFERENCE) }, provenance },
      { type: 'contenthash', pointer: { kind: 'unsupported', protocol: 'https' }, provenance }
    ])
  })

  it('puts an IPFS record before an Arweave one, so a name with both opens the IPFS content', () => {
    const records = recordsOf({ 'content.arw': `ar://${ARWEAVE}`, 'content.ipfs': `ipfs://${CID_V1}` }, 1)
    expect(records.map((record) => record.pointer.kind)).toEqual(['ipfs', 'unsupported'])
  })

  it('answers a name with only an Arweave record as one record this build cannot load, and the contract of a web3:// site the same way', () => {
    expect(recordsOf({ 'content.arw': `ar://${ARWEAVE}` }, 1).map((record) => record.pointer)).toEqual([{ kind: 'unsupported', protocol: 'arweave' }])
    expect(recordsOf({ [CONTRACT_KEY]: `0x${'ab'.repeat(20)}` }, 1).map((record) => record.pointer)).toEqual([{ kind: 'unsupported', protocol: 'web3' }])
  })

  it('answers no records for values that are not addresses', () => {
    expect(recordsOf({ 'content.ipfs': 'not an address', 'content.bzz': '', [CONTRACT_KEY]: 'x' }, 1)).toEqual([])
  })

  it("answers the slot as one ipfs record, after the text records and the contract's, with nothing else when no key counted", () => {
    expect(recordsOf({ [REGISTRY_CONTENT]: SLOT }, 26_000_000)).toEqual([{ type: 'contenthash', pointer: FROM_SLOT, provenance }])
    const records = recordsOf({ [REGISTRY_CONTENT]: SLOT, 'content.https': 'https://example.com/', 'content.ipfs': `ipfs://${CID_V1}`, [CONTRACT_KEY]: `0x${'ab'.repeat(20)}` }, 1)
    expect(records.map((record) => record.pointer)).toEqual([{ kind: 'ipfs', cid: CID_V1 }, { kind: 'unsupported', protocol: 'https' }, { kind: 'unsupported', protocol: 'web3' }, FROM_SLOT])
  })

  it('answers one record, not two, when a text record names the same file as the slot', () => {
    expect(recordsOf({ [REGISTRY_CONTENT]: SLOT, 'content.ipfs': `ipfs://${FROM_SLOT.cid ?? ''}` }, 1)).toHaveLength(1)
  })

  it('leaves out a slot that is not 32 bytes, and keeps every other record', () => {
    expect(recordsOf({ [REGISTRY_CONTENT]: '0x1234', 'content.ipfs': `ipfs://${CID_V1}` }, 1).map((record) => record.pointer)).toEqual([{ kind: 'ipfs', cid: CID_V1 }])
  })

  it('has a record for every key a name can have and the slot after them', () => {
    const byType: Record<string, string> = { ipfs: `ipfs://${CID_V1}`, bzz: `bzz://${REFERENCE}`, arw: `ar://${ARWEAVE}`, magnet: MAGNET, ethfs: `eth://0x${'ab'.repeat(20)}`, https: 'https://example.com/', http: 'http://example.com/', ddoc: `sha256:${'cd'.repeat(32)}` }
    const every = { ...Object.fromEntries(TEXT_KEYS.map(([key, type]) => [key, byType[type]])), [CONTRACT_KEY]: `web3://0x${'ab'.repeat(20)}`, [REGISTRY_CONTENT]: SLOT }
    const records = recordsOf(every, 1)
    expect(records).toHaveLength(TEXT_KEYS.length + 2)
    expect(records.at(-1)?.pointer).toEqual(FROM_SLOT)
  })
})
