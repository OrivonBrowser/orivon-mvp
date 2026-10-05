import { describe, expect, it, vi } from 'vitest'
import { createDisplayGate, type DisplayGateDeps, type PickRequest } from '../display-gate.js'
import type { DisplayChoice } from '../types.js'

const ORIGIN = 'https://share.example'
const CHOICE: DisplayChoice = { kind: 'screen', source: { id: 'screen:0:0', name: 'Entire screen' }, systemAudio: false, label: 'Entire screen' }
const REQUEST: PickRequest = { audio: false, hints: {}, activation: true }

function tab (): never {
  return { id: 1, isDestroyed: () => false } as never
}

/** Lets the promise chains the gate started reach the picker. */
async function settled (): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/** Tickets as the real module keeps them: open until used, voided, rejected or timed out, and `has` says so. */
function fakeTickets (): DisplayGateDeps['tickets'] & { end: () => void } {
  const open = new Set<string>()
  const key = '1:10:2'
  return {
    open: vi.fn(() => { open.add(key); return 'nonce-1' }),
    void: vi.fn(() => { open.delete(key) }),
    arm: vi.fn(),
    called: vi.fn((_key: string, _nonce: string, rejectedEarly: boolean) => { if (rejectedEarly) open.delete(key) }),
    has: (k: string) => open.has(k),
    end: () => { open.clear() }
  }
}

function setup (overrides: Partial<DisplayGateDeps> = {}): { gate: ReturnType<typeof createDisplayGate>, deps: DisplayGateDeps, contents: never } {
  const deps: DisplayGateDeps = {
    tickets: fakeTickets(),
    policy: { isApp: () => false, mayAsk: () => true, decide: vi.fn(async () => await Promise.resolve(true)) },
    choose: vi.fn(async () => await Promise.resolve(CHOICE)),
    shares: { tracksEnded: vi.fn() },
    isTab: () => true,
    showing: () => true,
    mainFrameOrigin: () => ORIGIN,
    frameKey: () => '1:10:2',
    ...overrides
  }
  return { gate: createDisplayGate(deps), deps, contents: tab() }
}

describe('the display gate: picking', () => {
  it('opens a ticket for the picked choice and answers go with its nonce', async () => {
    const { gate, deps, contents } = setup()
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'go', nonce: 'nonce-1' })
    expect(deps.tickets.open).toHaveBeenCalledWith('1:10:2', CHOICE)
    expect(deps.choose).toHaveBeenCalledWith({ tab: contents, origin: ORIGIN, isApp: false, audio: false, hints: {} }, expect.any(AbortSignal))
  })

  it('passes the page\'s audio ask and hints to the picker, and tells it when the page is an app', async () => {
    const { gate, deps, contents } = setup({ policy: { isApp: () => true, mayAsk: () => true, decide: async () => await Promise.resolve(true) } })
    await gate.pick(contents, { audio: true, hints: { displaySurface: 'window' }, activation: true })
    expect(deps.choose).toHaveBeenCalledWith({ tab: contents, origin: ORIGIN, isApp: true, audio: true, hints: { displaySurface: 'window' } }, expect.any(AbortSignal))
  })

  it.each([
    ['is not a tab', { isTab: () => false }],
    ['is not showing', { showing: () => false }],
    ['has no committed origin', { mainFrameOrigin: () => null }]
  ])('refuses without a picker when the page %s', async (_name, overrides) => {
    const { gate, deps, contents } = setup(overrides)
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'refused', reason: 'denied' })
    expect(deps.choose).not.toHaveBeenCalled()
  })

  it('refuses without a picker when the policy says no', async () => {
    const { gate, deps, contents } = setup({ policy: { isApp: () => false, mayAsk: () => false, decide: async () => await Promise.resolve(false) } })
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'refused', reason: 'denied' })
    expect(deps.choose).not.toHaveBeenCalled()
    expect(deps.tickets.open).not.toHaveBeenCalled()
  })

  it('refuses a cancelled pick and opens no ticket', async () => {
    const { gate, deps, contents } = setup({ choose: async () => await Promise.resolve(null) })
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'refused', reason: 'denied' })
    expect(deps.tickets.open).not.toHaveBeenCalled()
  })

  it('refuses when the picker fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { gate, contents } = setup({ choose: async () => await Promise.reject(new Error('boom')) })
      expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'refused', reason: 'denied' })
    } finally {
      error.mockRestore()
    }
  })

  it('refuses a second pick while the first picker is open, once per tab', async () => {
    let release: (choice: DisplayChoice | null) => void = () => {}
    const { gate, deps, contents } = setup({ choose: vi.fn(async () => await new Promise<DisplayChoice | null>((resolve) => { release = resolve })) })
    const first = gate.pick(contents, REQUEST)
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'refused', reason: 'busy' })
    await settled()
    release(CHOICE)
    expect(await first).toEqual({ type: 'go', nonce: 'nonce-1' })
    expect(deps.choose).toHaveBeenCalledOnce()
  })

  it('refuses a pick while the last ticket is open, so it never voids a call in flight, until the tickets end it', async () => {
    const { gate, contents, deps } = setup()
    await gate.pick(contents, REQUEST)
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'refused', reason: 'busy' })
    ;(deps.tickets as ReturnType<typeof fakeTickets>).end()
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'go', nonce: 'nonce-1' })
    expect(deps.tickets.open).toHaveBeenCalledTimes(2)
  })

  it('lets a pick through once the preload reports its call was rejected', async () => {
    const { gate, contents } = setup()
    expect((await gate.pick(contents, REQUEST)).type).toBe('go')
    gate.called(contents, 'nonce-1', true)
    expect((await gate.pick(contents, REQUEST)).type).toBe('go')
  })

  it('needs fresh activation to ask again after a cancel, and not before', async () => {
    let answer: DisplayChoice | null = null
    const { gate, deps, contents } = setup({ choose: vi.fn(async () => await Promise.resolve(answer)) })
    await gate.pick(contents, REQUEST)
    expect(await gate.pick(contents, { ...REQUEST, activation: false })).toEqual({ type: 'refused', reason: 'activation' })
    expect(deps.choose).toHaveBeenCalledOnce()
    answer = CHOICE
    expect((await gate.pick(contents, REQUEST)).type).toBe('go')
  })

  it('does not need activation for the first pick', async () => {
    const { gate, contents } = setup()
    expect((await gate.pick(contents, { ...REQUEST, activation: false })).type).toBe('go')
  })

  it('drops a choice made after the page was left, and one made after the picker was closed', async () => {
    let origin = ORIGIN
    const { gate, deps, contents } = setup({ mainFrameOrigin: () => origin, choose: async () => { origin = 'https://other.example'; return await Promise.resolve(CHOICE) } })
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'refused', reason: 'denied' })
    expect(deps.tickets.open).not.toHaveBeenCalled()

    const closing = setup({ choose: async (_request, signal) => await new Promise<DisplayChoice | null>((resolve) => { signal.addEventListener('abort', () => { resolve(CHOICE) }) }) })
    const pending = closing.gate.pick(closing.contents, REQUEST)
    await settled()
    closing.gate.endForTab(closing.contents)
    expect(await pending).toEqual({ type: 'refused', reason: 'denied' })
    expect(closing.deps.tickets.open).not.toHaveBeenCalled()
  })

  it('drops a choice made for a tab that was destroyed meanwhile', async () => {
    let gone = false
    const contents = { id: 1, isDestroyed: () => gone } as never
    const { gate, deps } = setup({ choose: async () => { gone = true; return await Promise.resolve(CHOICE) } })
    expect(await gate.pick(contents, REQUEST)).toEqual({ type: 'refused', reason: 'denied' })
    expect(deps.tickets.open).not.toHaveBeenCalled()
  })
})

describe('the display gate: a page that was refused', () => {
  const cancelled = { choose: vi.fn(async () => await Promise.resolve(null)) }

  it('still needs a fresh gesture after a navigation that never commits ends its state', async () => {
    const { gate, deps, contents } = setup(cancelled)
    await gate.pick(contents, REQUEST)
    gate.endForTab(contents)
    expect(await gate.pick(contents, { ...REQUEST, activation: false })).toEqual({ type: 'refused', reason: 'activation' })
    expect(deps.choose).toHaveBeenCalledOnce()
  })

  it('needs a gesture after the same origin loads again', async () => {
    const { gate, contents } = setup(cancelled)
    await gate.pick(contents, REQUEST)
    gate.endForTab(contents)
    gate.endForTab(contents)
    expect(await gate.pick(contents, { ...REQUEST, activation: false })).toEqual({ type: 'refused', reason: 'activation' })
  })

  it('a new site starts fresh: the refusal of one origin does not follow the tab to another', async () => {
    let origin = ORIGIN
    let answer: DisplayChoice | null = null
    const { gate, contents } = setup({ mainFrameOrigin: () => origin, choose: async () => await Promise.resolve(answer) })
    await gate.pick(contents, REQUEST)
    gate.endForTab(contents)
    origin = 'https://other.example'
    answer = CHOICE
    expect((await gate.pick(contents, { ...REQUEST, activation: false })).type).toBe('go')
  })

  it('needs a gesture after a pick that was closed by the page leaving while the picker was open', async () => {
    const { gate, contents } = setup({ choose: async (_request, signal) => await new Promise<DisplayChoice | null>((resolve) => { signal.addEventListener('abort', () => { resolve(CHOICE) }) }) })
    const pending = gate.pick(contents, REQUEST)
    await settled()
    gate.endForTab(contents)
    expect(await pending).toEqual({ type: 'refused', reason: 'denied' })
    expect(await gate.pick(contents, { ...REQUEST, activation: false })).toEqual({ type: 'refused', reason: 'activation' })
  })
})

describe('the display gate: the preload\'s messages and the page going away', () => {
  it('passes arm and called to the ticket under the tab\'s frame key', () => {
    const { gate, deps, contents } = setup()
    gate.arm(contents, 'n')
    gate.called(contents, 'n', true)
    expect(deps.tickets.arm).toHaveBeenCalledWith('1:10:2', 'n')
    expect(deps.tickets.called).toHaveBeenCalledWith('1:10:2', 'n', true)
  })

  it('passes tracks-ended to the registry', () => {
    const { gate, deps, contents } = setup()
    gate.tracksEnded(contents, 'n')
    expect(deps.shares.tracksEnded).toHaveBeenCalledWith(contents, 'n')
  })

  it('voids the ticket and closes an open picker when the page goes away', async () => {
    let signal: AbortSignal | undefined
    const { gate, deps, contents } = setup({ choose: async (_request, s) => await new Promise<DisplayChoice | null>((resolve) => { signal = s; s.addEventListener('abort', () => { resolve(null) }) }) })
    const pending = gate.pick(contents, REQUEST)
    await settled()
    gate.endForTab(contents)
    expect(deps.tickets.void).toHaveBeenCalledWith('1:10:2')
    expect(signal?.aborted).toBe(true)
    expect(await pending).toEqual({ type: 'refused', reason: 'denied' })
  })
})
