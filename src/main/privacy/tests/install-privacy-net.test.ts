import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'

const owner = { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() }
vi.mock('electron', () => ({ session: { defaultSession: { name: 'default' } } }))
vi.mock('../../sessions/web-request-owner.js', () => ({ webRequestOwnerFor: vi.fn(() => owner) }))

const { installPrivacyNet } = await import('../install-privacy-net.js')
const { webRequestOwnerFor } = await import('../../sessions/web-request-owner.js')
const { siteAsks } = await import('../../sessions/site-asks.js')

function rig (values: Record<string, string | boolean>, tab?: object) {
  const current = { 'privacy.cookies': 'all', 'privacy.secureDns': 'off', ...values } as Record<string, string | boolean>
  let listener: ((change: { key: string }) => void) | undefined
  const configureHostResolver = vi.fn()
  const app = { configureHostResolver } as unknown as App
  const subscribe = vi.fn()
  const services = {
    settings: { get: (key: string) => current[key], onChange: (l: (change: { key: string }) => void) => { listener = l; return () => {} } },
    windows: { findTab: (contents: unknown) => contents === tab && tab !== undefined ? { window: {}, tabId: 't1' } : null },
    tabLifecycle: { subscribe }
  } as unknown as ShellServices
  installPrivacyNet.install(app, services, {} as never, {} as never)
  return { configureHostResolver, subscribe, current, change: (key: string) => { listener?.({ key }) } }
}

describe('the privacy-net installer', () => {
  it('registers all three handlers on the default session\'s one owner, in order', () => {
    rig({})
    expect(webRequestOwnerFor).toHaveBeenCalledWith({ name: 'default' })
    expect(owner.onBeforeRequest).toHaveBeenCalledWith(10, { urls: ['http://*/*'], types: ['mainFrame'] }, expect.any(Function), expect.any(Function))
    expect(owner.onBeforeSendHeaders).toHaveBeenCalledWith(20, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, expect.any(Function), expect.any(Function))
    expect(owner.onHeadersReceived).toHaveBeenCalledWith(20, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, expect.any(Function), expect.any(Function))
  })

  it('matches only the addresses each handler filters on', () => {
    rig({})
    const beforeRequestMatches = owner.onBeforeRequest.mock.calls.at(-1)?.[2] as (url: string) => boolean
    const headersMatches = owner.onBeforeSendHeaders.mock.calls.at(-1)?.[2] as (url: string) => boolean
    expect(beforeRequestMatches('http://a.example/')).toBe(true)
    expect(beforeRequestMatches('https://a.example/')).toBe(false)
    expect(headersMatches('https://a.example/')).toBe(true)
    expect(headersMatches('wss://a.example/')).toBe(true)
    expect(headersMatches('ftp://a.example/')).toBe(false)
    expect(headersMatches('orivon://settings/')).toBe(false)
  })

  it('follows tabs as they are created and their views replaced', () => {
    const { subscribe } = rig({})
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ tabCreated: expect.any(Function), viewReplaced: expect.any(Function) }))
  })

  it('answers the storage-access permissions of a tab through the site askers, from the cookie choice', async () => {
    const tab = {}
    const contents = tab as never
    const all = rig({ 'privacy.cookies': 'all' }, tab)
    expect(siteAsks.check(null, 'storage-access', 'https://x', {})).toBeUndefined()
    expect(siteAsks.check(contents, 'storage-access', 'https://x', {})).toBe(true)
    expect(await siteAsks.request(contents, 'top-level-storage-access', {})).toBe(true)
    all.current['privacy.cookies'] = 'blockThirdParty'
    expect(siteAsks.check(contents, 'storage-access', 'https://x', {})).toBe(false)
    expect(await siteAsks.request(contents, 'storage-access', {})).toBe(false)
    expect(siteAsks.check(contents, 'geolocation', 'https://x', {})).toBeUndefined()
  })

  it('applies a secure DNS choice at launch and when it changes, and ignores other settings', () => {
    const { configureHostResolver, current, change } = rig({ 'privacy.secureDns': 'quad9' })
    expect(configureHostResolver).toHaveBeenCalledTimes(1)
    expect(configureHostResolver.mock.calls[0]?.[0]).toMatchObject({ secureDnsMode: 'secure', secureDnsServers: ['https://dns.quad9.net/dns-query'] })
    change('privacy.cookies')
    expect(configureHostResolver).toHaveBeenCalledTimes(1)
    current['privacy.secureDns'] = 'off'
    change('privacy.secureDns')
    expect(configureHostResolver).toHaveBeenCalledTimes(2)
    expect(configureHostResolver.mock.calls[1]?.[0]).toMatchObject({ secureDnsMode: 'off' })
  })
})
