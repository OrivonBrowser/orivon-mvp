import { describe, expect, it } from 'vitest'
import { createSwarmAddressResolvers } from '../address-resolver.js'
import { isEncryptedReference, parseReference, referenceCid, referenceOfCid } from '../reference.js'
import { SWARM } from '../descriptor.js'
import { swarmProtocol } from '../protocol.js'
import { BUILTIN_ADDRESSES } from '../../builtin.js'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { SWARM_ETH } from './live-vectors.js'
import { fakeSwarm } from './swarm.test-helpers.js'

const REFERENCE = SWARM_ETH.feedManifestRoot
const [resolver] = createSwarmAddressResolvers()

describe('referenceCid', () => {
  it('is a CIDv1 of codec swarm-manifest over keccak-256, 61 characters so it fits one host label', () => {
    const cid = CID.parse(referenceCid(REFERENCE))
    expect(cid.version).toBe(1)
    expect(cid.code).toBe(0xfa)
    expect(cid.multihash.code).toBe(0x1b)
    expect(referenceCid(REFERENCE)).toHaveLength(61)
  })

  it('matches the CID inside the live swarm.eth contenthash', () => {
    const live = SWARM_ETH.contenthash.slice(2 + 4)
    expect(CID.decode(Uint8Array.from(live.match(/../g)!.map((byte) => Number.parseInt(byte, 16)))).toString()).toBe(referenceCid(REFERENCE))
  })
})

describe('parseReference', () => {
  it('reads 64 hex characters in any case, and a CID of any keccak-256 codec', () => {
    expect(parseReference(REFERENCE.toUpperCase())).toBe(REFERENCE)
    expect(parseReference(referenceCid(REFERENCE))).toBe(REFERENCE)
    const raw = CID.createV1(0x55, Digest.create(0x1b, Uint8Array.from(REFERENCE.match(/../g)!.map((byte) => Number.parseInt(byte, 16)))))
    expect(referenceOfCid(raw)).toBe(REFERENCE)
    expect(parseReference(raw.toString())).toBe(REFERENCE)
  })

  it('refuses anything else: a short or long hex, a CID over another hash, a word', () => {
    for (const bad of ['', 'abc', REFERENCE.slice(1), `${REFERENCE}0`, `0x${REFERENCE}`, 'g'.repeat(64), 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', 'swarm.eth']) {
      expect(parseReference(bad), bad).toBeUndefined()
    }
  })

  it('names a 128-character reference as encrypted', () => {
    expect(isEncryptedReference('ab'.repeat(64))).toBe(true)
    expect(isEncryptedReference(REFERENCE)).toBe(false)
    expect(parseReference('ab'.repeat(64))).toBeUndefined()
  })
})

describe('the bzz address resolver', () => {
  const canonical = referenceCid(REFERENCE)

  it('canonicalises any spelling to the CID, which becomes the host label', () => {
    expect(resolver?.canonicalName?.(REFERENCE)).toBe(canonical)
    expect(resolver?.canonicalName?.(REFERENCE.toUpperCase())).toBe(canonical)
    expect(resolver?.canonicalName?.(canonical)).toBe(canonical)
  })

  it('resolves only the canonical spelling, to a record naming the reference by the address itself', async () => {
    expect(await resolver?.resolve(canonical)).toEqual([{ type: 'contenthash', pointer: { kind: 'swarm', cid: canonical }, provenance: { via: 'address' } }])
    await expect(resolver?.resolve(REFERENCE)).rejects.toMatchObject({ failure: 'invalid-name' })
  })

  it('refuses a name that is not a reference, one with a path in it, and an over-long one', async () => {
    for (const bad of ['swarm', 'a/b', 'x'.repeat(300)]) await expect(resolver?.resolve(bad), bad).rejects.toMatchObject({ failure: 'invalid-name' })
  })

  it('says an encrypted reference is unsupported, not malformed', async () => {
    await expect(resolver?.resolve('ab'.repeat(64))).rejects.toMatchObject({ failure: 'unsupported' })
  })
})

describe('the Swarm protocol', () => {
  it('declares the bzz scheme and no top-level domain, and words its loading screen', () => {
    expect(SWARM.schemes).toEqual(['bzz'])
    expect(SWARM.topLevelDomains).toEqual([])
    expect(SWARM.loadingScreen?.title).toBe('Loading from Swarm')
  })

  it('is registered as one resolver and one gatherer', () => {
    const protocol = swarmProtocol({ fetch: fakeSwarm(new Map()).fetch, endpoints: ['https://a.endpoint'], feedIndexes: { highest: () => undefined, record: () => {} } })
    expect(protocol.resolvers.map((r) => r.id)).toEqual(['bzz-address'])
    expect(protocol.gatherers.map((g) => g.id)).toEqual(['swarm'])
  })

  it('is routed by the shell: an address and its served origin', () => {
    const canonical = referenceCid(REFERENCE)
    expect(BUILTIN_ADDRESSES.servedUrl(`bzz://${REFERENCE}/x`)).toBe(`https://bzz.orivon/${REFERENCE}/x`)
    expect(BUILTIN_ADDRESSES.originFor('bzz', canonical)).toBe(`https://${canonical}.bzz.orivon`)
    expect(BUILTIN_ADDRESSES.displayUrl(`https://${canonical}.bzz.orivon/x`)).toBe(`bzz://${canonical}/x`)
  })
})
