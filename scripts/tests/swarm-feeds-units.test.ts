import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, concat, hexToBytes, keccak256, toBytes } from 'viem'
import { describe, expect, it } from 'vitest'
import { GatewayPool } from '../../src/protocols/gateways/gateways.js'
import { bmtRoot as readerBmtRoot, cacAddress as readerCacAddress, feedUpdateAddress, verifySoc } from '../../src/protocols/swarm/chunk.js'
import { resolveFeed } from '../../src/protocols/swarm/feed.js'
import { DEFAULT_LIMITS } from '../../src/protocols/swarm/limits.js'
import { A, fakeSwarm } from '../../src/protocols/swarm/tests/swarm.test-helpers.js'
import { readSettings, UsageError } from '../swarm-feeds.mjs'
import { bmtRoot, buildUpdate, cacAddress, identifierHex, ownerOf, topicOf } from '../swarm-feeds/feed.mjs'
import { bzz, checkPlan, costOf, DAY, FundsError, perChunkFor, planBatches, SpendBudget, SpendCapError, topUpFor, ttlAfterDilution, xdai } from '../swarm-feeds/policy.mjs'
import { parseNames, readSignerKeyFile } from '../swarm-feeds/store.mjs'
import { KEY, OWNER, PLUR } from './swarm-feeds.test-helpers.js'

const hex = (bytes: Uint8Array): string => bytesToHex(bytes).slice(2)

describe('the feed update the job builds, read by the reader Orivon ships', () => {
  const topic = topicOf('explore')
  const reference = '11'.repeat(32)

  it('hashes a chunk the way the reader does, whatever the payload length', () => {
    for (const length of [0, 1, 40, 63, 64, 65, 1000, 4095, 4096]) {
      const payload = Uint8Array.from({ length }, (_, i) => (i * 7 + 3) & 0xff)
      expect(hex(bmtRoot(payload))).toBe(hex(readerBmtRoot(payload)))
      const span = new Uint8Array(8)
      span[0] = length & 0xff
      expect(hex(cacAddress(span, payload))).toBe(hex(readerCacAddress(concat([span, payload]))))
    }
    expect(() => bmtRoot(new Uint8Array(4097))).toThrow(RangeError)
  })

  it('derives the topic from the key name', () => {
    expect(topic).toBe(hex(keccak256(toBytes('orivon-site/explore'), 'bytes')))
    expect(topicOf('latest')).not.toBe(topic)
  })

  it('builds a fixed vector: the same key, topic, index and reference always give these bytes', async () => {
    expect(topic).toBe('23ef2ec458703e9ca13dfda06d9d701e35a9dccc9515f138bc3bc64362d9962d')
    expect(ownerOf(KEY).owner).toBe(OWNER)
    expect(ownerOf(KEY).address).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf')
    const update = await buildUpdate({ privateKey: KEY, topic, index: 3, reference, timestamp: 1_700_000_000 })
    expect(update).toEqual({
      owner: OWNER,
      identifier: 'df1c2d12b1b1b6b1ab23b7ee14ab06a0eb255594672c859f09f62b578890a887',
      signature: 'c6d1572dce1537eda4f7e4f48f0c4a74775cb54f979418c0c7def3ff3d0da429277c836f5fe0da09ae855a5632691cbc9a8ef8820ad96b1335c079b20ff98dc61b',
      data: `2800000000000000000000006553f100${reference}`,
      address: '9b179222f290b7a074084b424c1aaf748be1b984e3260ec77fe502bcad2d2d1d'
    })
    expect(identifierHex(topic, 3)).toBe(update.identifier)
  })

  it('passes the checks the reader applies: address, signature recovers to the owner, reference read back', async () => {
    const chunks = new Map<string, Uint8Array>()
    for (const index of [0, 1, 2]) {
      const update = await buildUpdate({ privateKey: KEY, topic, index, reference: `${String(index + 1)}${'a'.repeat(63)}`, timestamp: 1_700_000_000 + index })
      expect(update.address).toBe(feedUpdateAddress(OWNER, topic, BigInt(index)))
      const chunk = hexToBytes(`0x${update.identifier}${update.signature}${update.data}`)
      expect(await verifySoc(update.address, chunk)).toMatchObject({ owner: OWNER })
      chunks.set(update.address, chunk)
    }
    const resolved = await resolveFeed({ owner: OWNER, topic }, { fetch: fakeSwarm(chunks).fetch, pool: new GatewayPool([A], 6), limits: DEFAULT_LIMITS }, { highest: () => undefined, record: () => {} }, new AbortController().signal, () => {})
    expect(resolved.root).toBe(`3${'a'.repeat(63)}`)
    expect(resolved.step).toMatchObject({ index: 2n })
  })

  it('refuses a reference that is not 64 lowercase hex characters', async () => {
    await expect(buildUpdate({ privateKey: KEY, topic, index: 0, reference: 'AB', timestamp: 1 })).rejects.toThrow(RangeError)
  })
})

describe('names, signer key and settings', () => {
  it('reads one site per line, with comments, blanks and no names allowed, and leaves out the skipped keys', () => {
    const text = '# the sites\n\nexplore explore.orivon.eth  explore.eth # both\nlatest\nweb3score s.orivon.eth\n'
    expect(parseNames(text)).toEqual([{ key: 'explore', names: ['explore.orivon.eth', 'explore.eth'] }, { key: 'latest', names: [] }, { key: 'web3score', names: ['s.orivon.eth'] }])
    expect(parseNames(text, ['latest']).map((site) => site.key)).toEqual(['explore', 'web3score'])
  })
  it('names the line of a key that is not a key name, and of a key listed twice', () => {
    expect(() => parseNames('explore a.eth\n--help x\n')).toThrow(/line 2/)
    expect(() => parseNames('explore a.eth\nexplore b.eth\n')).toThrow(/line 2.*twice/)
  })

  it('refuses a signer key file that group or other can read, and one that is not 64 hex characters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-feeds-key-'))
    try {
      const file = join(dir, 'k')
      writeFileSync(file, `0x${KEY.toUpperCase()}\n`)
      chmodSync(file, 0o644)
      expect(() => readSignerKeyFile(file)).toThrow(/can be read by other users.*chmod 600/)
      chmodSync(file, 0o600)
      expect(readSignerKeyFile(file)).toBe(KEY)
      writeFileSync(file, 'abc')
      expect(() => readSignerKeyFile(file)).toThrow(UsageError)
      expect(() => readSignerKeyFile(join(dir, 'missing'))).toThrow(UsageError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('puts state and the signer key under the XDG folders, the work folder under the temp folder, and requires nothing else', () => {
    const cfg = readSettings({ HOME: '/home/someone' })
    expect(cfg.stateDir).toBe('/home/someone/.local/state/orivon-swarm-feeds')
    expect(cfg.signerKeyFile).toBe('/home/someone/.config/orivon-swarm-feeds/feed-signer.key')
    expect(cfg.workDir).toBe(join(tmpdir(), 'orivon-swarm-feeds'))
    expect(cfg.namesFile).toBeUndefined()
    expect(cfg.beeApi).toBe('http://127.0.0.1:1633')
    expect(cfg.pointer).toMatchObject({ depth: 18, minDays: 120, targetDays: 240, diluteAt: 0.5 })
    expect(cfg.content).toMatchObject({ depth: 22, minDays: 21, targetDays: 35 })
    expect(cfg.rotateAt).toBe(0.75)
    expect(cfg.maxSpend).toBe(100n * PLUR)
    const xdg = readSettings({ HOME: '/h', XDG_STATE_HOME: '/x/state', XDG_CONFIG_HOME: '/x/config', STATE_DIR: undefined })
    expect(xdg.stateDir).toBe('/x/state/orivon-swarm-feeds')
    expect(xdg.signerKeyFile).toBe('/x/config/orivon-swarm-feeds/feed-signer.key')
  })
  it('refuses settings that make no sense', () => {
    expect(() => readSettings({ POINTER_DEPTH: '16' })).toThrow(/POINTER_DEPTH/)
    expect(() => readSettings({ CONTENT_TTL_MIN_DAYS: '40' })).toThrow(/must not be above/)
    expect(() => readSettings({ ROTATE_AT: '2' })).toThrow(UsageError)
    expect(() => readSettings({ MAX_SPEND_BZZ: 'lots' })).toThrow(UsageError)
    expect(() => readSettings({ IPFS_API: 'ssh://-oProxyCommand=x@host' })).toThrow(UsageError)
  })
})

describe('what the batches cost and when they need money', () => {
  const price = 196_236n
  const blocks = (days: number): bigint => BigInt(Math.ceil((days * DAY) / 5))

  it('prices an amount per chunk over every chunk of the batch', () => {
    expect(perChunkFor(35 * DAY, price)).toBe(blocks(35) * price)
    expect(costOf(perChunkFor(240 * DAY, price), 18)).toBe(blocks(240) * price * 2n ** 18n)
    expect(bzz(10n ** 16n * 21n + 5n * 10n ** 12n)).toBe('21.0005 xBZZ')
    expect(xdai(1_500_000_000_000_000_000n)).toBe('1.5000 xDAI')
  })
  it('tops a batch up to its target only once it is under its minimum', () => {
    const limits = { minDays: 21, targetDays: 35 }
    expect(topUpFor({ ttl: 21 * DAY, depth: 22 }, limits, price)).toBeNull()
    expect(topUpFor({ ttl: Infinity, depth: 22 }, limits, price)).toBeNull()
    const top = topUpFor({ ttl: 10 * DAY, depth: 22 }, limits, price)
    expect(top?.seconds).toBe(25 * DAY)
    expect(top?.perChunk).toBe(blocks(25) * price)
    expect(top?.cost).toBe(blocks(25) * price * 2n ** 22n)
    expect(topUpFor({ ttl: -1, depth: 22 }, limits, price)?.seconds).toBe(35 * DAY)
  })
  it('halves the life of a batch for each level of dilution', () => {
    expect(ttlAfterDilution(240 * DAY, 1)).toBe(120 * DAY)
    expect(ttlAfterDilution(240 * DAY, 2)).toBe(60 * DAY)
  })

  const cfg = { pointer: { depth: 18, minDays: 120, targetDays: 240, diluteAt: 0.5 }, content: { depth: 22, minDays: 21, targetDays: 35 }, rotateAt: 0.75, waitMs: 20 * 60_000, settleMs: 30 * 60_000 }
  const now = Date.parse('2026-10-27T12:00:00Z')
  const stamp = (over: object) => ({ found: true, usable: true, depth: 18, fill: 0.1, ttl: 200 * DAY, ...over })
  const held = { pointer: { id: 'p', boughtAt: '2026-09-01T00:00:00Z' }, content: { id: 'c', boughtAt: '2026-09-01T00:00:00Z' } }
  const plan = (seen: object, over: object = {}) => planBatches({ cfg, held: { ...held, ...over } as never, seen: seen as never, price, now }).map((step) => `${step.op} ${step.role}`)

  it('buys what is missing and leaves healthy batches alone', () => {
    expect(plan({ pointer: null, content: null }, { pointer: null, content: null })).toEqual(['buy pointer', 'buy content'])
    expect(plan({ pointer: stamp({}), content: stamp({ depth: 22, ttl: 30 * DAY }) })).toEqual([])
  })
  it('dilutes the pointer batch at half full, and tops it up if that leaves it under its minimum', () => {
    expect(plan({ pointer: stamp({ fill: 0.5, ttl: 240 * DAY }), content: stamp({ depth: 22 }) })).toEqual(['dilute pointer'])
    expect(plan({ pointer: stamp({ fill: 0.5, ttl: 200 * DAY }), content: stamp({ depth: 22 }) })).toEqual(['dilute pointer', 'topup pointer'])
    expect(plan({ pointer: stamp({ ttl: 100 * DAY }), content: stamp({ depth: 22 }) })).toEqual(['topup pointer'])
  })
  it('rotates the content batch at three quarters full instead of topping it up', () => {
    expect(plan({ pointer: stamp({}), content: stamp({ depth: 22, fill: 0.75, ttl: 5 * DAY }) })).toEqual(['rotate content'])
    expect(plan({ pointer: stamp({}), content: stamp({ depth: 22, fill: 0.74, ttl: 5 * DAY }) })).toEqual(['topup content'])
  })
  it('replaces a batch that is gone, but waits for one that was bought a moment ago or is not usable yet', () => {
    expect(plan({ pointer: { found: false }, content: stamp({ depth: 22 }) })).toEqual(['buy pointer'])
    const fresh = { ...held, pointer: { id: 'p', boughtAt: new Date(now - 5 * 60_000).toISOString() } }
    expect(plan({ pointer: { found: false }, content: stamp({ depth: 22 }) }, fresh)).toEqual([])
    expect(plan({ pointer: stamp({ usable: false }), content: stamp({ depth: 22 }) })).toEqual([])
  })
  it('leaves a batch alone for a while after it was topped up or diluted, because the node shows the old numbers until the chain event is read', () => {
    const changed = { ...held, pointer: { id: 'p', boughtAt: '2026-09-01T00:00:00Z', changedAt: new Date(now - 60_000).toISOString() } }
    expect(plan({ pointer: stamp({ ttl: 10 * DAY, fill: 0.9 }), content: stamp({ depth: 22 }) }, changed)).toEqual([])
  })

  it('refuses a spend that takes the run over its limit, and counts what it allows', () => {
    const budget = new SpendBudget(10n * PLUR)
    budget.charge(6n * PLUR, 'buy')
    expect(budget.allows(4n * PLUR)).toBe(true)
    expect(() => { budget.charge(4n * PLUR + 1n, 'top up the pointer batch') }).toThrow(SpendCapError)
    expect(() => { budget.charge(4n * PLUR + 1n, 'top up the pointer batch') }).toThrow(/MAX_SPEND_BZZ/)
    expect(budget.spent).toBe(6n * PLUR)
  })
  it('refuses a whole plan the wallet or the limit cannot pay for, before any of it is done', () => {
    const wallet = { address: '0xBee', bzz: 30n * PLUR, xdai: 10n ** 18n }
    const steps = [{ op: 'buy', cost: 21n * PLUR }, { op: 'buy', cost: 50n * PLUR }]
    expect(() => { checkPlan({ plan: steps, wallet, budget: new SpendBudget(100n * PLUR), minXdai: 10n ** 16n }) }).toThrow(/fund 0xBee with xBZZ/)
    expect(() => { checkPlan({ plan: steps, wallet, budget: new SpendBudget(60n * PLUR), minXdai: 10n ** 16n }) }).toThrow(SpendCapError)
    expect(() => { checkPlan({ plan: [{ op: 'buy', cost: 1n }], wallet: { ...wallet, xdai: 0n }, budget: new SpendBudget(PLUR), minXdai: 10n ** 16n }) }).toThrow(FundsError)
    expect(() => { checkPlan({ plan: [], wallet: { ...wallet, bzz: 0n, xdai: 0n }, budget: new SpendBudget(0n), minXdai: 10n ** 16n }) }).not.toThrow()
  })
})
