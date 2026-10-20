import { describe, expect, it } from 'vitest'
import { DEFAULT_BEACON_APIS, agreedCheckpoint } from '../refresh-eth-checkpoint.mjs'
import { fetchAgreedCheckpoint, MalformedAnswer } from '../../src/main/verifier/checkpoint-fetch.js'
import { DEFAULT_ENDPOINTS } from '../../src/main/verifier/endpoints.js'
import { slotTimestamp } from '../../src/main/verifier/checkpoint.js'

const ROOT = '0x' + 'a'.repeat(64)
const OTHER = '0x' + 'b'.repeat(64)
const SLOT = 15_285_632

function header (root = ROOT, slot: string | number = SLOT, extra: Record<string, unknown> = {}): unknown {
  return { execution_optimistic: false, finalized: true, data: { root, canonical: true, header: { message: { slot: String(slot) } } }, ...extra }
}

function beacon (answers: Record<string, unknown>): (url: string) => Promise<unknown> {
  return async (url) => {
    const api = Object.keys(answers).find((a) => url.startsWith(a))
    if (api === undefined || !url.endsWith('/eth/v1/beacon/headers/finalized')) throw new Error(`unexpected ${url}`)
    const answer = answers[api]
    if (answer instanceof Error) throw answer
    return answer
  }
}

describe('agreedCheckpoint', () => {
  it('returns the checkpoint and its slot time when every API agrees', async () => {
    const checkpoint = await agreedCheckpoint(beacon({ 'https://a': header(), 'https://b': header() }), ['https://a', 'https://b'])
    expect(checkpoint).toEqual({ root: ROOT, slot: SLOT, timestamp: 1_606_824_023 + SLOT * 12, agreedBy: ['https://a', 'https://b'] })
  })

  it('refuses when the APIs disagree on the root, never choosing one', async () => {
    await expect(agreedCheckpoint(beacon({ 'https://a': header(ROOT), 'https://b': header(OTHER) }), ['https://a', 'https://b'])).rejects.toThrow(/disagree/)
  })

  it('refuses when they disagree on the slot', async () => {
    await expect(agreedCheckpoint(beacon({ 'https://a': header(ROOT, SLOT), 'https://b': header(ROOT, 1) }), ['https://a', 'https://b'])).rejects.toThrow(/disagree/)
  })

  it('needs two different APIs at least', async () => {
    await expect(agreedCheckpoint(beacon({ 'https://a': header() }), ['https://a'])).rejects.toThrow(/two/)
    await expect(agreedCheckpoint(beacon({ 'https://a': header() }), ['https://a', 'https://a'])).rejects.toThrow(/two/)
  })

  it('refuses a malformed root, and a header that is not finalized', async () => {
    await expect(agreedCheckpoint(beacon({ 'https://a': header('x'), 'https://b': header('x') }), ['https://a', 'https://b'])).rejects.toThrow(/no finalized checkpoint/)
    const open = header(ROOT, SLOT, { finalized: false })
    await expect(agreedCheckpoint(beacon({ 'https://a': open, 'https://b': open }), ['https://a', 'https://b'])).rejects.toThrow(/not finalized/)
  })
})

describe('the release script and the browser', () => {
  it('ask the same two beacon APIs', () => {
    expect([...DEFAULT_ENDPOINTS.checkpointBeaconApis]).toEqual(DEFAULT_BEACON_APIS)
  })

  it('reach the same verdict on the same answers', async () => {
    const A = 'https://a.example'
    const B = 'https://b.example'
    const cases: Array<Record<string, unknown>> = [
      { [A]: header(), [B]: header() },
      { [A]: header(ROOT), [B]: header(OTHER) },
      { [A]: header(ROOT, SLOT), [B]: header(ROOT, SLOT + 1) },
      { [A]: header(), [B]: new Error('down') },
      { [A]: header(), [B]: new MalformedAnswer('not json') },
      { [A]: header(), [B]: { data: 1 } },
      { [A]: header(ROOT, SLOT, { finalized: false }), [B]: header(ROOT, SLOT, { finalized: false }) },
      { [A]: header('0xabc'), [B]: header('0xabc') }
    ]
    for (const table of cases) {
      const get = beacon(table)
      const app = await fetchAgreedCheckpoint(get, [A, B], slotTimestamp(SLOT) + 3600)
      const script = await agreedCheckpoint(get, [A, B]).then((c) => ({ root: c.root, slot: c.slot }), () => undefined)
      expect(app.ok ? { root: app.checkpoint.root, slot: app.checkpoint.slot } : undefined).toEqual(script)
    }
  })
})
