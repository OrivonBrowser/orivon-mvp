import { describe, expect, it } from 'vitest'
import { addressTopic, evaluateFreshness, idTopic, nameLogsOf } from '../freshness.js'
import type { LogLike, NameReads } from '../freshness.js'
import { inspectOg } from '../lookup.js'
import { ZERO_ADDRESS, ZERO_WORD, hashOf } from '../hex.js'
import { keyOf } from '../name.js'
import { IMPLEMENTATION, PROXY, REGISTRY, TOPICS, UPGRADES, WRAPPER } from '../pins.js'
import { CENSUS_FORMAT } from '../census.js'
import { createSession } from '../tail.js'
import { fakeChain } from './world.js'
import type { World } from './world.js'

// The cases of the rule that no live name shows, built by hand: a name the wrapper holds with no token behind it.

const HOLDER = '0xA1A1a1a1A1A1A1A1A1a1a1a1a1a1A1A1a1A1a1a1'
const VALUE = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const KEY = keyOf('strandedname')

const reads = (overrides: Partial<NameReads> = {}): NameReads => ({
  registryOwner: HOLDER, nameToId: 0n, idToName: null, ownerOf: null, controller: ZERO_ADDRESS, registryContent: ZERO_WORD, values: { 'content.ipfs': VALUE }, ...overrides
})
const logs = (found: LogLike[]): ReturnType<typeof nameLogsOf> => nameLogsOf(found, [])
const changed = (blockNumber: number): LogLike => ({ blockNumber, logIndex: 0, topics: [TOPICS.changed, KEY] })
const written = (blockNumber: number): LogLike => ({ blockNumber, logIndex: 0, topics: [TOPICS.setTextRecord, KEY, hashOf('content.ipfs'), hashOf(VALUE)] })

describe('a name the wrapper holds with no token behind it', () => {
  const stranded = (overrides: Partial<NameReads> = {}): NameReads => reads({ registryOwner: WRAPPER, ...overrides })

  it('counts no text key, though the controller is none and the latest log of the key came after the last change of holder', () => {
    const verdict = evaluateFreshness(KEY, stranded(), logs([changed(100), written(200)]))
    expect(verdict.stranded).toBe(true)
    expect(verdict.records).toEqual([])
    expect(verdict.keys['content.ipfs']).toMatchObject({ counts: false, reason: 'holder-is-the-wrapper-with-no-token' })
  })

  it('counts no text key when the controller is the wrapper itself', () => {
    const verdict = evaluateFreshness(KEY, stranded({ controller: WRAPPER }), logs([changed(100), written(200)]))
    expect(verdict.records).toEqual([])
  })

  it('counts no text key when the wrapper holds a token for another name', () => {
    const verdict = evaluateFreshness(KEY, stranded({ nameToId: 7n, idToName: `0x${'11'.repeat(32)}`, ownerOf: HOLDER }), logs([changed(100), written(200)]))
    expect(verdict.stranded).toBe(true)
    expect(verdict.records).toEqual([])
  })

  it('counts the same record for a name an account holds, so the case above is the stranding and nothing else', () => {
    const verdict = evaluateFreshness(KEY, reads(), logs([changed(100), written(200)]))
    expect(verdict.stranded).toBe(false)
    expect(verdict.records).toEqual(['content.ipfs'])
  })

  it('counts a name whose token the wrapper holds for it, as a name of its holder', () => {
    const verdict = evaluateFreshness(KEY, stranded({ nameToId: 7n, idToName: KEY, ownerOf: HOLDER }), {
      ...logs([written(200)]), wrapperTransfers: [{ blockNumber: 100, logIndex: 0, topics: [TOPICS.transfer, ZERO_WORD, addressTopic(HOLDER), idTopic(7n)] }]
    })
    expect(verdict.stranded).toBe(false)
    expect(verdict.records).toEqual(['content.ipfs'])
  })

  it('is answered with no record', async () => {
    const world: World = {
      head: 26_500_000,
      names: { strandedname: { registryOwner: WRAPPER, nameToId: '0', idToName: ZERO_WORD, ownerOf: null, controller: ZERO_ADDRESS, values: { 'content.ipfs': VALUE } } },
      logs: [
        { address: REGISTRY, blockNumber: 26_499_000, logIndex: 0, topics: [TOPICS.changed, KEY] },
        { address: PROXY, blockNumber: 26_499_500, logIndex: 0, topics: [TOPICS.setTextRecord, KEY, hashOf('content.ipfs'), hashOf(VALUE)] }
      ],
      implementation: IMPLEMENTATION
    }
    const census = { format: CENSUS_FORMAT, block: 26_498_000, blockHash: ZERO_WORD, implementation: IMPLEMENTATION, upgrades: [...UPGRADES], names: {} }
    const { chain, asked } = fakeChain(world)
    const found = await inspectOg(chain, 'strandedname', { session: createSession(), census })
    expect(found.refusal).toBeNull()
    expect(found.verdict?.records).toEqual([])
    // Whatever the logs say, nothing counts: the history is not read.
    expect(asked.logs).toEqual([])
  })
})
