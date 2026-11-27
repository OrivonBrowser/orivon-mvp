import { describe, expect, it, vi } from 'vitest'
import { ChainError } from '../chain.js'
import type { Chain, LogFilter } from '../chain.js'
import type { NameEntry } from '../census.js'
import { inspectOg, resolveOg } from '../lookup.js'
import { PROXY, TOPICS } from '../pins.js'
import { FINISH_RESERVE_MS, OgRefusal, createSession, readTransactions, scanLogs, WINDOW, windowsOf } from '../tail.js'
import type { Scan } from '../tail.js'
import { censusAt, fakeChain, FIRST_BLOCK, transactionHashOf, worldOf } from './world.js'
import type { Faults, World } from './world.js'
import { VECTORS } from './vectors.js'

const vector = (id: string): (typeof VECTORS)[number] => VECTORS.find((one) => one.id === id) as (typeof VECTORS)[number]
const NAME = vector('unwrapped-passes')
const CHECKPOINT = FIRST_BLOCK - 1_000
const census = (names: Record<string, NameEntry> = {}, block = CHECKPOINT): ReturnType<typeof censusAt> => censusAt(block, names)
const PASSING = [{ kind: 'ipfs', cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }]
const pointers = (records: Awaited<ReturnType<typeof resolveOg>>): unknown[] => records.map((record) => record.pointer)

/** A chain whose every log query takes `perWindowMs` of a clock the session reads. */
function clocked (world: World, perWindowMs: number, faults: Faults = {}): ReturnType<typeof fakeChain> & { now: () => number } {
  let t = 1_000_000
  const hook = faults.logs
  const made = fakeChain(world, { faults: { ...faults, logs: (filter) => { t += perWindowMs; return hook?.(filter) } } })
  return { ...made, now: () => t }
}

/** The windows a name's scan and the upgrade scan ask over a tail of `blocks`: the same ranges, twice. */
const longWorld = (blocks: number): World => worldOf(NAME, { spread: 300, head: FIRST_BLOCK + blocks })

describe('windowsOf', () => {
  it('covers a range in windows of 1024, both ends counted', () => {
    expect(windowsOf(10, 9)).toEqual([])
    expect(windowsOf(10, 10)).toEqual([[10, 10]])
    expect(windowsOf(1, WINDOW)).toEqual([[1, WINDOW]])
    expect(windowsOf(1, WINDOW + 1)).toEqual([[1, WINDOW], [WINDOW + 1, WINDOW + 1]])
    expect(windowsOf(5, 5 + 3 * WINDOW - 1)).toHaveLength(3)
  })
})

describe('the budget of a call', () => {
  it('answers when the tail fits in the time the call has', async () => {
    const { chain, now } = clocked(worldOf(NAME, { spread: 300 }), 100)
    const answer = await resolveOg(chain, NAME.label, { session: createSession({ now }), census: census(), deadlineAt: now() + 30_000 })
    expect(pointers(answer)).toEqual(PASSING)
  })

  it('refuses in words, and never answers in part, when the tail is too long for the time the call has', async () => {
    const { chain, asked, now } = clocked(longWorld(150_000), 1_000)
    const failure = await resolveOg(chain, NAME.label, { session: createSession({ now }), census: census(), deadlineAt: now() + 30_000 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(OgRefusal)
    expect(failure).toMatchObject({ message: expect.stringMatching(/Still checking (?:the recent history of .*\.og|the resolver contract for upgrades): \d+ of \d+ stretches of the chain are left.*try again shortly/) })
    const windows = windowsOf(CHECKPOINT + 1, FIRST_BLOCK + 150_000).length
    expect(asked.logs.length).toBeGreaterThan(0)
    expect(asked.logs.length).toBeLessThan(2 * windows)
  })

  it('keeps what a call read, so asking again finishes the tail without asking for a window twice', async () => {
    const { chain, asked, now } = clocked(longWorld(150_000), 1_000)
    const session = createSession({ now })
    let refusals = 0
    let answer
    while (answer === undefined && refusals < 20) {
      try {
        answer = await resolveOg(chain, NAME.label, { session, census: census(), deadlineAt: now() + 30_000 })
      } catch (error) {
        expect(error).toBeInstanceOf(OgRefusal)
        refusals++
      }
    }
    expect(refusals).toBeGreaterThan(0)
    expect(pointers(answer ?? [])).toEqual(PASSING)
    const asks = asked.logs.map((filter) => JSON.stringify([filter.address, filter.topics, filter.fromBlock, filter.toBlock]))
    // Only windows ending within the last 64 blocks are asked again: they may still change.
    const repeated = asks.length - new Set(asks).size
    expect(repeated).toBeLessThanOrEqual(2 * refusals + 4)
  })

  it('refuses before asking for anything when less time is left than the call keeps for itself', async () => {
    const { chain, asked, now } = clocked(worldOf(NAME, { spread: 300 }), 10)
    await expect(resolveOg(chain, NAME.label, { session: createSession({ now }), census: census(), deadlineAt: now() + FINISH_RESERVE_MS - 500 })).rejects.toBeInstanceOf(OgRefusal)
    expect(asked.logs).toEqual([])
  })

  it('stops waiting for a window another call is reading when its own time is up', async () => {
    const made = fakeChain(worldOf(NAME, { spread: 300 }))
    const stuck = new Promise<never>(() => {})
    const chain = { ...made.chain, getLogs: async () => await stuck } as Chain
    const started = Date.now()
    await expect(resolveOg(chain, NAME.label, { session: createSession(), census: census(), deadlineAt: Date.now() + FINISH_RESERVE_MS + 150 })).rejects.toBeInstanceOf(OgRefusal)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('stops when the asker leaves, with the reason the asker gave', async () => {
    const controller = new AbortController()
    const made = fakeChain(longWorld(40_000), { faults: { logs: () => { controller.abort(new Error('the asker left')); return undefined } } })
    await expect(resolveOg(made.chain, NAME.label, { session: createSession(), census: census(), signal: controller.signal })).rejects.toThrow('the asker left')
  })
})

describe('the windows of one resolver', () => {
  it('asks the node once for a window, whoever needs it and however many lookups there are', async () => {
    const { chain, asked } = fakeChain(worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 5_000 }))
    const session = createSession()
    await resolveOg(chain, NAME.label, { session, census: census() })
    const first = asked.logs.length
    expect(first).toBeGreaterThan(0)
    // Only the windows within 64 blocks of the head are asked again: they may still change.
    await resolveOg(chain, NAME.label, { session, census: census() })
    expect(asked.logs.length - first).toBeLessThanOrEqual(2)
  })

  it('makes the one upgrade scan for every name, and a scan of its own for each', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 5_000 })
    const other = vector('unwrapped-leftover-rewritten')
    const more = worldOf(other, { spread: 300 })
    Object.assign(world.names, more.names)
    world.logs.push(...more.logs)
    const { chain, asked } = fakeChain(world)
    const session = createSession()
    await resolveOg(chain, NAME.label, { session, census: census() })
    await resolveOg(chain, other.label, { session, census: census() })
    const windows = windowsOf(CHECKPOINT + 1, world.head).length
    const upgrades = asked.logs.filter((filter) => filter.topics?.[0] === TOPICS.upgraded)
    // The last window is within 64 blocks of the head, so it is read again by the second call.
    expect(upgrades.length).toBeLessThanOrEqual(windows + 1)
    expect(upgrades.length).toBeGreaterThanOrEqual(windows)
    expect(asked.logs.length - upgrades.length).toBeGreaterThanOrEqual(2 * windows)
  })

  it('asks again for a window that failed, and for no other', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 5_000 })
    let failing = true
    const { chain, asked } = fakeChain(world, { faults: { logs: () => failing ? new ChainError('unavailable', 'down') : undefined } })
    const session = createSession()
    await expect(resolveOg(chain, NAME.label, { session, census: census() })).rejects.toMatchObject({ reason: 'unavailable' })
    failing = false
    const before = asked.logs.length
    expect(pointers(await resolveOg(chain, NAME.label, { session, census: census() }))).toEqual(PASSING)
    expect(asked.logs.length - before).toBeGreaterThan(0)
  })
})

describe('the block every read is pinned to', () => {
  const blocksOf = (asked: ReturnType<typeof fakeChain>['asked']): { reads: Set<number>, storage: Set<number>, logsEnd: number } => ({
    reads: new Set(asked.calls.map((call) => call.block)),
    storage: new Set(asked.storage.map((read) => read.block)),
    logsEnd: Math.max(...asked.logs.map((filter) => filter.toBlock))
  })

  it('is the newest verified block, for the state, the implementation slot and the end of every log range', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000 })
    const { chain, asked } = fakeChain(world)
    const answer = await resolveOg(chain, NAME.label, { session: createSession(), census: census() })
    const { reads, storage, logsEnd } = blocksOf(asked)
    expect([...reads]).toEqual([FIRST_BLOCK + 3_000])
    expect([...storage]).toEqual([FIRST_BLOCK + 3_000])
    expect(logsEnd).toBe(FIRST_BLOCK + 3_000)
    expect(answer[0]?.provenance).toEqual({ via: 'chain', block: FIRST_BLOCK + 3_000, offchain: false })
  })

  it('is never before the census checkpoint', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000 })
    const { chain, asked } = fakeChain(world)
    await resolveOg(chain, NAME.label, { session: createSession(), census: census({}, FIRST_BLOCK + 5_000) })
    expect([...blocksOf(asked).reads]).toEqual([FIRST_BLOCK + 5_000])
  })

  it('has no log range wider than 1024 blocks', async () => {
    const { chain, asked } = fakeChain(worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 40_000 }))
    await resolveOg(chain, NAME.label, { session: createSession(), census: census() })
    for (const filter of asked.logs) expect(filter.toBlock - filter.fromBlock + 1).toBeLessThanOrEqual(WINDOW)
  })
})

describe('the pace of the windows', () => {
  /** A node that answers one log query at a time, `service.ms` each, on the fake timers: a light client a resolver asks through its queue. */
  function serialNode (world: World, service: { ms: number }): { chain: Chain, asked: () => number } {
    const made = fakeChain(world)
    let line: Promise<unknown> = Promise.resolve()
    let asked = 0
    const chain = {
      ...made.chain,
      getLogs: async (filter: LogFilter) => {
        asked++
        const turn = line.then(async () => await new Promise((resolve) => setTimeout(resolve, service.ms))).then(async () => await made.chain.getLogs(filter))
        line = turn.catch(() => {})
        return await turn
      }
    } as Chain
    return { chain, asked: () => asked }
  }

  /** One lookup with the 30 seconds a call has, on the fake timers: what it did and how many windows it asked for. */
  async function call (chain: Chain, session: ReturnType<typeof createSession>, asked: () => number): Promise<{ outcome: string, started: number }> {
    const before = asked()
    const attempt = resolveOg(chain, NAME.label, { session, census: census(), deadlineAt: Date.now() + 30_000 }).then(() => 'answered', (error: unknown) => error instanceof OgRefusal ? 'refused' : String(error))
    await vi.advanceTimersByTimeAsync(31_000)
    return { outcome: await attempt, started: asked() - before }
  }

  it('does not let one slow stretch stop every later lookup: each call may start a round of windows, so the tail is read call by call', async () => {
    vi.useFakeTimers()
    try {
      const { chain, asked } = serialNode(longWorld(30 * WINDOW), { ms: 3_000 })
      const session = createSession()
      const calls: { outcome: string, started: number }[] = []
      do calls.push(await call(chain, session, asked)); while (calls.at(-1)?.outcome === 'refused' && calls.length < 12)
      expect(calls.at(-1)?.outcome, JSON.stringify(calls)).toBe('answered')
      // A round is eight windows a scan; the last refusal may have fewer left to start.
      for (const { started } of calls.slice(0, -2)) expect(started, JSON.stringify(calls)).toBeGreaterThanOrEqual(8)
      expect(calls.at(-2)?.started, JSON.stringify(calls)).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers in one call once the node is fast again, though it was slow before: what it learned is not kept for good', async () => {
    vi.useFakeTimers()
    try {
      const service = { ms: 3_000 }
      const { chain, asked } = serialNode(longWorld(30 * WINDOW), service)
      const session = createSession()
      expect((await call(chain, session, asked)).outcome).toBe('refused')
      expect((await call(chain, session, asked)).outcome).toBe('refused')
      service.ms = 20
      expect((await call(chain, session, asked)).outcome).toBe('answered')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the turns of the windows of one resolver', () => {
  /** A node whose answers the test gives one by one. */
  function manualNode (): { chain: Chain, asked: { filter: LogFilter, release: () => void }[] } {
    const asked: { filter: LogFilter, release: () => void }[] = []
    const chain = { getLogs: async (filter: LogFilter) => await new Promise((resolve) => { asked.push({ filter, release: () => { resolve([]) } }) }) } as unknown as Chain
    return { chain, asked }
  }
  const scanOf = (id: string, windows: number): Scan => ({ id, address: PROXY, topics: [id === 'a' ? TOPICS.upgraded : id === 'b' ? TOPICS.changed : TOPICS.newController], from: 1, to: windows * WINDOW, accept: () => true })
  const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }
  const topicsOf = (asked: { filter: LogFilter }[]): unknown[] => asked.map(({ filter }) => filter.topics?.[0])

  it('has no more windows in flight than the resolver may have open, whoever wants them', async () => {
    const { chain, asked } = manualNode()
    const session = createSession()
    void scanLogs(chain, session, scanOf('a', 20), { call: {}, final: 20 * WINDOW }).catch(() => {})
    void scanLogs(chain, session, scanOf('b', 20), { call: {}, final: 20 * WINDOW }).catch(() => {})
    await settle()
    expect(asked).toHaveLength(8)
  })

  it('gives the next turn to the call holding the fewest windows, so a long call does not keep a short one waiting', async () => {
    const { chain, asked } = manualNode()
    const session = createSession()
    void scanLogs(chain, session, scanOf('a', 20), { call: {}, final: 20 * WINDOW }).catch(() => {})
    await settle()
    void scanLogs(chain, session, scanOf('b', 3), { call: {}, final: 3 * WINDOW }).catch(() => {})
    await settle()
    expect(topicsOf(asked)).toEqual(Array(8).fill(TOPICS.upgraded))
    for (let freed = 0; freed < 3; freed++) { asked[freed]?.release(); await settle() }
    expect(topicsOf(asked).slice(8)).toEqual(Array(3).fill(TOPICS.changed))
    asked[3]?.release()
    await settle()
    expect(topicsOf(asked).slice(11)).toEqual([TOPICS.upgraded])
  })

  it('stops waiting for a turn when the asker leaves', async () => {
    const { chain } = manualNode()
    const session = createSession()
    void scanLogs(chain, session, scanOf('a', 20), { call: {}, final: 20 * WINDOW }).catch(() => {})
    await settle()
    const controller = new AbortController()
    const waiting = scanLogs(chain, session, scanOf('b', 3), { call: {}, final: 3 * WINDOW, signal: controller.signal }).catch((error: unknown) => error)
    await settle()
    controller.abort(new Error('the asker left'))
    const left = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => { resolve('still waiting') }, 500))])
    expect(left).toMatchObject({ message: 'the asker left' })
  })
})

describe('the windows a resolver keeps', () => {
  const blocks = (asked: ReturnType<typeof fakeChain>['asked']): number[] => asked.logs.map((filter) => filter.toBlock)

  it('keeps the windows that end 64 or more blocks behind the head, and reads the ones above them again', async () => {
    const world = worldOf(NAME, { spread: 300, head: FIRST_BLOCK + 3_000 })
    const { chain, asked } = fakeChain(world)
    const lookup = { session: createSession(), census: census() }
    await inspectOg(chain, NAME.label, lookup)
    const first = blocks(asked).length
    await inspectOg(chain, NAME.label, lookup)
    const second = blocks(asked).slice(first)
    // Two scans over four windows: the windows ending below head - 64 are kept, the last one (ending at the head) is read again by each.
    expect(first).toBe(8)
    expect(second.sort((a, b) => a - b)).toEqual([FIRST_BLOCK + 3_000, FIRST_BLOCK + 3_000])
  })
})

describe("readTransactions: the transactions behind a name's registry logs", () => {
  const SLOT = vector('registry-content-rewritten-mainnet')
  const FINAL = 26_450_000
  /** The transactions behind every log of the name, as the node lists them: hash and block. */
  const wantedOf = (world: World): { hash: string, blockNumber: number }[] => world.logs.filter((log) => log.topics[0] === TOPICS.changed).map((log) => ({ hash: transactionHashOf(log), blockNumber: log.blockNumber }))
  const slotWorld = (): World => worldOf(SLOT, { spread: 100, first: 26_400_100 })

  it('answers each transaction in the order asked, and keeps a final one for the resolver', async () => {
    const world = slotWorld()
    const made = fakeChain(world)
    const session = createSession()
    const wanted = wantedOf(world)
    const found = await readTransactions(made.chain, session, wanted, { final: FINAL })
    expect(found.map((one) => one.hash)).toEqual(wanted.map((one) => one.hash))
    expect(made.asked.transactions).toHaveLength(wanted.length)
    await readTransactions(made.chain, session, [...wanted].reverse(), { final: FINAL })
    expect(made.asked.transactions).toHaveLength(wanted.length)
    expect(session.transactions.size).toBe(wanted.length)
  })

  it('asks again for a transaction in a block that is not final: a reorganisation may have replaced it', async () => {
    const world = slotWorld()
    const made = fakeChain(world)
    const session = createSession()
    const wanted = wantedOf(world)
    await readTransactions(made.chain, session, wanted, { final: 0 })
    await readTransactions(made.chain, session, wanted, { final: 0 })
    expect(made.asked.transactions).toHaveLength(wanted.length * 2)
    expect(session.transactions.size).toBe(0)
  })

  it('refuses, saying the node has no transaction, when it answers null for one; the answer is not kept, so a later try reads it', async () => {
    const world = slotWorld()
    let hide = true
    const real = fakeChain(world).chain
    const made = fakeChain(world, { faults: { transaction: async (hash) => hide ? null : await real.getTransaction(hash) } })
    const session = createSession()
    const wanted = wantedOf(world)
    await expect(readTransactions(made.chain, session, wanted, { final: FINAL })).rejects.toThrow(/no transaction behind/)
    expect(session.transactions.size).toBe(0)
    hide = false
    expect(await readTransactions(made.chain, session, wanted, { final: FINAL })).toHaveLength(wanted.length)
  })

  it('refuses rather than answer in part when the time runs out, and keeps what it read', async () => {
    const world = slotWorld()
    let t = 1_000_000
    const made = fakeChain(world)
    const wanted = wantedOf(world)
    const slow = { ...made.chain, getTransaction: async (hash: string) => { if (hash !== wanted[0]?.hash) await new Promise(() => {}); return await made.chain.getTransaction(hash) } } as Chain
    const session = createSession({ now: () => t })
    const pending = readTransactions(slow, session, wanted, { deadlineAt: t + FINISH_RESERVE_MS + 50, final: FINAL })
    await new Promise((resolve) => setTimeout(resolve, 20))
    t += 10_000
    await expect(pending).rejects.toBeInstanceOf(OgRefusal)
    expect(session.transactions.has((wanted[0]?.hash ?? '').toLowerCase())).toBe(true)
  })

  it("refuses when the node's answer cannot be read, and passes any other failure on", async () => {
    const world = slotWorld()
    const wanted = wantedOf(world)
    const failing = (error: Error): Chain => fakeChain(world, { faults: { transaction: () => { throw error } } }).chain
    await expect(readTransactions(failing(new ChainError('badAnswer', 'not a transaction')), createSession(), wanted, { final: FINAL })).rejects.toBeInstanceOf(OgRefusal)
    await expect(readTransactions(failing(new ChainError('unavailable', 'offline')), createSession(), wanted, { final: FINAL })).rejects.toMatchObject({ reason: 'unavailable' })
  })

  it("stops with the signal's reason before asking the node for anything", async () => {
    const world = slotWorld()
    const made = fakeChain(world)
    const controller = new AbortController()
    controller.abort(new Error('closed'))
    await expect(readTransactions(made.chain, createSession(), wantedOf(world), { signal: controller.signal, final: FINAL })).rejects.toThrow('closed')
    expect(made.asked.transactions).toEqual([])
  })
})
