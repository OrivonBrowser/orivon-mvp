import { describe, expect, it } from 'vitest'
import type { Eip1193Provider } from '../../ens/resolver.js'
import { eip1193Chain } from '../chain.js'
import { inspectOg, resolveOg } from '../lookup.js'
import { keyOf } from '../name.js'
import { PROXY, REGISTRY, TOPICS } from '../pins.js'
import { FINISH_RESERVE_MS, OLD_WINDOW, OgRefusal, createSession, scanLogs } from '../tail.js'
import type { Scan } from '../tail.js'
import { FIRST_BLOCK, upgradedLog, worldOf } from './world.js'
import { VECTORS } from './vectors.js'
import { CHECKPOINT, HEAD, NAME, PASSING, census, old, pointers, twoProviders } from './two-sources.js'

// What servers that say what they like, or say nothing, can do to a resolver that asks them for old history: refuse a name for as long as the
// call lasts at most, hold its turns for as long as it lasts at most, and make a stored record count when its holder did not write it.

describe('an upgrade of the resolver contract that only the servers logged', () => {
  it('refuses the call that was told it, and not a later one: the window that held it is not kept', async () => {
    const world = old()
    const lying = { ...world, logs: [...world.logs, upgradedLog(CHECKPOINT + 20_000)] }
    const { chain } = twoProviders(world, { serversWorld: lying })
    const session = createSession()
    const refused = await resolveOg(chain, NAME.label, { session, census: census() }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(OgRefusal)
    expect(refused).toMatchObject({ message: expect.stringMatching(/was upgraded after this resolver was built/) })
    // The servers answer truthfully the next time they are asked.
    lying.logs = world.logs
    expect(pointers(await resolveOg(chain, NAME.label, { session, census: census() }))).toEqual(PASSING)
  })

  it('refuses the calls waiting on that read, a second name asked meanwhile among them, and the next call asks the servers again', async () => {
    const other = VECTORS.find((one) => one.id === 'unwrapped-leftover-rewritten') as (typeof VECTORS)[number]
    const world = old()
    const more = worldOf(other, { spread: 300, head: HEAD })
    Object.assign(world.names, more.names)
    world.logs.push(...more.logs)
    const lying = { ...world, logs: [...world.logs, upgradedLog(CHECKPOINT + 20_000)] }
    const { chain, servers } = twoProviders(world, { serversWorld: lying })
    const session = createSession()
    const lookup = { session, census: census() }
    const [first, second] = await Promise.all([inspectOg(chain, NAME.label, lookup), inspectOg(chain, other.label, lookup)])
    expect(first.refusal).toBeInstanceOf(OgRefusal)
    expect(second.refusal).toBeInstanceOf(OgRefusal)
    // The second name joined the read of the first: each stretch of the servers was asked for upgrades once.
    const upgrades = servers.asked.logs.filter((filter) => filter.topics?.[0] === TOPICS.upgraded).map((filter) => `${String(filter.fromBlock)}-${String(filter.toBlock)}`)
    expect(upgrades.length).toBeGreaterThan(0)
    expect(new Set(upgrades).size).toBe(upgrades.length)
    const asked = servers.asked.logs.length
    lying.logs = world.logs
    expect((await inspectOg(chain, NAME.label, lookup)).refusal).toBeNull()
    expect((await inspectOg(chain, other.label, lookup)).refusal).toBeNull()
    expect(servers.asked.logs.length).toBeGreaterThan(asked)
  })
})

describe('servers that hang', () => {
  const KEY = keyOf(NAME.label)
  const scanOf = (id: string, topics: Scan['topics']): Scan => ({ id, address: [REGISTRY, PROXY], topics, from: CHECKPOINT + 1, to: HEAD, accept: () => true })

  it('give their turns back when the call that asked them is out of time, so the next call has its two', async () => {
    const { chain: base, servers } = twoProviders(old())
    // The name's own scan never gets an answer; any other does.
    const hanging: Eip1193Provider = {
      request: async (args) => {
        const [filter] = (args.params ?? []) as [{ topics?: (string | null)[] }]
        if (args.method === 'eth_getLogs' && filter.topics?.[0] === null) return await new Promise(() => {})
        return await servers.request(args)
      }
    }
    const chain = { ...base, servers: eip1193Chain(hanging, { maxSpan: OLD_WINDOW }) }
    const session = createSession()
    const first = await scanLogs(chain, session, scanOf('hung', [null, KEY]), { deadlineAt: Date.now() + FINISH_RESERVE_MS + 150 }).catch((error: unknown) => error)
    expect(first).toBeInstanceOf(OgRefusal)
    const second = await scanLogs(chain, session, scanOf('free', [TOPICS.changed]), { deadlineAt: Date.now() + FINISH_RESERVE_MS + 2_000 })
    expect(second.length).toBeGreaterThan(0)
  })
})

describe('a record the servers made count', () => {
  const vector = (id: string): (typeof VECTORS)[number] => VECTORS.find((one) => one.id === id) as (typeof VECTORS)[number]

  /** The vector's world, and the servers' copy of it with a text record set after the last change of holder, as an invented log. */
  function withInvented (id: string): ReturnType<typeof twoProviders> & { label: string } {
    const one = vector(id)
    const world = worldOf(one, { spread: 300, head: HEAD })
    const written = world.logs.find((log) => log.topics[0] === TOPICS.setTextRecord) ?? world.logs[0]
    const last = Math.max(...world.logs.map((log) => log.blockNumber))
    const invented = { address: PROXY, blockNumber: last + 100, logIndex: 0, topics: written?.topics ?? [] }
    return { ...twoProviders(world, { serversWorld: { ...world, logs: [...world.logs, invented] } }), label: one.label }
  }

  it('is the previous holder\'s stored record, when a name sold before the census has a text record written after the sale: the worst case this build accepts', async () => {
    const honest = twoProviders(worldOf(vector('unwrapped-sellers-leftover'), { spread: 300, head: HEAD }))
    expect(pointers(await resolveOg(honest.chain, vector('unwrapped-sellers-leftover').label, { session: createSession(), census: census() }))).toEqual([])
    const { chain, label } = withInvented('unwrapped-sellers-leftover')
    // The record that counts is the one the contract stores now, read through the light client: the servers' log only says it was written.
    expect(pointers(await resolveOg(chain, label, { session: createSession(), census: census() }))).toEqual(PASSING)
  })

  it('is never a value the contract does not store: a name with no record has none, whatever the servers say', async () => {
    const { chain, label } = withInvented('no-records')
    expect(pointers(await resolveOg(chain, label, { session: createSession(), census: census() }))).toEqual([])
    const found = await inspectOg(chain, label, { session: createSession(), census: census() })
    expect(Object.values(found.reads.values).every((value) => value === '')).toBe(true)
  })

  it('does not make a record count in a name whose controller is not its holder, as no log can', async () => {
    const one = vector('unwrapped-controller-not-holder-mainnet')
    const world = worldOf(one, { spread: 300, head: HEAD })
    const { chain } = twoProviders(world, { serversWorld: { ...world, logs: [...world.logs, { address: PROXY, blockNumber: FIRST_BLOCK + 50_000, logIndex: 0, topics: world.logs.find((log) => log.topics[0] === TOPICS.setTextRecord)?.topics ?? [] }] } })
    expect(pointers(await resolveOg(chain, one.label, { session: createSession(), census: census() }))).toEqual([])
  })
})
