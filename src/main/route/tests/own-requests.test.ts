import { afterEach, describe, expect, it, vi } from 'vitest'
import { ownDirectSession, ownFetch, ownRequestsSettled, ownRequestsTunnelled, ownRouteFor, setOwnRequests } from '../own-requests.js'

const ordinary = vi.fn(async () => new Response('ordinary'))
const tunnel = vi.fn(async () => new Response('tunnel'))
const direct = vi.fn(async () => new Response('direct'))
const SESSION = { name: 'system' }

function world (everywhere: boolean, off: readonly string[] = []): void {
  setOwnRequests({ everywhere: () => everywhere, isRouted: (origin) => !off.includes(origin), tunnel, direct, directSession: () => SESSION })
}
afterEach(() => { setOwnRequests(undefined); vi.clearAllMocks() })

describe('how Orivon\'s own requests leave', () => {
  it('as they always did while the whole browser is not on the tunnel, and before routes are running', async () => {
    expect(await (await ownFetch(ordinary)('https://api.example/x')).text()).toBe('ordinary')
    world(false)
    expect(await (await ownFetch(ordinary)('https://api.example/x')).text()).toBe('ordinary')
    expect(ownRequestsTunnelled()).toBe(false)
    expect(ownRouteFor('https://app.example')).toBe('ordinary')
    expect(ownDirectSession()).toBeUndefined()
    expect(tunnel).not.toHaveBeenCalled()
  })

  it('through the tunnel while it is on, with the request and its init passed on', async () => {
    world(true)
    const init = { method: 'POST', body: 'x' }
    expect(await (await ownFetch(ordinary)('https://stats.example/v1', init)).text()).toBe('tunnel')
    expect(tunnel).toHaveBeenCalledWith('https://stats.example/v1', init)
    expect(ordinary).not.toHaveBeenCalled()
    expect(ownRequestsTunnelled()).toBe(true)
  })

  it('on the system\'s proxy for an origin set to off, and through the tunnel for any other', async () => {
    world(true, ['https://off.example'])
    expect(await (await ownFetch(ordinary, 'https://off.example')('https://off.example/manifest')).text()).toBe('direct')
    expect(await (await ownFetch(ordinary, 'https://on.example')('https://on.example/manifest')).text()).toBe('tunnel')
    expect(ownRouteFor('https://off.example')).toBe('direct')
    expect(ownRouteFor('https://on.example')).toBe('tunnel')
    expect(ownRouteFor()).toBe('tunnel')
    expect(ownDirectSession()).toBe(SESSION)
  })

  it('reads the setting again for every request, so a flip applies to the next one', async () => {
    let on = false
    setOwnRequests({ everywhere: () => on, isRouted: () => true, tunnel, direct, directSession: () => SESSION })
    const fetch = ownFetch(ordinary)
    expect(await (await fetch('https://a.example')).text()).toBe('ordinary')
    on = true
    expect(await (await fetch('https://a.example')).text()).toBe('tunnel')
  })
})

describe('while the sessions are still following a change of the setting', () => {
  it('waits for them before deciding how to leave, and reads the setting after the wait', async () => {
    let on = false
    let done!: () => void
    const pending = new Promise<void>((resolve) => { done = resolve })
    setOwnRequests({ everywhere: () => on, isRouted: () => true, tunnel, direct, directSession: () => SESSION, settled: async () => { await pending } })
    const answer = ownFetch(ordinary)('https://a.example')
    on = true
    await Promise.resolve()
    expect(tunnel).not.toHaveBeenCalled()
    done()
    expect(await (await answer).text()).toBe('tunnel')
    expect(ordinary).not.toHaveBeenCalled()
  })

  it('refuses when they do not follow in time, in either direction, and sends nothing', async () => {
    setOwnRequests({ everywhere: () => true, isRouted: () => true, tunnel, direct, directSession: () => SESSION, settled: async () => { await new Promise<void>(() => {}) }, settleMs: 20 })
    await expect(ownFetch(ordinary)('https://a.example')).rejects.toThrow('still being applied')
    await expect(ownRequestsSettled()).rejects.toThrow('still being applied')
    setOwnRequests({ everywhere: () => false, isRouted: () => true, tunnel, direct, directSession: () => SESSION, settled: async () => { await new Promise<void>(() => {}) }, settleMs: 20 })
    await expect(ownFetch(ordinary)('https://a.example')).rejects.toThrow('still being applied')
    expect(ordinary).not.toHaveBeenCalled()
    expect(tunnel).not.toHaveBeenCalled()
  })
})
