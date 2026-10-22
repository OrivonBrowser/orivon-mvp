import { describe, expect, it } from 'vitest'
import { FUTURE_TOLERANCE_SECONDS, MAX_CHECKPOINT_AGE_SECONDS, slotTimestamp } from '../checkpoint.js'
import { CheckpointFetcher, FIRST_BACKOFF_MS, MAX_BACKOFF_MS, MalformedAnswer, fetchAgreedCheckpoint, readFinalizedHeader } from '../checkpoint-fetch.js'
import type { FetchOutcome } from '../checkpoint-fetch.js'

const A = 'https://a.example'
const B = 'https://b.example'
const ROOT = '0x' + 'a'.repeat(64)
const OTHER = '0x' + 'b'.repeat(64)
const SLOT = 15_400_000
const NOW = slotTimestamp(SLOT) + 3600

function header (root = ROOT, slot: number | string = SLOT, extra: Record<string, unknown> = {}): unknown {
  return { execution_optimistic: false, finalized: true, data: { root, canonical: true, header: { message: { slot: String(slot) } } }, ...extra }
}

/** Each server answers with what the table holds: a body, or an Error to throw. */
function servers (table: Record<string, unknown>): (url: string) => Promise<unknown> {
  return async (url) => {
    const server = Object.keys(table).find((s) => url.startsWith(s))
    if (server === undefined || !url.endsWith('/eth/v1/beacon/headers/finalized')) throw new Error(`unexpected ${url}`)
    const answer = table[server]
    if (answer instanceof Error) throw answer
    return answer
  }
}

describe('readFinalizedHeader', () => {
  it('reads the root and slot of a finalized header', () => {
    expect(readFinalizedHeader(header())).toEqual({ root: ROOT, slot: SLOT, finalized: true })
  })

  it('accepts a server that leaves out the finalized flag, which the request itself asked for', () => {
    expect(readFinalizedHeader({ data: { root: ROOT, canonical: true, header: { message: { slot: String(SLOT) } } } })).toEqual({ root: ROOT, slot: SLOT })
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['no data', {}],
    ['a short root', header('0xabc')],
    ['an upper-case root', header('0x' + 'A'.repeat(64))],
    ['a missing slot', { data: { root: ROOT, header: { message: {} } } }],
    ['a non-numeric slot', header(ROOT, 'soon')],
    ['a zero slot', header(ROOT, 0)],
    ['a negative slot', header(ROOT, '-5')],
    ['a fractional slot', header(ROOT, '1.5')]
  ])('calls %s malformed', (_name, body) => {
    expect(readFinalizedHeader(body)).toBe('malformed')
  })

  it.each([
    ['optimistic', header(ROOT, SLOT, { execution_optimistic: true })],
    ['off the canonical chain', { finalized: true, data: { root: ROOT, canonical: false, header: { message: { slot: String(SLOT) } } } }]
  ])('refuses a header %s', (_name, body) => {
    expect(readFinalizedHeader(body)).toBe('not-finalized')
  })
})

describe('fetchAgreedCheckpoint', () => {
  it('returns the checkpoint, its slot time and the servers when they agree exactly', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], NOW)).toEqual({
      ok: true, checkpoint: { root: ROOT, slot: SLOT, timestamp: slotTimestamp(SLOT), servers: [A, B] }
    })
  })

  it('refuses when the servers name different roots', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(ROOT), [B]: header(OTHER) }), [A, B], NOW)).toEqual({ ok: false, problem: 'disagree' })
  })

  it('refuses when they name the same root with different slots', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(ROOT, SLOT), [B]: header(ROOT, SLOT + 1) }), [A, B], NOW)).toEqual({ ok: false, problem: 'disagree' })
  })

  it('refuses when one is unreachable, never settling for the other alone', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: new Error('ECONNREFUSED') }), [A, B], NOW)).toEqual({ ok: false, problem: 'unreachable' })
  })

  it('refuses when both are unreachable', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: new Error('x'), [B]: new Error('y') }), [A, B], NOW)).toEqual({ ok: false, problem: 'unreachable' })
  })

  it('refuses a body that is not JSON of the right shape', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: new MalformedAnswer('not json') }), [A, B], NOW)).toEqual({ ok: false, problem: 'malformed' })
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: { data: 1 } }), [A, B], NOW)).toEqual({ ok: false, problem: 'malformed' })
  })

  it('accepts a server that flags the agreed block not finalized when another flags it finalized (Lodestar does)', async () => {
    const lodestar = header(ROOT, SLOT, { finalized: false })
    const result = await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: lodestar }), [A, B], NOW)
    expect(result.ok).toBe(true)
    expect((await fetchAgreedCheckpoint(servers({ [A]: lodestar, [B]: header() }), [A, B], NOW)).ok).toBe(true)
  })

  it('refuses a flagged-open header when the other server leaves the flag out', async () => {
    const bare = { data: { root: ROOT, canonical: true, header: { message: { slot: String(SLOT) } } } }
    expect(await fetchAgreedCheckpoint(servers({ [A]: bare, [B]: header(ROOT, SLOT, { finalized: false }) }), [A, B], NOW)).toEqual({ ok: false, problem: 'not-finalized' })
  })

  it('refuses a header that is not finalized, even when both say so', async () => {
    const open = header(ROOT, SLOT, { finalized: false })
    expect(await fetchAgreedCheckpoint(servers({ [A]: open, [B]: open }), [A, B], NOW)).toEqual({ ok: false, problem: 'not-finalized' })
  })

  it('refuses a checkpoint dated beyond the tolerance after this computer\'s clock', async () => {
    const clock = slotTimestamp(SLOT) - FUTURE_TOLERANCE_SECONDS - 1
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], clock)).toEqual({ ok: false, problem: 'future' })
  })

  it('accepts a checkpoint dated within the tolerance after the clock', async () => {
    const clock = slotTimestamp(SLOT) - FUTURE_TOLERANCE_SECONDS
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], clock)).toMatchObject({ ok: true })
  })

  it('refuses a checkpoint older than the limit itself', async () => {
    const clock = slotTimestamp(SLOT) + MAX_CHECKPOINT_AGE_SECONDS + 1
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], clock)).toEqual({ ok: false, problem: 'too-old' })
  })

  it('accepts a checkpoint exactly at the limit', async () => {
    const clock = slotTimestamp(SLOT) + MAX_CHECKPOINT_AGE_SECONDS
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], clock)).toMatchObject({ ok: true })
  })

  it('needs two servers at least and asks nobody with fewer', async () => {
    let asked = 0
    const get = async (): Promise<unknown> => { asked += 1; return header() }
    expect(await fetchAgreedCheckpoint(get, [A], NOW)).toEqual({ ok: false, problem: 'too-few-servers' })
    expect(await fetchAgreedCheckpoint(get, [A, A], NOW)).toEqual({ ok: false, problem: 'too-few-servers' })
    expect(asked).toBe(0)
  })

  it('with three servers, wants all three to agree', async () => {
    const C = 'https://c.example'
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header(), [C]: header(OTHER) }), [A, B, C], NOW)).toEqual({ ok: false, problem: 'disagree' })
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header(), [C]: header() }), [A, B, C], NOW)).toMatchObject({ ok: true })
  })

  it('asks every server at once', async () => {
    const started: string[] = []
    const releases: Array<() => void> = []
    const get = async (url: string): Promise<unknown> => {
      started.push(url)
      await new Promise<void>((resolve) => releases.push(resolve))
      return header()
    }
    const pending = fetchAgreedCheckpoint(get, [A, B], NOW)
    await Promise.resolve()
    expect(started).toEqual([`${A}/eth/v1/beacon/headers/finalized`, `${B}/eth/v1/beacon/headers/finalized`])
    releases.forEach((release) => { release() })
    expect(await pending).toMatchObject({ ok: true })
  })
})

describe('CheckpointFetcher', () => {
  const success: FetchOutcome = { ok: true, checkpoint: { root: ROOT, slot: SLOT, timestamp: slotTimestamp(SLOT), servers: [A, B] } }
  const failure: FetchOutcome = { ok: false, problem: 'disagree' }

  function fetcher (outcomes: Array<FetchOutcome | Error | Promise<FetchOutcome>>): { fetcher: CheckpointFetcher, clock: { now: number }, runs: () => number } {
    const clock = { now: 1_000_000 }
    let runs = 0
    const instance = new CheckpointFetcher({
      run: async () => {
        const next = outcomes[runs++]
        if (next instanceof Error) throw next
        return await next!
      },
      now: () => clock.now
    })
    return { fetcher: instance, clock, runs: () => runs }
  }

  it('shares one attempt among callers while it is in flight', async () => {
    let release: (outcome: FetchOutcome) => void = () => {}
    const { fetcher: f, runs } = fetcher([new Promise<FetchOutcome>((resolve) => { release = resolve })])
    const first = f.renew()
    const second = f.renew()
    expect(f.mayAttempt()).toBe(false)
    release(success)
    expect(await first).toBe(await second)
    expect(runs()).toBe(1)
  })

  it('does not ask again within the wait after a failure, and answers with the same reason', async () => {
    const { fetcher: f, clock, runs } = fetcher([failure, success])
    expect(await f.renew()).toEqual(failure)
    expect(f.mayAttempt()).toBe(false)
    clock.now += FIRST_BACKOFF_MS - 1
    expect(await f.renew()).toEqual(failure)
    expect(runs()).toBe(1)
    expect(f.lastProblem()).toBe('disagree')
  })

  it('asks again once the wait has passed, and forgets the failure after a success', async () => {
    const { fetcher: f, clock, runs } = fetcher([failure, success])
    await f.renew()
    clock.now += FIRST_BACKOFF_MS
    expect(f.mayAttempt()).toBe(true)
    expect(await f.renew()).toEqual(success)
    expect(runs()).toBe(2)
    expect(f.lastProblem()).toBeUndefined()
    expect(f.mayAttempt()).toBe(true)
  })

  it('doubles the wait with each failure up to a ceiling', async () => {
    const { fetcher: f, clock } = fetcher(Array.from({ length: 12 }, () => failure))
    const waits: number[] = []
    for (let i = 0; i < 12; i++) {
      await f.renew()
      const before = clock.now
      while (!f.mayAttempt()) clock.now += 1000
      waits.push(clock.now - before)
    }
    expect(waits[0]).toBe(FIRST_BACKOFF_MS)
    expect(waits[1]).toBe(FIRST_BACKOFF_MS * 2)
    expect(waits[2]).toBe(FIRST_BACKOFF_MS * 4)
    expect(waits[11]).toBe(MAX_BACKOFF_MS)
    expect(Math.max(...waits)).toBe(MAX_BACKOFF_MS)
  })

  it('counts a run that throws as unreachable', async () => {
    const { fetcher: f } = fetcher([new Error('boom')])
    expect(await f.renew()).toEqual({ ok: false, problem: 'unreachable' })
    expect(f.mayAttempt()).toBe(false)
  })
})
