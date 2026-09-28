import { describe, expect, it } from 'vitest'
import { CID } from 'multiformats/cid'
import { base36 } from 'multiformats/bases/base36'
import { ResolutionError } from '../../resolution/records.js'
import { createIpfsAddressResolvers } from '../address-resolver.js'

const V1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const V0 = CID.parse(V1).toV0().toString()
const KEY = 'k51qzi5uqu5dipklqpo2uq7advlajxx5wxob0mwyqbxb5zu4htblc4bjipy834'
const [ipfs, ipns] = createIpfsAddressResolvers()
if (ipfs === undefined || ipns === undefined) throw new Error('two resolvers expected')

describe('the ipfs:// resolver', () => {
  it('answers only ipfs:, and spells every CID as its base32 CIDv1', () => {
    expect(ipfs.namespaces).toEqual(['ipfs:'])
    expect(ipfs.canonicalName?.(V0)).toBe(V1)
    expect(ipfs.canonicalName?.(CID.parse(V1).toString(base36))).toBe(V1)
  })

  it('resolves a canonical CID to itself, proven by the address, with nothing looked up', async () => {
    expect(await ipfs.resolve(V1)).toEqual([{ type: 'contenthash', pointer: { kind: 'ipfs', cid: V1 }, provenance: { via: 'address' } }])
  })

  it('refuses a second spelling, and anything that is not a CID', async () => {
    await expect(ipfs.resolve(CID.parse(V1).toString(base36))).rejects.toMatchObject({ failure: 'invalid-name' })
    await expect(ipfs.resolve('docs.ipfs.tech')).rejects.toMatchObject({ failure: 'invalid-name' })
    expect(() => ipfs.canonicalName?.('nope')).toThrow(ResolutionError)
    expect(() => ipfs.canonicalName?.(`${V1}/sub`)).toThrow(ResolutionError)
  })
})

describe('the ipns:// resolver', () => {
  it('answers only ipns:, spelling a key in base36 and a DNSLink name lowercased', () => {
    expect(ipns.namespaces).toEqual(['ipns:'])
    expect(ipns.canonicalName?.(KEY)).toBe(KEY)
    expect(ipns.canonicalName?.('Docs.IPFS.tech')).toBe('docs.ipfs.tech')
  })

  it('resolves a key to a signed IPNS record to follow, and a DNS name to a DNSLink', async () => {
    expect(await ipns.resolve(KEY)).toEqual([{ type: 'contenthash', pointer: { kind: 'ipns-key', key: KEY }, provenance: { via: 'address' } }])
    expect(await ipns.resolve('docs.ipfs.tech')).toEqual([{ type: 'contenthash', pointer: { kind: 'dnslink', domain: 'docs.ipfs.tech' }, provenance: { via: 'address' } }])
  })

  it('refuses a name that is neither', async () => {
    await expect(ipns.resolve('localhost')).rejects.toMatchObject({ failure: 'invalid-name' })
  })
})
