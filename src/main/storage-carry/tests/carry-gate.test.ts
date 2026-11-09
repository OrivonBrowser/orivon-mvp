import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CarryGate } from '../carry-gate.js'
import type { CarryDue, CarryEnd } from '../carry-gate.js'

const A = 'https://a.eth'
const B = 'https://b.eth'
const DEADLINE = 600_000

interface Run { origin: string, signal: AbortSignal, finish: (end: CarryEnd) => void }

function setup (due: (origin: string) => CarryDue = () => 'yes') {
  const runs: Run[] = []
  const released: string[] = []
  const deadlines: string[] = []
  const gate = new CarryGate({
    due,
    carry: async (origin, signal) => await new Promise<CarryEnd>((resolve) => { runs.push({ origin, signal, finish: resolve }) }),
    released: (origin) => { released.push(origin) },
    deadlineMs: DEADLINE,
    onDeadline: (origin) => { deadlines.push(origin) }
  })
  return { gate, runs, released, deadlines }
}

const settled = async (promise: Promise<unknown>): Promise<boolean> => await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { setImmediate(() => { resolve(false) }) })])

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers() })

describe('the page of a moved app', () => {
  it('waits for the whole carry, however long it takes, and not for a bound shorter than the deadline', async () => {
    const { gate, runs } = setup()
    const page = gate.ready(A)
    await vi.advanceTimersByTimeAsync(DEADLINE - 1000)
    expect(await settled(page)).toBe(false)
    runs[0]?.finish('carried')
    await page
  })

  it('starts one carry for any number of pages, and one deadline for the origin', async () => {
    const { gate, runs } = setup()
    const pages = [gate.ready(A), gate.ready(A), gate.ready(A)]
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    runs[0]?.finish('carried')
    await Promise.all(pages)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is let through at once when no carry is due, and asks again when the answer was "later"', async () => {
    let due: CarryDue = 'later'
    const { gate, runs } = setup(() => due)
    await gate.ready(A)
    expect(runs).toHaveLength(0)
    due = 'yes'
    const page = gate.ready(A)
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toHaveLength(1)
    runs[0]?.finish('carried')
    await page
    due = 'no'
    await gate.ready(B)
    expect(runs).toHaveLength(1)
  })

  it('aborts the carry once at the deadline, and is let through when the carry has cleared itself and failed', async () => {
    const { gate, runs, released, deadlines } = setup()
    const pages = [gate.ready(A), gate.ready(A)]
    await vi.advanceTimersByTimeAsync(DEADLINE)
    expect(deadlines).toEqual([A])
    expect(runs[0]?.signal.aborted).toBe(true)
    expect(await settled(Promise.all(pages))).toBe(false)
    runs[0]?.finish('failed')
    await Promise.all(pages)
    expect(released).toEqual([A])
  })
})

describe('what a failed carry makes final', () => {
  it('reports the release once, however many pages waited or come later', async () => {
    const { gate, runs, released } = setup()
    const page = gate.ready(A)
    await vi.advanceTimersByTimeAsync(0)
    runs[0]?.finish('failed')
    await page
    await gate.ready(A)
    expect(released).toEqual([A])
  })

  it('reports no release while nobody has opened the app: a failure in the background stays a failure that may be tried again', async () => {
    const { gate, runs, released } = setup()
    gate.enqueue([A])
    await vi.advanceTimersByTimeAsync(0)
    runs[0]?.finish('failed')
    await gate.idle()
    expect(released).toEqual([])
    await gate.ready(A)
    expect(released).toEqual([A])
  })

  it('reports nothing for a carry that ran to the end', async () => {
    const { gate, runs, released } = setup()
    const page = gate.ready(A)
    await vi.advanceTimersByTimeAsync(0)
    runs[0]?.finish('carried')
    await page
    await gate.ready(A)
    expect(released).toEqual([])
  })

  it('counts a carry that throws as failed', async () => {
    const released: string[] = []
    const gate = new CarryGate({ due: () => 'yes', carry: async () => { throw new Error('boom') }, released: (origin) => { released.push(origin) }, deadlineMs: DEADLINE, onDeadline: () => undefined })
    await gate.ready(A)
    expect(released).toEqual([A])
  })
})

describe('the carries of apps nobody has opened', () => {
  it('run one at a time, in order, and skip an origin that needs none', async () => {
    const { gate, runs } = setup((origin) => origin === 'https://skip.eth' ? 'no' : 'yes')
    gate.enqueue([A, 'https://skip.eth', B])
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.map((run) => run.origin)).toEqual([A])
    runs[0]?.finish('carried')
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.map((run) => run.origin)).toEqual([A, B])
    runs[1]?.finish('carried')
    await gate.idle()
  })

  it('go to the front when the app is opened: its page starts its carry now and the queue does not run it twice', async () => {
    const { gate, runs } = setup()
    gate.enqueue([A, B])
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.map((run) => run.origin)).toEqual([A])
    const page = gate.ready(B)
    await vi.advanceTimersByTimeAsync(0)
    expect(runs.map((run) => run.origin)).toEqual([A, B])
    runs[1]?.finish('carried')
    await page
    runs[0]?.finish('carried')
    await gate.idle()
    expect(runs).toHaveLength(2)
  })

  it('are not queued again for an origin that has run', async () => {
    const { gate, runs } = setup()
    gate.enqueue([A])
    await vi.advanceTimersByTimeAsync(0)
    runs[0]?.finish('carried')
    await gate.idle()
    gate.enqueue([A])
    await gate.idle()
    expect(runs).toHaveLength(1)
  })
})
