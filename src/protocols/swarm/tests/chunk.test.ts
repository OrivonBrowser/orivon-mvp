import { describe, expect, it } from 'vitest'
import { bytesToHex, hexToBytes } from 'viem'
import { bmtRoot, cacAddress, feedUpdateAddress, readSpan, verifyCac, verifySoc } from '../chunk.js'
import { bmtRoot as referenceBmtRoot, buildFile, chunkAddress, feedSocAddress, legacyUpdate, makeChunk, signFeedUpdate, spanBytes } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { SWARM_ETH } from './live-vectors.js'
import { TEST_KEY, TOPIC } from './swarm.test-helpers.js'

const live = (address: string): Uint8Array => hexToBytes(`0x${SWARM_ETH.chunks[address]!}`)
const hex = (data: Uint8Array): string => bytesToHex(data).slice(2)

describe('bmtRoot', () => {
  it('agrees with the full zero-padded tree for every payload length that changes the tree', () => {
    for (const length of [0, 1, 31, 32, 33, 63, 64, 65, 127, 128, 129, 2047, 2048, 2049, 4000, 4095, 4096]) {
      const payload = Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 255)
      expect(hex(bmtRoot(payload)), `${String(length)} bytes`).toBe(hex(referenceBmtRoot(payload)))
    }
  })

  it('refuses a payload over a chunk', () => {
    expect(() => bmtRoot(new Uint8Array(4097))).toThrow(RangeError)
  })
})

describe('content-addressed chunks, against chunks served by a public gateway', () => {
  it('hashes each live chunk to the address it was fetched by', () => {
    for (const address of Object.keys(SWARM_ETH.chunks)) {
      if (address === SWARM_ETH.socAddress) continue
      expect(hex(cacAddress(live(address))), address).toBe(address)
      expect(verifyCac(address, live(address))).toBe(true)
    }
  })

  it('refuses a chunk with one bit changed, one byte missing, or none at all', () => {
    const address = SWARM_ETH.feedManifestRoot
    const chunk = live(address)
    const flipped = new Uint8Array(chunk)
    flipped[100] = flipped[100]! ^ 1
    expect(verifyCac(address, flipped)).toBe(false)
    expect(verifyCac(address, chunk.subarray(0, chunk.length - 1))).toBe(false)
    expect(verifyCac(address, new Uint8Array())).toBe(false)
    expect(verifyCac(address, new Uint8Array(4105))).toBe(false)
  })

  it('addresses a chunk whose span is changed differently, since the span is hashed too', () => {
    const chunk = new Uint8Array(live(SWARM_ETH.siteRoot))
    chunk[0] = chunk[0]! ^ 1
    expect(verifyCac(SWARM_ETH.siteRoot, chunk)).toBe(false)
  })

  it('reads the redundancy level out of the live erasure-coded root', () => {
    const root = live(SWARM_ETH.indexHtml.reference)
    expect(Array.from(root.subarray(0, 8))).toEqual([0x06, 0x1d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x81])
    expect(readSpan(root)).toEqual({ size: SWARM_ETH.indexHtml.span, level: SWARM_ETH.indexHtml.level })
    const refs = (root.length - 8) / 32
    expect(refs).toBe(SWARM_ETH.indexHtml.dataRefs + SWARM_ETH.indexHtml.parityRefs)
  })
})

describe('readSpan', () => {
  it('reads a plain span, and a level only from a top byte over 128', () => {
    expect(readSpan(spanBytes(4096))).toEqual({ size: 4096, level: 0 })
    expect(readSpan(spanBytes(70_000, 2))).toEqual({ size: 70_000, level: 2 })
    expect(readSpan(spanBytes(0))).toEqual({ size: 0, level: 0 })
  })

  it('refuses a size no file can have, and a level that does not exist', () => {
    const huge = new Uint8Array(8)
    huge[6] = 0x40
    expect(() => readSpan(huge)).toThrow(/size no file/)
    const level = spanBytes(10)
    level[7] = 128 + 9
    expect(() => readSpan(level)).toThrow(/redundancy level/)
    const flagOnly = spanBytes(10)
    flagOnly[7] = 128
    expect(() => readSpan(flagOnly)).toThrow(/size no file/)
  })

  it('refuses a size just over the largest exact integer', () => {
    const span = new Uint8Array(8)
    new DataView(span.buffer).setBigUint64(0, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true)
    expect(() => readSpan(span)).toThrow()
  })
})

describe('single-owner chunks', () => {
  it('recovers the live feed owner from the live update and finds the legacy payload inside', async () => {
    const soc = await verifySoc(SWARM_ETH.socAddress, live(SWARM_ETH.socAddress))
    expect(soc?.owner).toBe(SWARM_ETH.feedOwner)
    expect(readSpan(soc!.wrapped).size).toBe(40)
    expect(hex(soc!.wrapped.subarray(16))).toBe(SWARM_ETH.siteRoot)
  })

  it('has the address the feed rule gives for the live index', () => {
    expect(feedUpdateAddress(SWARM_ETH.feedOwner, SWARM_ETH.feedTopic, BigInt(SWARM_ETH.feedIndex))).toBe(SWARM_ETH.socAddress)
    expect(feedSocAddress(SWARM_ETH.feedOwner, SWARM_ETH.feedTopic, SWARM_ETH.feedIndex)).toBe(SWARM_ETH.socAddress)
  })

  it('refuses the live update under any other address, and with any byte changed', async () => {
    const chunk = live(SWARM_ETH.socAddress)
    expect(await verifySoc(SWARM_ETH.feedManifestRoot, chunk)).toBeUndefined()
    for (const at of [3, 40, 90, 120, chunk.length - 1]) {
      const changed = new Uint8Array(chunk)
      changed[at] = changed[at]! ^ 1
      expect(await verifySoc(SWARM_ETH.socAddress, changed), String(at)).toBeUndefined()
    }
    expect(await verifySoc(SWARM_ETH.socAddress, chunk.subarray(0, 100))).toBeUndefined()
  })

  it('accepts an update the encoder signed, and refuses one signed by someone else under the owner address', async () => {
    const wrapped = legacyUpdate('cd'.repeat(32))
    const own = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 3, wrapped })
    expect((await verifySoc(own.address, own.chunk))?.owner).toBe(own.owner)
    const stranger = await signFeedUpdate({ privateKey: `0x${'22'.repeat(32)}`, topic: TOPIC, index: 3, wrapped })
    expect(await verifySoc(own.address, stranger.chunk)).toBeUndefined()
  })

  it('addresses the wrapped chunk it carries, whatever its size', async () => {
    const wrapped = makeChunk(spanBytes(5), new TextEncoder().encode('hello'))
    const update = await signFeedUpdate({ privateKey: TEST_KEY, topic: TOPIC, index: 0, wrapped })
    expect(hex(cacAddress((await verifySoc(update.address, update.chunk))!.wrapped))).toBe(chunkAddress(wrapped))
  })
})

describe('files as the encoder stores them', () => {
  it('addresses every stored chunk by the rule', () => {
    const store = new Map<string, Uint8Array>()
    buildFile(new Uint8Array(9000).fill(5), store)
    for (const [address, chunk] of store) expect(verifyCac(address, chunk)).toBe(true)
  })
})
