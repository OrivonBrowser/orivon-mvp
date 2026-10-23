import { describe, expect, it } from 'vitest'
import { DEFAULT_BEACON_APIS, DEFAULT_CONSENSUS_RPC, NotFoundAnswer as ScriptNotFound, agreedCheckpoint } from '../refresh-eth-checkpoint.mjs'
import { MalformedAnswer, NotFoundAnswer, fetchAgreedCheckpoint } from '../../src/main/verifier/checkpoint-fetch.js'
import { DEFAULT_ENDPOINTS } from '../../src/main/verifier/endpoints.js'
import { slotTimestamp } from '../../src/main/verifier/checkpoint.js'

const ROOT = '0x' + 'a'.repeat(64)
const OTHER = '0x' + 'b'.repeat(64)
const EARLIER = '0x' + 'c'.repeat(64)
const SLOT = 15_285_632

function header (root = ROOT, slot: string | number = SLOT, extra: Record<string, unknown> = {}): unknown {
  return { execution_optimistic: false, finalized: true, data: { root, canonical: true, header: { message: { slot: String(slot) } } }, ...extra }
}

/** Slots whose block each server names (`'none'` for a 404), and the slot a bootstrap is served for by root (`'missing'` for a 404). */
interface World {
  readonly roots?: Record<number, string | 'none' | Error>
  readonly bootstraps?: Record<string, number | 'missing' | Error>
}

const SERVED: World = { roots: { [SLOT]: ROOT, [SLOT - 32]: EARLIER }, bootstraps: { [ROOT]: SLOT, [EARLIER]: SLOT - 32 } }

function beacon (answers: Record<string, unknown>, world: World = SERVED): (url: string) => Promise<unknown> {
  return async (url) => {
    const api = Object.keys(answers).find((a) => url.startsWith(a))
    if (api === undefined) throw new Error(`unexpected ${url}`)
    const path = url.slice(api.length)
    let answer: unknown
    if (path === '/eth/v1/beacon/headers/finalized') {
      answer = answers[api]
    } else if (path.endsWith('/root')) {
      const named = world.roots?.[Number(path.split('/')[5])] ?? 'none'
      answer = named === 'none' ? new NotFoundAnswer('404') : named instanceof Error ? named : { data: { root: named } }
    } else {
      const served = world.bootstraps?.[path.split('/')[6]!] ?? 'missing'
      answer = served === 'missing' ? new NotFoundAnswer('404') : served instanceof Error ? served : { data: { header: { beacon: { slot: String(served) } } } }
    }
    if (answer instanceof Error) throw answer
    return answer
  }
}

/** The script reads a 404 as its own error class, as its real fetch throws it. */
function forScript (get: (url: string) => Promise<unknown>): (url: string) => Promise<unknown> {
  return async (url) => await get(url).catch((error: unknown) => { throw error instanceof NotFoundAnswer ? new ScriptNotFound(error.message) : error })
}

describe('agreedCheckpoint', () => {
  it('returns the checkpoint and its slot time when every API agrees', async () => {
    const checkpoint = await agreedCheckpoint(forScript(beacon({ 'https://a': header(), 'https://b': header() })), ['https://a', 'https://b'], 'https://a')
    expect(checkpoint).toEqual({ root: ROOT, slot: SLOT, timestamp: 1_606_824_023 + SLOT * 12, agreedBy: ['https://a', 'https://b'] })
  })

  it('refuses when the APIs disagree on the root, never choosing one', async () => {
    await expect(agreedCheckpoint(forScript(beacon({ 'https://a': header(ROOT), 'https://b': header(OTHER) })), ['https://a', 'https://b'], 'https://a')).rejects.toThrow(/disagree/)
  })

  it('refuses when they disagree on the slot', async () => {
    await expect(agreedCheckpoint(forScript(beacon({ 'https://a': header(ROOT, SLOT), 'https://b': header(ROOT, 1) })), ['https://a', 'https://b'], 'https://a')).rejects.toThrow(/disagree/)
  })

  it('needs two different APIs at least', async () => {
    await expect(agreedCheckpoint(forScript(beacon({ 'https://a': header() })), ['https://a'])).rejects.toThrow(/two/)
    await expect(agreedCheckpoint(forScript(beacon({ 'https://a': header() })), ['https://a', 'https://a'])).rejects.toThrow(/two/)
  })

  it('refuses a malformed root, and a header that is not finalized', async () => {
    await expect(agreedCheckpoint(forScript(beacon({ 'https://a': header('x'), 'https://b': header('x') })), ['https://a', 'https://b'], 'https://a')).rejects.toThrow(/no finalized checkpoint/)
    const open = header(ROOT, SLOT, { finalized: false })
    await expect(agreedCheckpoint(forScript(beacon({ 'https://a': open, 'https://b': open })), ['https://a', 'https://b'], 'https://a')).rejects.toThrow(/not finalized/)
    await expect(agreedCheckpoint(forScript(beacon({ 'https://a': header(ROOT, SLOT, { execution_optimistic: true }), 'https://b': header() })), ['https://a', 'https://b'], 'https://a')).rejects.toThrow(/not finalized/)
  })

  it('accepts the block Lodestar flags not finalized when the other API flags it finalized', async () => {
    const lodestar = header(ROOT, SLOT, { finalized: false })
    const checkpoint = await agreedCheckpoint(forScript(beacon({ 'https://a': header(), 'https://b': lodestar })), ['https://a', 'https://b'], 'https://a')
    expect(checkpoint.root).toBe(ROOT)
  })

  it('takes the first slot of the head\'s epoch, which is not the head when the head is the last slot of its epoch', async () => {
    const head = header(OTHER, SLOT + 31)
    const checkpoint = await agreedCheckpoint(forScript(beacon({ 'https://a': head, 'https://b': head })), ['https://a', 'https://b'], 'https://a')
    expect(checkpoint).toMatchObject({ root: ROOT, slot: SLOT })
  })

  it('steps back an epoch when the first slot has no block, or its bootstrap is not served', async () => {
    const head = { 'https://a': header(), 'https://b': header() }
    const noBlock: World = { roots: { [SLOT - 32]: EARLIER }, bootstraps: SERVED.bootstraps! }
    expect((await agreedCheckpoint(forScript(beacon(head, noBlock)), ['https://a', 'https://b'], 'https://a')).root).toBe(EARLIER)
    const noBootstrap: World = { roots: SERVED.roots!, bootstraps: { [EARLIER]: SLOT - 32 } }
    expect((await agreedCheckpoint(forScript(beacon(head, noBootstrap)), ['https://a', 'https://b'], 'https://a')).root).toBe(EARLIER)
  })

  it('asks the bootstrap of the consensus server it is told, wherever the list puts it', async () => {
    const seen: string[] = []
    const get = beacon({ 'https://a': header(), 'https://b': header() })
    const checkpoint = await agreedCheckpoint(forScript(async (url) => { seen.push(url); return await get(url) }), ['https://a', 'https://b'], 'https://b')
    expect(checkpoint.agreedBy).toEqual(['https://b', 'https://a'])
    expect(seen.filter((url) => url.includes('/bootstrap/'))).toEqual([`https://b/eth/v1/beacon/light_client/bootstrap/${ROOT}`])
  })

  it('refuses when no recent epoch has a bootstrap', async () => {
    await expect(agreedCheckpoint(forScript(beacon({ 'https://a': header(), 'https://b': header() }, {})), ['https://a', 'https://b'], 'https://a')).rejects.toThrow(/serves a bootstrap for none/)
  })

  it('refuses when another API names another root at that slot', async () => {
    const get = async (url: string): Promise<unknown> => url.startsWith('https://b') && url.endsWith(`/blocks/${String(SLOT)}/root`) ? { data: { root: OTHER } } : await forScript(beacon({ 'https://a': header(), 'https://b': header() }))(url)
    await expect(agreedCheckpoint(get, ['https://a', 'https://b'], 'https://a')).rejects.toThrow(/disagree on the block/)
  })
})

describe('the release script and the browser', () => {
  it('ask the same two beacon APIs, and take the same server to be the consensus one', () => {
    expect([...DEFAULT_ENDPOINTS.checkpointBeaconApis]).toEqual(DEFAULT_BEACON_APIS)
    expect(DEFAULT_CONSENSUS_RPC).toBe(DEFAULT_ENDPOINTS.consensusRpc)
  })

  it('reach the same verdict on the same answers', async () => {
    const A = 'https://a.example'
    const B = 'https://b.example'
    const both = { [A]: header(), [B]: header() }
    const cases: Array<[Record<string, unknown>, World]> = [
      [both, SERVED],
      [{ [A]: header(ROOT), [B]: header(OTHER) }, SERVED],
      [{ [A]: header(ROOT, SLOT), [B]: header(ROOT, SLOT + 1) }, SERVED],
      [{ [A]: header(), [B]: new Error('down') }, SERVED],
      [{ [A]: header(), [B]: new MalformedAnswer('not json') }, SERVED],
      [{ [A]: header(), [B]: { data: 1 } }, SERVED],
      [{ [A]: header(ROOT, SLOT, { finalized: false }), [B]: header(ROOT, SLOT, { finalized: false }) }, SERVED],
      [{ [A]: header(), [B]: header(ROOT, SLOT, { finalized: false }) }, SERVED],
      [{ [A]: header(ROOT, SLOT, { execution_optimistic: true }), [B]: header() }, SERVED],
      [{ [A]: header('0xabc'), [B]: header('0xabc') }, SERVED],
      [{ [A]: header(OTHER, SLOT + 31), [B]: header(OTHER, SLOT + 31) }, SERVED],
      [both, { roots: { [SLOT - 32]: EARLIER }, bootstraps: SERVED.bootstraps! }],
      [both, { roots: SERVED.roots!, bootstraps: { [EARLIER]: SLOT - 32 } }],
      [both, { roots: SERVED.roots!, bootstraps: { [ROOT]: SLOT - 1, [EARLIER]: SLOT - 32 } }],
      [both, {}],
      [both, { roots: SERVED.roots!, bootstraps: { [ROOT]: new Error('503') } }],
      [both, { roots: { [SLOT]: new Error('503') }, bootstraps: SERVED.bootstraps! }]
    ]
    for (const [table, world] of cases) {
      const get = beacon(table, world)
      const app = await fetchAgreedCheckpoint(get, [A, B], A, slotTimestamp(SLOT) + 3600)
      const script = await agreedCheckpoint(forScript(get), [A, B], A).then((c) => ({ root: c.root, slot: c.slot }), () => undefined)
      expect(app.ok ? { root: app.checkpoint.root, slot: app.checkpoint.slot } : undefined).toEqual(script)
    }
  })

  it('also agree when the other server disagrees on the block at the first slot', async () => {
    const A = 'https://a.example'
    const B = 'https://b.example'
    const get = async (url: string): Promise<unknown> => url.startsWith(B) && url.endsWith(`/blocks/${String(SLOT)}/root`) ? { data: { root: OTHER } } : await beacon({ [A]: header(), [B]: header() })(url)
    expect(await fetchAgreedCheckpoint(get, [A, B], A, slotTimestamp(SLOT) + 3600)).toEqual({ ok: false, problem: 'disagree' })
    await expect(agreedCheckpoint(get, [A, B], A)).rejects.toThrow(/disagree/)
  })
})
