import type { App } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../shell-services.js'

const owner = { onBeforeRequest: vi.fn() }
let active = 0
let lastRun: ((details: unknown, current: unknown) => unknown) | undefined
beforeEach(() => {
  active = 0
  lastRun = undefined
  owner.onBeforeRequest.mockReset()
  owner.onBeforeRequest.mockImplementation((_order: number, _filter: unknown, _matches: unknown, run: (details: unknown, current: unknown) => unknown) => {
    active += 1
    lastRun = run
    let removed = false
    return { remove: () => { if (!removed) { removed = true; active -= 1 } } }
  })
})
vi.mock('electron', () => ({ session: { defaultSession: { name: 'default' } } }))
vi.mock('../../sessions/web-request-owner.js', () => ({ webRequestOwnerFor: vi.fn(() => owner) }))

const { installEthGatewayRedirect } = await import('../eth-gateway-redirect.js')
const { webRequestOwnerFor } = await import('../../sessions/web-request-owner.js')
const { provideVerifierAccess } = await import('../../verifier/verifier-access.js')
const provideServing = (serving: boolean): void => { provideVerifierAccess({ start: () => {}, ready: async () => {}, ...(serving ? { servesName: () => true } : {}) }) }
afterEach(() => { provideServing(false) })

function rig (on: boolean) {
  const current: Record<string, boolean> = { 'web3.ethGatewayRedirect': on }
  const listeners: Array<(change: { key: string }) => void> = []
  const services = {
    settings: { get: (key: string) => current[key], onChange: (listener: (change: { key: string }) => void) => { listeners.push(listener); return () => {} } }
  } as unknown as ShellServices
  installEthGatewayRedirect.install({} as App, services, {} as never, {} as never)
  return { current, change: () => { for (const listener of listeners) listener({ key: 'web3.ethGatewayRedirect' }) } }
}

describe('the eth-gateway-redirect installer', () => {
  it('registers nothing while the setting is off, and a handler once it is on', () => {
    const { current, change } = rig(false)
    expect(webRequestOwnerFor).toHaveBeenCalledWith({ name: 'default' })
    expect(active).toBe(0)
    current['web3.ethGatewayRedirect'] = true
    change()
    expect(active).toBe(1)
    change()
    expect(active).toBe(1)
  })

  it('registers at order 5, for main frames of both gateway suffixes over http and https', () => {
    rig(true)
    expect(owner.onBeforeRequest).toHaveBeenCalledWith(
      5,
      { urls: ['http://*.eth.limo/*', 'https://*.eth.limo/*', 'http://*.eth.link/*', 'https://*.eth.link/*'], types: ['mainFrame'] },
      expect.any(Function),
      expect.any(Function)
    )
    const matches = owner.onBeforeRequest.mock.calls[0]?.[2] as (url: string) => boolean
    expect(matches('https://vitalik.eth.limo/')).toBe(true)
    expect(matches('http://vitalik.eth.link/')).toBe(true)
    expect(matches('wss://vitalik.eth.limo/')).toBe(false)
    expect(matches('https://vitalik.eth.limo.evil.example/')).toBe(false)
    expect(matches('https://evil-eth.limo/')).toBe(false)
    expect(matches('https://eth.limo/')).toBe(false)
    expect(matches('https://example.com/')).toBe(false)
    expect(matches('not a url')).toBe(false)
  })

  it('takes the handler out when the setting goes off', () => {
    const { current, change } = rig(true)
    expect(active).toBe(1)
    current['web3.ethGatewayRedirect'] = false
    change()
    expect(active).toBe(0)
  })

  it('redirects a main frame to the .eth name, and leaves every other resource alone', () => {
    provideServing(true)
    rig(true)
    const unchanged = { cancel: false }
    const details = (resourceType: string) => ({ url: 'https://site.eth.limo/a?b=1#c', resourceType })
    expect(lastRun?.(details('mainFrame'), unchanged)).toEqual({ redirectURL: 'https://site.eth/a?b=1#c' })
    for (const type of ['subFrame', 'script', 'xhr']) expect(lastRun?.(details(type), unchanged), type).toBe(unchanged)
  })

  it('leaves a main frame alone when the name cannot load', () => {
    rig(true)
    const unchanged = { cancel: false }
    expect(lastRun?.({ url: 'https://site.eth.limo/', resourceType: 'mainFrame' }, unchanged)).toBe(unchanged)
  })
})
