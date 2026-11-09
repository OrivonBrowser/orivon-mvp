import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CarryGate } from '../carry-gate.js'
import type { CarryDue } from '../carry-gate.js'

const ORIGIN = 'https://wiki.eth'
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function gateWith (due: () => CarryDue, carry: () => Promise<void>, onBound: () => void = () => {}): CarryGate {
  return new CarryGate({ due, carry, boundMs: 1000, onBound })
}

describe('the hold on an app\'s first page', () => {
  it('lets a page go at once when no carry is due, and does not ask again', async () => {
    const due = vi.fn<() => CarryDue>(() => 'no')
    const gate = gateWith(due, async () => { throw new Error('must not run') })
    await gate.ready(ORIGIN)
    await gate.ready(ORIGIN)
    expect(due).toHaveBeenCalledTimes(1)
  })

  it('asks again when the shell does not serve the origin as a website yet', async () => {
    const answers: CarryDue[] = ['later', 'later', 'no']
    const due = vi.fn<() => CarryDue>(() => answers.shift() ?? 'no')
    const gate = gateWith(due, async () => {})
    await gate.ready(ORIGIN)
    await gate.ready(ORIGIN)
    await gate.ready(ORIGIN)
    await gate.ready(ORIGIN)
    expect(due).toHaveBeenCalledTimes(3)
  })

  it('holds every page of the origin until the one carry ends, and runs it once', async () => {
    let end: () => void = () => {}
    const carry = vi.fn(async () => await new Promise<void>((resolve) => { end = resolve }))
    const gate = gateWith(() => 'yes', carry)
    const released: string[] = []
    const first = gate.ready(ORIGIN).then(() => released.push('first'))
    const second = gate.ready(ORIGIN).then(() => released.push('second'))
    await vi.advanceTimersByTimeAsync(500)
    expect(released).toEqual([])
    end()
    await Promise.all([first, second])
    expect(released.sort()).toEqual(['first', 'second'])
    await gate.ready(ORIGIN)
    expect(carry).toHaveBeenCalledTimes(1)
  })

  it('lets the page go at the bound while the carry goes on, and does not make a later page wait the bound again', async () => {
    let end: () => void = () => {}
    const bound = vi.fn()
    const gate = gateWith(() => 'yes', async () => await new Promise<void>((resolve) => { end = resolve }), bound)
    const page = gate.ready(ORIGIN)
    await vi.advanceTimersByTimeAsync(1000)
    await page
    expect(bound).toHaveBeenCalledWith(ORIGIN)
    await gate.ready(ORIGIN)
    expect(bound).toHaveBeenCalledTimes(1)
    end()
  })

  it('keeps a carry for each origin apart', async () => {
    const ran: string[] = []
    const gate = gateWith(() => 'yes', async () => { ran.push('run') })
    await Promise.all([gate.ready('https://a.eth'), gate.ready('https://b.eth')])
    expect(ran).toHaveLength(2)
  })
})
