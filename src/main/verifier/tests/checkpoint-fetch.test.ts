import { describe, expect, it, vi } from 'vitest'
import { FUTURE_TOLERANCE_SECONDS, MAX_CHECKPOINT_AGE_SECONDS, slotTimestamp } from '../checkpoint.js'
import { CheckpointFetcher, FIRST_BACKOFF_MS, MAX_BACKOFF_MS, MAX_EPOCHS_BACK, MalformedAnswer, NotFoundAnswer, SLOTS_PER_EPOCH, fetchAgreedCheckpoint, readFinalizedHeader } from '../checkpoint-fetch.js'
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

/** What a server answers about a slot's block root: a root, `'none'` for a slot with no block (a 404), or an Error to throw. */
type RootAnswers = (server: string, slot: number) => string | 'none' | Error
/** What the consensus server answers to a bootstrap request for a root: the slot of its header, `'missing'` for a 404, or an Error to throw. */
type BootstrapAnswers = (root: string) => number | 'missing' | Error

interface World { readonly roots?: RootAnswers, readonly bootstraps?: BootstrapAnswers, readonly seen?: string[] }

/** The newest epoch's first slot holds ROOT, and the bootstrap of ROOT is served from that slot. */
const SERVED: Required<Pick<World, 'roots' | 'bootstraps'>> = {
  roots: (_server, slot) => slot === SLOT ? ROOT : 'none',
  bootstraps: (root) => root === ROOT ? SLOT : 'missing'
}

/** Each server answers with what the table holds for its finalized header: a body, or an Error to throw. Block roots and bootstraps come from `world`. */
function servers (table: Record<string, unknown>, world: World = SERVED): (url: string) => Promise<unknown> {
  const { roots = SERVED.roots, bootstraps = SERVED.bootstraps } = world
  return async (url) => {
    world.seen?.push(url)
    const server = Object.keys(table).find((s) => url.startsWith(s))
    if (server === undefined) throw new Error(`unexpected ${url}`)
    const path = url.slice(server.length)
    const answer = path === '/eth/v1/beacon/headers/finalized' ? table[server] : path.endsWith('/root') ? rootAnswer(roots(server, Number(path.split('/')[5]))) : bootstrapAnswer(bootstraps(path.split('/')[6]!))
    if (answer instanceof Error) throw answer
    return answer
  }
}

function rootAnswer (answer: string | Error): unknown {
  if (answer === 'none') return new NotFoundAnswer('404')
  return answer instanceof Error ? answer : { execution_optimistic: false, finalized: true, data: { root: answer } }
}

function bootstrapAnswer (answer: number | 'missing' | Error): unknown {
  if (answer === 'missing') return new NotFoundAnswer('404')
  return answer instanceof Error ? answer : { version: 'fulu', data: { header: { beacon: { slot: String(answer) } } } }
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
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], A, NOW)).toEqual({
      ok: true, checkpoint: { root: ROOT, slot: SLOT, timestamp: slotTimestamp(SLOT), servers: [A, B] }
    })
  })

  it('refuses when the servers name different roots', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(ROOT), [B]: header(OTHER) }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'disagree' })
  })

  it('refuses when they name the same root with different slots', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(ROOT, SLOT), [B]: header(ROOT, SLOT + 1) }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'disagree' })
  })

  it('refuses when one is unreachable, never settling for the other alone', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: new Error('ECONNREFUSED') }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'unreachable' })
  })

  it('refuses when both are unreachable', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: new Error('x'), [B]: new Error('y') }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'unreachable' })
  })

  it('refuses a body that is not JSON of the right shape', async () => {
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: new MalformedAnswer('not json') }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'malformed' })
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: { data: 1 } }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'malformed' })
  })

  it('accepts a server that flags the agreed block not finalized when another flags it finalized (Lodestar does)', async () => {
    const lodestar = header(ROOT, SLOT, { finalized: false })
    const result = await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: lodestar }), [A, B], A, NOW)
    expect(result.ok).toBe(true)
    expect((await fetchAgreedCheckpoint(servers({ [A]: lodestar, [B]: header() }), [A, B], A, NOW)).ok).toBe(true)
  })

  it('refuses a flagged-open header when the other server leaves the flag out', async () => {
    const bare = { data: { root: ROOT, canonical: true, header: { message: { slot: String(SLOT) } } } }
    expect(await fetchAgreedCheckpoint(servers({ [A]: bare, [B]: header(ROOT, SLOT, { finalized: false }) }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'not-finalized' })
  })

  it('refuses a header that is not finalized, even when both say so', async () => {
    const open = header(ROOT, SLOT, { finalized: false })
    expect(await fetchAgreedCheckpoint(servers({ [A]: open, [B]: open }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'not-finalized' })
  })

  it('refuses a checkpoint dated beyond the tolerance after this computer\'s clock', async () => {
    const clock = slotTimestamp(SLOT) - FUTURE_TOLERANCE_SECONDS - 1
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], A, clock)).toEqual({ ok: false, problem: 'future' })
  })

  it('accepts a checkpoint dated within the tolerance after the clock', async () => {
    const clock = slotTimestamp(SLOT) - FUTURE_TOLERANCE_SECONDS
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], A, clock)).toMatchObject({ ok: true })
  })

  it('refuses a checkpoint older than the limit itself', async () => {
    const clock = slotTimestamp(SLOT) + MAX_CHECKPOINT_AGE_SECONDS + 1
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], A, clock)).toEqual({ ok: false, problem: 'too-old' })
  })

  it('accepts a checkpoint exactly at the limit', async () => {
    const clock = slotTimestamp(SLOT) + MAX_CHECKPOINT_AGE_SECONDS
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header() }), [A, B], A, clock)).toMatchObject({ ok: true })
  })

  it('needs two servers at least and asks nobody with fewer', async () => {
    let asked = 0
    const get = async (): Promise<unknown> => { asked += 1; return header() }
    expect(await fetchAgreedCheckpoint(get, [A], A, NOW)).toEqual({ ok: false, problem: 'too-few-servers' })
    expect(await fetchAgreedCheckpoint(get, [A, A], A, NOW)).toEqual({ ok: false, problem: 'too-few-servers' })
    expect(asked).toBe(0)
  })

  it('with three servers, wants all three to agree', async () => {
    const C = 'https://c.example'
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header(), [C]: header(OTHER) }), [A, B, C], A, NOW)).toEqual({ ok: false, problem: 'disagree' })
    expect(await fetchAgreedCheckpoint(servers({ [A]: header(), [B]: header(), [C]: header() }), [A, B, C], A, NOW)).toMatchObject({ ok: true })
  })

  it('asks every server for its finalized header at once', async () => {
    const started: string[] = []
    const releases: Array<() => void> = []
    const answer = servers({ [A]: header(), [B]: header() })
    const get = async (url: string): Promise<unknown> => {
      started.push(url)
      if (url.endsWith('/headers/finalized')) await new Promise<void>((resolve) => releases.push(resolve))
      return await answer(url)
    }
    const pending = fetchAgreedCheckpoint(get, [A, B], A, NOW)
    await Promise.resolve()
    expect(started).toEqual([`${A}/eth/v1/beacon/headers/finalized`, `${B}/eth/v1/beacon/headers/finalized`])
    releases.forEach((release) => { release() })
    expect(await pending).toMatchObject({ ok: true })
  })
})

describe('fetchAgreedCheckpoint chooses a block the light client can bootstrap from', () => {
  const EPOCH = SLOTS_PER_EPOCH
  const ROOT_BEFORE = '0x' + 'c'.repeat(64)
  const both = (slot: number): Record<string, unknown> => ({ [A]: header(OTHER, slot), [B]: header(OTHER, slot) })
  const rootsAt = (table: Record<number, string>): RootAnswers => (_server, slot) => table[slot] ?? 'none'
  const served = (table: Record<string, number>): BootstrapAnswers => (root) => table[root] ?? 'missing'

  it('takes the first slot of the finalized head\'s epoch, not the head itself', async () => {
    const seen: string[] = []
    const result = await fetchAgreedCheckpoint(servers(both(SLOT + 31), { seen, roots: rootsAt({ [SLOT]: ROOT }), bootstraps: served({ [ROOT]: SLOT }) }), [A, B], A, NOW)
    expect(result).toEqual({ ok: true, checkpoint: { root: ROOT, slot: SLOT, timestamp: slotTimestamp(SLOT), servers: [A, B] } })
    expect(seen.some((url) => url.includes(`/blocks/${String(SLOT + 31)}/`))).toBe(false)
  })

  it('steps back an epoch when the newest epoch\'s first slot holds no block', async () => {
    const world = { roots: rootsAt({ [SLOT - EPOCH]: ROOT_BEFORE }), bootstraps: served({ [ROOT_BEFORE]: SLOT - EPOCH }) }
    expect(await fetchAgreedCheckpoint(servers(both(SLOT + 31), world), [A, B], A, NOW)).toMatchObject({ ok: true, checkpoint: { root: ROOT_BEFORE, slot: SLOT - EPOCH } })
  })

  it('steps back when the consensus server has no bootstrap for the newest block, the failure of a block it will not start from', async () => {
    const world = { roots: rootsAt({ [SLOT]: ROOT, [SLOT - EPOCH]: ROOT_BEFORE }), bootstraps: served({ [ROOT_BEFORE]: SLOT - EPOCH }) }
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), world), [A, B], A, NOW)).toMatchObject({ ok: true, checkpoint: { root: ROOT_BEFORE, slot: SLOT - EPOCH } })
  })

  it('steps back when the bootstrap it serves is for a block at another slot than the epoch\'s first', async () => {
    const world = { roots: rootsAt({ [SLOT]: ROOT, [SLOT - EPOCH]: ROOT_BEFORE }), bootstraps: served({ [ROOT]: SLOT - 1, [ROOT_BEFORE]: SLOT - EPOCH }) }
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), world), [A, B], A, NOW)).toMatchObject({ ok: true, checkpoint: { root: ROOT_BEFORE } })
  })

  it('gives up after the epochs it may step back through, asking each once', async () => {
    const seen: string[] = []
    const result = await fetchAgreedCheckpoint(servers(both(SLOT), { seen, roots: () => 'none', bootstraps: () => 'missing' }), [A, B], A, NOW)
    expect(result).toEqual({ ok: false, problem: 'no-bootstrap' })
    expect(seen.filter((url) => url.startsWith(`${A}/eth/v1/beacon/blocks/`))).toHaveLength(MAX_EPOCHS_BACK)
  })

  it('finds a block as far back as the last epoch it may try', async () => {
    const last = SLOT - (MAX_EPOCHS_BACK - 1) * EPOCH
    const world = { roots: rootsAt({ [last]: ROOT_BEFORE }), bootstraps: served({ [ROOT_BEFORE]: last }) }
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), world), [A, B], A, NOW)).toMatchObject({ ok: true, checkpoint: { slot: last } })
    const beyond = { roots: rootsAt({ [last - EPOCH]: ROOT_BEFORE }), bootstraps: served({ [ROOT_BEFORE]: last - EPOCH }) }
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), beyond), [A, B], A, NOW)).toEqual({ ok: false, problem: 'no-bootstrap' })
  })

  it('asks only the consensus server for a bootstrap, and the others only for the root', async () => {
    const seen: string[] = []
    await fetchAgreedCheckpoint(servers(both(SLOT), { seen }), [A, B], A, NOW)
    expect(seen.filter((url) => url.includes('/bootstrap/'))).toEqual([`${A}/eth/v1/beacon/light_client/bootstrap/${ROOT}`])
    expect(seen).toContain(`${B}/eth/v1/beacon/blocks/${String(SLOT)}/root`)
  })

  it('takes the consensus server to be the one asked first, wherever the list puts it', async () => {
    const seen: string[] = []
    const result = await fetchAgreedCheckpoint(servers(both(SLOT), { seen }), [A, B], B, NOW)
    expect(result).toMatchObject({ ok: true, checkpoint: { servers: [B, A] } })
    expect(seen.filter((url) => url.includes('/bootstrap/'))).toEqual([`${B}/eth/v1/beacon/light_client/bootstrap/${ROOT}`])
  })

  it('also wants a consensus server outside the list to agree', async () => {
    const C = 'https://c.example'
    const all = { ...both(SLOT), [C]: header(OTHER, SLOT) }
    expect(await fetchAgreedCheckpoint(servers(all), [A, B], C, NOW)).toMatchObject({ ok: true, checkpoint: { servers: [C, A, B] } })
    const odd = { roots: (server: string, slot: number) => server === A && slot === SLOT ? OTHER : ROOT }
    expect(await fetchAgreedCheckpoint(servers(all, { ...SERVED, ...odd }), [A, B], C, NOW)).toEqual({ ok: false, problem: 'disagree' })
  })

  it('refuses when another server names a different root, or none, at that slot', async () => {
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), { ...SERVED, roots: (server, slot) => server === B ? OTHER : SERVED.roots(server, slot) }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'disagree' })
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), { ...SERVED, roots: (server, slot) => server === B ? 'none' : SERVED.roots(server, slot) }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'disagree' })
  })

  it('refuses, rather than stepping back, when a server cannot be reached or answers nonsense', async () => {
    const down = (server: string): RootAnswers => (s, slot) => s === server ? new Error('ECONNRESET') : SERVED.roots(s, slot)
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), { ...SERVED, roots: down(B) }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'unreachable' })
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), { ...SERVED, roots: down(A) }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'unreachable' })
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), { ...SERVED, bootstraps: () => new Error('503') }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'unreachable' })
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), { ...SERVED, bootstraps: () => new MalformedAnswer('not json') }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'malformed' })
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), { ...SERVED, roots: () => new MalformedAnswer('not json') }), [A, B], A, NOW)).toEqual({ ok: false, problem: 'malformed' })
  })

  it('refuses a bootstrap without a slot, and a root that is not one', async () => {
    const get = servers(both(SLOT))
    const noSlot = async (url: string): Promise<unknown> => url.includes('/bootstrap/') ? { data: {} } : await get(url)
    expect(await fetchAgreedCheckpoint(noSlot, [A, B], A, NOW)).toEqual({ ok: false, problem: 'malformed' })
    const badRoot = async (url: string): Promise<unknown> => url.endsWith('/root') ? { data: { root: '0xabc' } } : await get(url)
    expect(await fetchAgreedCheckpoint(badRoot, [A, B], A, NOW)).toEqual({ ok: false, problem: 'malformed' })
  })

  it('refuses a checkpoint past the age limit even when the head is inside it', async () => {
    const clock = slotTimestamp(SLOT - EPOCH) + MAX_CHECKPOINT_AGE_SECONDS + 1
    const world = { roots: rootsAt({ [SLOT - EPOCH]: ROOT_BEFORE }), bootstraps: served({ [ROOT_BEFORE]: SLOT - EPOCH }) }
    expect(await fetchAgreedCheckpoint(servers(both(SLOT), world), [A, B], A, clock)).toEqual({ ok: false, problem: 'too-old' })
  })

  it('passes over a root it was told the consensus server has no bootstrap for, to the epoch before', async () => {
    const seen: string[] = []
    const world = { seen, roots: rootsAt({ [SLOT]: ROOT, [SLOT - EPOCH]: ROOT_BEFORE }), bootstraps: served({ [ROOT]: SLOT, [ROOT_BEFORE]: SLOT - EPOCH }) }
    const result = await fetchAgreedCheckpoint(servers(both(SLOT), world), [A, B], A, NOW, { unserved: new Set([ROOT]) })
    expect(result).toMatchObject({ ok: true, checkpoint: { root: ROOT_BEFORE, slot: SLOT - EPOCH } })
    expect(seen.some((url) => url.includes(`/bootstrap/${ROOT}`))).toBe(false)
  })

  it('finds nothing when every root it walks to is one it was told to pass over', async () => {
    const result = await fetchAgreedCheckpoint(servers(both(SLOT)), [A, B], A, NOW, { unserved: new Set([ROOT]) })
    expect(result).toEqual({ ok: false, problem: 'no-bootstrap' })
  })

  it('asks the other servers for the root at the slot while the bootstrap is still being fetched', async () => {
    const started: string[] = []
    let release: () => void = () => {}
    const answer = servers(both(SLOT))
    const get = async (url: string): Promise<unknown> => {
      started.push(url)
      if (url.includes('/bootstrap/')) await new Promise<void>((resolve) => { release = resolve })
      return await answer(url)
    }
    const pending = fetchAgreedCheckpoint(get, [A, B], A, NOW)
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(started).toContain(`${A}/eth/v1/beacon/light_client/bootstrap/${ROOT}`)
    expect(started).toContain(`${B}/eth/v1/beacon/blocks/${String(SLOT)}/root`)
    release()
    expect(await pending).toMatchObject({ ok: true })
  })

  it('refuses a block root flagged optimistic as not finalized, the way the head is', async () => {
    const optimistic = (server: string, slot: number): unknown => server === B ? { execution_optimistic: true, data: { root: ROOT } } : SERVED.roots(server, slot)
    const get = servers(both(SLOT))
    const wrap = async (url: string): Promise<unknown> => url.startsWith(B) && url.endsWith('/root') ? optimistic(B, SLOT) : await get(url)
    expect(await fetchAgreedCheckpoint(wrap, [A, B], A, NOW)).toEqual({ ok: false, problem: 'not-finalized' })
  })

  it('gives up when the whole attempt outlasts its deadline, and asks no further once it has', async () => {
    vi.useFakeTimers()
    try {
      const started: string[] = []
      const answer = servers(both(SLOT), { roots: () => 'none', bootstraps: () => 'missing' })
      const get = async (url: string): Promise<unknown> => {
        started.push(url)
        if (url.includes('/blocks/')) await new Promise<void>((resolve) => setTimeout(resolve, 6_000))
        return await answer(url)
      }
      const pending = fetchAgreedCheckpoint(get, [A, B], A, NOW, { deadlineMs: 20_000 })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(await pending).toEqual({ ok: false, problem: 'unreachable' })
      const askedAtDeadline = started.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(started).toHaveLength(askedAtDeadline)
      expect(started.filter((url) => url.includes('/blocks/'))).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
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

  it('forgets a failure and its wait when reset, and starts the wait again from the first', async () => {
    const { fetcher: f, clock, runs } = fetcher([failure, failure, failure])
    await f.renew()
    clock.now += FIRST_BACKOFF_MS
    await f.renew()
    expect(f.lastProblem()).toBe('disagree')
    f.reset()
    expect(f.lastProblem()).toBeUndefined()
    expect(f.mayAttempt()).toBe(true)
    await f.renew()
    expect(runs()).toBe(3)
    clock.now += FIRST_BACKOFF_MS
    expect(f.mayAttempt()).toBe(true)
  })

  it('leaves no failure behind from an attempt that began before a reset', async () => {
    let release: (outcome: FetchOutcome) => void = () => {}
    const { fetcher: f } = fetcher([new Promise<FetchOutcome>((resolve) => { release = resolve })])
    const attempt = f.renew()
    f.reset()
    release(failure)
    expect(await attempt).toEqual(failure)
    expect(f.lastProblem()).toBeUndefined()
    expect(f.mayAttempt()).toBe(true)
  })
})
