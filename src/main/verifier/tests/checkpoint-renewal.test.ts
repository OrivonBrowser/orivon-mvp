import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import shippedCheckpoint from '../mainnet-checkpoint.json'
import { MAINNET_GENESIS_SECONDS, SECONDS_PER_SLOT } from '../checkpoint.js'
import type { StoredCheckpoint } from '../checkpoint.js'
import { CheckpointRenewal } from '../checkpoint-renewal.js'
import { DEFAULT_ENDPOINTS } from '../endpoints.js'

const answers = vi.hoisted(() => new Map<string, unknown>())
const asked = vi.hoisted(() => [] as string[])
/** The second argument of each ask: the local server the request is for, if any. */
const askedLocal = vi.hoisted(() => [] as Array<string | undefined>)

vi.mock('../checkpoint-fetch-net.js', () => ({
  beaconJson: async (url: string, local?: string) => {
    asked.push(url)
    askedLocal.push(local)
    const answer = answers.get(url)
    if (answer === undefined) throw new (await import('../checkpoint-fetch.js')).NotFoundAnswer('404')
    return answer
  }
}))

const [CONSENSUS, OTHER] = DEFAULT_ENDPOINTS.checkpointBeaconApis
const SHIPPED_ROOT = shippedCheckpoint.root
const FRESH = `0x${'c'.repeat(64)}`
const HEAD = `0x${'e'.repeat(64)}`
const NOW_MS = (MAINNET_GENESIS_SECONDS + shippedCheckpoint.slot * SECONDS_PER_SLOT) * 1000 + 24 * 3600 * 1000
const EPOCH_FIRST = Math.floor((NOW_MS / 1000 - 1800 - MAINNET_GENESIS_SECONDS) / SECONDS_PER_SLOT / 32) * 32

/** Both servers vouch for `root` as the first block of the newest epoch and the first serves its bootstrap. */
function serve (root: string, slot = EPOCH_FIRST, head = EPOCH_FIRST + 31): void {
  for (const server of [CONSENSUS!, OTHER!]) {
    answers.set(`${server}/eth/v1/beacon/headers/finalized`, { execution_optimistic: false, finalized: true, data: { root: HEAD, canonical: true, header: { message: { slot: String(head) } } } })
    answers.set(`${server}/eth/v1/beacon/blocks/${String(slot)}/root`, { data: { root } })
  }
  answers.set(`${CONSENSUS!}/eth/v1/beacon/light_client/bootstrap/${root}`, { data: { header: { beacon: { slot: String(slot) } } } })
}

const OWN = 'https://beacon.example.com'
const LOCAL_OWN = 'http://127.0.0.1:5052'

interface Harness { renewal: CheckpointRenewal, saved: Array<{ root: string, replacing: ReadonlySet<string> }>, restarts: () => number, host: { running: boolean }, stored: { value: StoredCheckpoint | undefined } }

function harness (saveThrows = false, onSave: () => void = () => {}, consensus?: () => { url: string, local: boolean }): Harness {
  const saved: Harness['saved'] = []
  const stored: Harness['stored'] = { value: undefined }
  const host = { running: true }
  const restart = vi.fn()
  const store = {
    checkpoint: () => stored.value,
    saveFetchedCheckpoint: (checkpoint: { root: string, timestamp: number }, servers: readonly string[], _now: number, unserved: ReadonlySet<string>) => {
      if (saveThrows) throw new Error('read-only profile')
      saved.push({ root: checkpoint.root, replacing: new Set(unserved) })
      stored.value = { ...checkpoint, fetchedFrom: servers }
      onSave()
    }
  }
  const renewal = new CheckpointRenewal({ store: () => store as never, switchedOff: () => false, changed: () => {}, hostRunning: () => host.running, restartHost: restart, ...(consensus !== undefined && { consensus }) })
  return { renewal, saved, restarts: () => restart.mock.calls.length, host, stored }
}

/** Lets the chain of awaited requests of one attempt run through. */
async function settle (): Promise<void> {
  for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
}

describe('CheckpointRenewal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    answers.clear()
    asked.length = 0
    askedLocal.length = 0
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('chooses the release\'s checkpoint while it is fresh, and starts nothing', () => {
    const { renewal } = harness()
    expect(renewal.chooseForStart()).toMatchObject({ ok: true, source: 'release' })
    expect(renewal.start()).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('gives up the root it started with when the bootstrap is missing, fetches another, and restarts the host with it', async () => {
    const { renewal, saved, restarts } = harness()
    renewal.chooseForStart()
    serve(FRESH)
    renewal.recoverUnserved()
    await settle()
    expect(saved).toEqual([{ root: FRESH, replacing: new Set([SHIPPED_ROOT]) }])
    expect(renewal.choose()).toMatchObject({ ok: true, checkpoint: { root: FRESH }, source: 'fetched' })
    expect(restarts()).toBe(1)
  })

  it('does nothing for a root it already gave up, or when nothing was started with one', async () => {
    const { renewal, restarts } = harness()
    renewal.recoverUnserved()
    await settle()
    renewal.chooseForStart()
    serve(FRESH)
    renewal.recoverUnserved()
    renewal.recoverUnserved()
    await settle()
    expect(asked.filter((url) => url.endsWith('/headers/finalized'))).toHaveLength(2)
    expect(restarts()).toBe(1)
  })

  it('restarts a host that is asleep by not restarting it: its next start builds the new configuration', async () => {
    const { renewal, host, restarts } = harness()
    renewal.chooseForStart()
    serve(FRESH)
    host.running = false
    renewal.recoverUnserved()
    await settle()
    expect(renewal.choose()).toMatchObject({ ok: true, checkpoint: { root: FRESH } })
    expect(restarts()).toBe(0)
  })

  it('does not restart a host that was started with the new root in the meantime', async () => {
    let started: (() => void) | undefined
    const { renewal, restarts } = harness(false, () => { started?.() })
    started = () => { renewal.chooseForStart() }
    renewal.chooseForStart()
    serve(FRESH)
    renewal.recoverUnserved()
    await settle()
    expect(renewal.chooseForStart()).toMatchObject({ ok: true, checkpoint: { root: FRESH } })
    expect(restarts()).toBe(0)
  })

  it('counts an attempt that only finds roots already given up as a failure, and waits before asking again', async () => {
    const { renewal, restarts } = harness()
    renewal.chooseForStart()
    serve(SHIPPED_ROOT)
    renewal.recoverUnserved()
    await settle()
    expect(renewal.problem()).toBe('no-bootstrap')
    expect(restarts()).toBe(0)
    const askedOnce = asked.length
    expect(renewal.due()).toBe(false)
    expect(renewal.start()).toBeDefined()
    await settle()
    expect(asked).toHaveLength(askedOnce)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(renewal.due()).toBe(true)
  })

  it('counts an attempt that leaves no checkpoint at hand as a failure too', async () => {
    const { renewal, restarts } = harness(true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renewal.chooseForStart()
    serve(FRESH)
    renewal.recoverUnserved()
    await settle()
    expect(renewal.problem()).toBe('no-bootstrap')
    expect(renewal.due()).toBe(false)
    expect(restarts()).toBe(0)
  })

  it('walks past a root it gave up to an earlier epoch\'s, when the servers still name the given-up one first', async () => {
    const { renewal, saved } = harness()
    renewal.chooseForStart()
    serve(SHIPPED_ROOT)
    serve(FRESH, EPOCH_FIRST - 32, EPOCH_FIRST + 31)
    answers.set(`${CONSENSUS!}/eth/v1/beacon/blocks/${String(EPOCH_FIRST)}/root`, { data: { root: SHIPPED_ROOT } })
    renewal.recoverUnserved()
    await settle()
    expect(saved.map((s) => s.root)).toEqual([FRESH])
    expect(asked.some((url) => url.includes(`/bootstrap/${SHIPPED_ROOT}`))).toBe(false)
  })

  describe('with a beacon server of the person\'s', () => {
    function serveOwn (root: string): void {
      serve(root)
      answers.set(`${OWN}/eth/v1/beacon/light_client/bootstrap/${root}`, { data: { header: { beacon: { slot: String(EPOCH_FIRST) } } } })
    }

    it('asks it, and not Orivon\'s, whether it serves the bootstrap of a fresh checkpoint', async () => {
      const { renewal, saved } = harness(false, () => {}, () => ({ url: OWN, local: false }))
      expect(renewal.consensusRpc()).toBe(OWN)
      renewal.chooseForStart()
      serveOwn(FRESH)
      renewal.recoverUnserved()
      await settle()
      expect(saved.map((s) => s.root)).toEqual([FRESH])
      expect(asked.some((url) => url === `${OWN}/eth/v1/beacon/light_client/bootstrap/${FRESH}`)).toBe(true)
      expect(asked.some((url) => url.startsWith(`${CONSENSUS!}/eth/v1/beacon/light_client`))).toBe(false)
    })

    it('still asks Orivon\'s two servers for the finalized header and the block roots, which the person\'s server does not decide', async () => {
      const { renewal } = harness(false, () => {}, () => ({ url: OWN, local: false }))
      renewal.chooseForStart()
      serveOwn(FRESH)
      renewal.recoverUnserved()
      await settle()
      expect(asked).toContain(`${CONSENSUS!}/eth/v1/beacon/headers/finalized`)
      expect(asked).toContain(`${OTHER!}/eth/v1/beacon/headers/finalized`)
    })

    it('marks a request to a server on this computer as local, and no other', async () => {
      const { renewal } = harness(false, () => {}, () => ({ url: LOCAL_OWN, local: true }))
      renewal.chooseForStart()
      serve(FRESH)
      answers.set(`${LOCAL_OWN}/eth/v1/beacon/light_client/bootstrap/${FRESH}`, { data: { header: { beacon: { slot: String(EPOCH_FIRST) } } } })
      renewal.recoverUnserved()
      await settle()
      const toLocal = asked.map((url, index) => [url, askedLocal[index]] as const).filter(([url]) => url.startsWith(LOCAL_OWN))
      expect(toLocal.length).toBeGreaterThan(0)
      expect(toLocal.every(([, local]) => local === LOCAL_OWN)).toBe(true)
      expect(askedLocal.filter((local) => local !== undefined)).toHaveLength(toLocal.length)
    })

    it('forgets the roots the old beacon server had no bootstrap for, because the new one may have them', async () => {
      let server = { url: OWN, local: false }
      const { renewal } = harness(false, () => {}, () => server)
      renewal.chooseForStart()
      renewal.recoverUnserved()
      await settle()
      expect(renewal.choose()).toMatchObject({ ok: false, problem: 'not-served' })
      server = { url: 'https://other-beacon.example.com', local: false }
      expect(renewal.choose()).toMatchObject({ ok: true, source: 'release' })
    })

    it('keeps them while the server is the same', async () => {
      const { renewal } = harness(false, () => {}, () => ({ url: OWN, local: false }))
      renewal.chooseForStart()
      renewal.recoverUnserved()
      await settle()
      expect(renewal.choose()).toMatchObject({ ok: false, problem: 'not-served' })
      expect(renewal.choose()).toMatchObject({ ok: false, problem: 'not-served' })
    })
  })
})
