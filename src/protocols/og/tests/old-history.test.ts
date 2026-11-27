import { describe, expect, it } from 'vitest'
import type { Eip1193Provider } from '../../ens/resolver.js'
import { ChainError, eip1193Chain } from '../chain.js'
import type { Chain } from '../chain.js'
import { inspectOg, resolveOg } from '../lookup.js'
import { BACKOFF_CAP_MS, FINISH_RESERVE_MS, MIN_OLD_WINDOW, OLD_IN_FLIGHT, OLD_WINDOW, OgRefusal, PROVEN_SPAN, WINDOW, createSession, provenFromOf, stretchesOf, windowsOf } from '../tail.js'
import { fakeProvider, FIRST_BLOCK, worldOf } from './world.js'
import type { Faults } from './world.js'
import { CHECKPOINT, HEAD, NAME, PASSING, census, old, pointers, twoProviders } from './two-sources.js'

// History older than the light client proves is read from the servers, unproven; the newest blocks stay the light client's.

describe('the stretches of a scan', () => {
  it('are windows of 9,000 blocks before the first block the light client is asked for, and windows of 1024 after it', () => {
    expect(stretchesOf(100, 20_000, 10_240)).toEqual([
      { first: 100, last: 9_099, old: true },
      { first: 9_100, last: 10_239, old: true },
      ...windowsOf(10_240, 20_000).map(([first, last]) => ({ first, last, old: false }))
    ])
    expect(stretchesOf(100, 20_000, 10_240).filter((stretch) => !stretch.old)[0]).toEqual({ first: 10_240, last: 11_263, old: false })
  })

  it('are all the light client\'s without a first block, and all the servers\' for a range that ends before it', () => {
    expect(stretchesOf(10, 5_000)).toEqual(windowsOf(10, 5_000).map(([first, last]) => ({ first, last, old: false })))
    expect(stretchesOf(10, 5_000, 6_000)).toEqual([{ first: 10, last: 5_000, old: true }])
    expect(stretchesOf(7_000, 8_000, 6_000)).toEqual(windowsOf(7_000, 8_000).map(([first, last]) => ({ first, last, old: false })))
  })

  it('start the light client on a multiple of 1024 within 8,000 blocks of the newest, so two calls line their windows up', () => {
    for (const head of [FIRST_BLOCK, HEAD, HEAD + 1, HEAD + 1_023, HEAD + 5_000]) {
      const from = provenFromOf(head)
      expect(from % WINDOW).toBe(0)
      expect(head - from).toBeLessThanOrEqual(PROVEN_SPAN)
      expect(head - from).toBeGreaterThan(PROVEN_SPAN - WINDOW)
    }
    expect(provenFromOf(HEAD + 1) - provenFromOf(HEAD)).toBeLessThanOrEqual(WINDOW)
  })
})

describe('old history from the servers', () => {
  it('opens a name whose records were written long before the light client\'s ring, which the light client alone refuses', async () => {
    const world = old()
    const { chain, proven, servers } = twoProviders(world)
    expect(pointers(await resolveOg(chain, NAME.label, { session: createSession(), census: census() }))).toEqual(PASSING)
    const from = provenFromOf(HEAD)
    // Every log the light client was asked for is inside what it proves, and none the servers were asked for reaches into it.
    expect(proven.asked.logs.length).toBeGreaterThan(0)
    for (const filter of proven.asked.logs) expect(filter.fromBlock).toBeGreaterThanOrEqual(from)
    expect(servers.asked.logs.length).toBeGreaterThan(0)
    for (const filter of servers.asked.logs) {
      expect(filter.toBlock).toBeLessThan(from)
      expect(filter.toBlock - filter.fromBlock + 1).toBeLessThanOrEqual(OLD_WINDOW)
    }
    const alone = twoProviders(world, { servers: false })
    await expect(resolveOg(alone.chain, NAME.label, { session: createSession(), census: census() })).rejects.toBeInstanceOf(OgRefusal)
  })

  it('reads the state at the newest block through the light client only', async () => {
    const { chain, proven, servers } = twoProviders(old())
    await resolveOg(chain, NAME.label, { session: createSession(), census: census() })
    expect(proven.asked.calls.length).toBeGreaterThan(0)
    expect(proven.asked.storage.length).toBeGreaterThan(0)
    expect(servers.asked.calls).toEqual([])
    expect(servers.asked.storage).toEqual([])
    expect(servers.asked.blocks).toEqual([])
  })

  it('covers the old stretch without a gap, from the block after the census to the block before the light client\'s', async () => {
    const { chain, servers } = twoProviders(old())
    await resolveOg(chain, NAME.label, { session: createSession(), census: census() })
    const named = servers.asked.logs.filter((filter) => (filter.address as readonly string[] | undefined)?.length === 2).sort((a, b) => a.fromBlock - b.fromBlock)
    expect(named[0]?.fromBlock).toBe(CHECKPOINT + 1)
    expect(named.at(-1)?.toBlock).toBe(provenFromOf(HEAD) - 1)
    named.slice(1).forEach((filter, index) => { expect(filter.fromBlock).toBe((named[index]?.toBlock ?? 0) + 1) })
  })

  it('asks the light client alone for a name changed within the newest blocks, and the servers only for the empty stretch before', async () => {
    const world = worldOf(NAME, { spread: 100, head: HEAD, first: HEAD - 3_000 })
    const { chain, proven, servers } = twoProviders(world)
    expect(pointers(await resolveOg(chain, NAME.label, { session: createSession(), census: census() }))).toEqual(PASSING)
    expect(proven.asked.logs.length).toBeGreaterThan(0)
    expect(servers.asked.logs.length).toBeGreaterThan(0)
    expect(world.logs.every((log) => log.blockNumber >= provenFromOf(HEAD))).toBe(true)
  })

  it('asks the servers for two things at once at most, however many scans want them', async () => {
    const { chain: base, servers } = twoProviders(old())
    let open = 0
    let most = 0
    const slow: Eip1193Provider = {
      request: async (args) => {
        open++
        most = Math.max(most, open)
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return await servers.request(args)
        } finally {
          open--
        }
      }
    }
    const chain: Chain = { ...base, servers: eip1193Chain(slow, { maxSpan: OLD_WINDOW }) }
    expect(pointers(await resolveOg(chain, NAME.label, { session: createSession(), census: census() }))).toEqual(PASSING)
    expect(most).toBe(OLD_IN_FLIGHT)
  })

  it('reads the transaction behind an old registry log from the servers and none from the light client', async () => {
    const { chain, proven, servers } = twoProviders(old())
    await resolveOg(chain, NAME.label, { session: createSession(), census: census() })
    expect(servers.asked.transactions.length).toBeGreaterThan(0)
    expect(proven.asked.transactions).toEqual([])
  })

  it('reads the transaction behind a log of the newest blocks from the light client', async () => {
    const { chain, proven, servers } = twoProviders(worldOf(NAME, { spread: 100, head: HEAD, first: HEAD - 3_000 }))
    await resolveOg(chain, NAME.label, { session: createSession(), census: census() })
    expect(proven.asked.transactions.length).toBeGreaterThan(0)
    expect(servers.asked.transactions).toEqual([])
  })

  it('keeps what the servers answered, so a second lookup asks them only for what is new', async () => {
    const { chain, servers } = twoProviders(old())
    const session = createSession()
    await resolveOg(chain, NAME.label, { session, census: census() })
    const first = servers.asked.logs.length
    await resolveOg(chain, NAME.label, { session, census: census() })
    expect(servers.asked.logs.length).toBe(first)
  })

  it('answers the same as when every read is the light client\'s, over a history with an old stretch that only the servers read', async () => {
    const world = old()
    const everything = fakeProvider(world)
    const light = eip1193Chain(everything)
    const both = twoProviders(world)
    expect(provenFromOf(HEAD)).toBeGreaterThan(CHECKPOINT + 1)
    const asked = await resolveOg(light, NAME.label, { session: createSession(), census: census() })
    expect(pointers(await resolveOg(both.chain, NAME.label, { session: createSession(), census: census() }))).toEqual(pointers(asked))
    expect(pointers(asked)).toEqual(PASSING)
    expect(both.servers.asked.logs.length).toBeGreaterThan(0)
    expect(both.servers.asked.transactions.length).toBeGreaterThan(0)
  })

  it('does not widen a read of the light client: with no servers every window is 1024 blocks', async () => {
    const { chain, proven } = twoProviders(worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 20_000 }), { servers: false })
    await resolveOg(chain, NAME.label, { session: createSession(), census: census() }).catch(() => undefined)
    expect(proven.asked.logs.length).toBeGreaterThan(0)
    for (const filter of proven.asked.logs) expect(filter.toBlock - filter.fromBlock + 1).toBeLessThanOrEqual(WINDOW)
  })
})

describe('a range the servers refuse as too wide', () => {
  it('is read as its two halves, again and again down to the narrowest', async () => {
    const { chain, servers } = twoProviders(old(), { span: 3_000 })
    expect(pointers(await resolveOg(chain, NAME.label, { session: createSession(), census: census() }))).toEqual(PASSING)
    const widths = servers.asked.logs.map((filter) => filter.toBlock - filter.fromBlock + 1)
    expect(Math.max(...widths)).toBe(OLD_WINDOW)
    expect(widths.some((width) => width > 3_000)).toBe(true)
    expect(widths.some((width) => width <= 3_000 && width >= MIN_OLD_WINDOW)).toBe(true)
    // What was asked for and answered covers the stretch whole: the halves of a refused range are two ranges that meet.
    const answered = servers.asked.logs.filter((filter) => filter.toBlock - filter.fromBlock + 1 <= 3_000 && (filter.address as readonly string[] | undefined)?.length === 2).sort((a, b) => a.fromBlock - b.fromBlock)
    answered.slice(1).forEach((filter, index) => { expect(filter.fromBlock).toBe((answered[index]?.toBlock ?? 0) + 1) })
  })

  it('fails in the servers\' words when even the narrowest is refused, and asks for nothing narrower than that', async () => {
    const { chain, servers } = twoProviders(old(), { span: 500 })
    await expect(resolveOg(chain, NAME.label, { session: createSession(), census: census() })).rejects.toMatchObject({ reason: 'limit' })
    for (const filter of servers.asked.logs) expect(filter.toBlock - filter.fromBlock + 1).toBeGreaterThanOrEqual(MIN_OLD_WINDOW)
  })

  it('opens the name from servers that take 1,125 blocks, the width a window of 9,000 reaches in three halvings', async () => {
    const { chain, servers } = twoProviders(old(), { span: 1_125 })
    expect(pointers(await resolveOg(chain, NAME.label, { session: createSession(), census: census() }))).toEqual(PASSING)
    const widths = servers.asked.logs.map((filter) => filter.toBlock - filter.fromBlock + 1)
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(MIN_OLD_WINDOW)
  })

  it('opens the name from servers that take only 1,030 blocks: a half that would be narrower than `MIN_OLD_WINDOW` is cut at it, and the rest is read after', async () => {
    const { chain, servers } = twoProviders(old(), { span: 1_030 })
    expect(pointers(await resolveOg(chain, NAME.label, { session: createSession(), census: census() }))).toEqual(PASSING)
    const read = servers.asked.logs.filter((filter) => filter.toBlock - filter.fromBlock + 1 <= 1_030 && (filter.address as readonly string[] | undefined)?.length === 2).sort((a, b) => a.fromBlock - b.fromBlock)
    expect(read.some((filter) => filter.toBlock - filter.fromBlock + 1 === MIN_OLD_WINDOW)).toBe(true)
    // The first stretch of the servers is read whole, as ranges that meet.
    const first = read.filter((filter) => filter.fromBlock <= CHECKPOINT + OLD_WINDOW)
    first.slice(1).forEach((filter, index) => { expect(filter.fromBlock).toBe((first[index]?.toBlock ?? 0) + 1) })
  })

  it('does not read servers that take less than `MIN_OLD_WINDOW`, and never asks them for less', async () => {
    const { chain, servers } = twoProviders(old(), { span: MIN_OLD_WINDOW - 1 })
    await expect(resolveOg(chain, NAME.label, { session: createSession(), census: census() })).rejects.toMatchObject({ reason: 'limit' })
    for (const filter of servers.asked.logs) expect(filter.toBlock - filter.fromBlock + 1).toBeGreaterThanOrEqual(MIN_OLD_WINDOW)
  })

  it('stops halving when the call is out of time: no half is asked after the deadline', async () => {
    let t = 1_000_000
    // Every answer takes 20 s of a clock the session reads, and the servers take 3,000 blocks at most.
    const { chain, servers } = twoProviders(old(), { span: 3_000, serverFaults: { logs: () => { t += 20_000; return undefined } } })
    const session = createSession({ now: () => t })
    const failure = await resolveOg(chain, NAME.label, { session, census: census(), deadlineAt: t + 30_000 + FINISH_RESERVE_MS }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OgRefusal)
    expect(servers.asked.logs.filter((filter) => filter.toBlock - filter.fromBlock + 1 <= 3_000)).toHaveLength(2)
  })
})

describe('servers that rate limit', () => {
  /** A clock the waits move, and the waits asked of it. */
  function clock (): { now: () => number, sleep: (ms: number) => Promise<void>, waits: number[] } {
    let t = 1_000_000
    const waits: number[] = []
    return { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms }, waits }
  }
  const limited = (times: number, retryAfterMs?: number): NonNullable<Faults['logs']> => {
    let left = times
    return () => left-- > 0 ? new ChainError('rateLimited', 'rate limited', { retryAfterMs }) : undefined
  }

  it('is asked again after a wait, and the name opens', async () => {
    const time = clock()
    const { chain } = twoProviders(old(), { serverFaults: { logs: limited(3) } })
    const session = createSession({ now: time.now, sleep: time.sleep })
    expect(pointers(await resolveOg(chain, NAME.label, { session, census: census(), deadlineAt: time.now() + 120_000 }))).toEqual(PASSING)
    expect(time.waits.length).toBeGreaterThan(0)
    expect(Math.min(...time.waits)).toBeGreaterThanOrEqual(1_000)
    expect(Math.max(...time.waits)).toBeLessThanOrEqual(BACKOFF_CAP_MS)
  })

  it('waits as long as the server asked, never less than a second, when the time left allows it', async () => {
    const time = clock()
    const { chain } = twoProviders(old(), { serverFaults: { logs: limited(1, 3_000) } })
    await resolveOg(chain, NAME.label, { session: createSession({ now: time.now, sleep: time.sleep }), census: census(), deadlineAt: time.now() + 120_000 })
    expect(time.waits).toContain(3_000)
    const zero = clock()
    const second = twoProviders(old(), { serverFaults: { logs: limited(1, 0) } })
    await resolveOg(second.chain, NAME.label, { session: createSession({ now: zero.now, sleep: zero.sleep }), census: census(), deadlineAt: zero.now() + 120_000 })
    expect(zero.waits).toContain(1_000)
    // Longer than the cap the wait is not named by the server: the whole of what it asked, when it fits.
    const long = clock()
    const third = twoProviders(old(), { serverFaults: { logs: limited(1, 20_000) } })
    await resolveOg(third.chain, NAME.label, { session: createSession({ now: long.now, sleep: long.sleep }), census: census(), deadlineAt: long.now() + 120_000 })
    expect(long.waits).toContain(20_000)
  })

  it('refuses at once, waiting for nothing, when the server asked for longer than the call has', async () => {
    const time = clock()
    const { chain } = twoProviders(old(), { serverFaults: { logs: limited(1, 10 * 60_000) } })
    const failure = await resolveOg(chain, NAME.label, { session: createSession({ now: time.now, sleep: time.sleep }), census: census(), deadlineAt: time.now() + 120_000 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OgRefusal)
    expect(failure).toMatchObject({ message: expect.stringMatching(/limiting how fast.*try again shortly/) })
    expect(time.waits).toEqual([])
  })

  it('never doubles past the cap when the server named no wait', async () => {
    const time = clock()
    const { chain } = twoProviders(old(), { serverFaults: { logs: limited(4) } })
    await resolveOg(chain, NAME.label, { session: createSession({ now: time.now, sleep: time.sleep }), census: census(), deadlineAt: time.now() + 3_600_000 })
    expect(Math.max(...time.waits)).toBeLessThanOrEqual(BACKOFF_CAP_MS)
  })

  it('refuses in words, without sleeping, when the wait another call was told is longer than this call has left', async () => {
    const time = clock()
    const { chain, servers } = twoProviders(old())
    const session = createSession({ now: time.now, sleep: time.sleep })
    // A server told some other call to leave it alone for 20 s.
    session.cooling.until = time.now() + 20_000
    const failure = await resolveOg(chain, NAME.label, { session, census: census(), deadlineAt: time.now() + FINISH_RESERVE_MS + 2_000 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OgRefusal)
    expect(failure).toMatchObject({ message: expect.stringMatching(/limiting how fast.*try again shortly/) })
    expect(time.waits).toEqual([])
    expect(servers.asked.logs).toEqual([])
  })

  it('waits out a cooling that fits in the time the call has, and then reads', async () => {
    const time = clock()
    const { chain } = twoProviders(old())
    const session = createSession({ now: time.now, sleep: time.sleep })
    session.cooling.until = time.now() + 5_000
    expect(pointers(await resolveOg(chain, NAME.label, { session, census: census(), deadlineAt: time.now() + 120_000 }))).toEqual(PASSING)
    expect(time.waits).toEqual([5_000])
  })

  it('gives up after a few tries and says so', async () => {
    const time = clock()
    const { chain } = twoProviders(old(), { serverFaults: { logs: limited(1_000) } })
    const session = createSession({ now: time.now, sleep: time.sleep })
    await expect(resolveOg(chain, NAME.label, { session, census: census(), deadlineAt: time.now() + 3_600_000 })).rejects.toBeInstanceOf(OgRefusal)
  })

  it('asks the servers again for the transaction behind a registry log', async () => {
    const time = clock()
    const world = old()
    let refused = 1
    const { chain, servers } = twoProviders(world, { serverFaults: { transactionAt: () => refused-- > 0 ? new ChainError('rateLimited', 'rate limited') : undefined } })
    expect(pointers(await resolveOg(chain, NAME.label, { session: createSession({ now: time.now, sleep: time.sleep }), census: census(), deadlineAt: time.now() + 120_000 }))).toEqual(PASSING)
    expect(servers.asked.transactions.length).toBeGreaterThan(1)
    expect(time.waits).toContain(1_000)
  })
})

describe('what the servers say is not what the light client proves', () => {
  it('can hide a record, never change one: servers that answer no log leave the proven value and no history to count it with', async () => {
    const world = old()
    const { chain } = twoProviders(world, { serversWorld: { ...world, logs: [] } })
    const found = await inspectOg(chain, NAME.label, { session: createSession(), census: census() })
    expect(found.refusal).toBeNull()
    expect(found.reads.values['content.ipfs']).toBe('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
    expect(found.verdict?.records).toEqual([])
  })
})

describe('what a server said to refuse a read, as the resolver reads it', () => {
  const failing = (error: unknown): ReturnType<typeof eip1193Chain> => eip1193Chain({ request: async () => { throw error } })
  const caught = async (error: unknown): Promise<ChainError> => await failing(error).getLogs({ fromBlock: 1, toBlock: 2 }).then(() => undefined, (thrown: unknown) => thrown) as ChainError

  it('reads a 429 and a 503 that asked for a wait as a rate limit, with the wait', async () => {
    expect(await caught({ code: 429, message: 'slow down', retryAfterMs: 2_000 })).toMatchObject({ reason: 'rateLimited', retryAfterMs: 2_000 })
    expect(await caught({ code: 503, message: 'the execution servers answered 503', retryAfterMs: 4_000 })).toMatchObject({ reason: 'rateLimited', retryAfterMs: 4_000 })
    expect(await caught({ code: 503, message: 'the execution servers answered 503', retryAfterMs: 0 })).toMatchObject({ reason: 'rateLimited', retryAfterMs: 0 })
  })

  it('reads a 503 that asked for nothing as a server that is not there', async () => {
    expect(await caught({ code: 503, message: 'the execution servers answered 503' })).toMatchObject({ reason: 'unavailable' })
  })
})
