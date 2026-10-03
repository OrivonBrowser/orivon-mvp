import type { App } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'

const owner = { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() }
/** How many handlers each event holds right now: a registration counts until its handle is removed. */
const active = { onBeforeRequest: 0, onBeforeSendHeaders: 0, onHeadersReceived: 0 }
beforeEach(() => {
  for (const event of Object.keys(active) as Array<keyof typeof active>) {
    active[event] = 0
    owner[event].mockReset()
    owner[event].mockImplementation(() => {
      active[event] += 1
      let removed = false
      return { remove: () => { if (!removed) { removed = true; active[event] -= 1 } } }
    })
  }
})
vi.mock('electron', () => ({ session: { defaultSession: { name: 'default' } } }))
vi.mock('../../sessions/web-request-owner.js', () => ({ webRequestOwnerFor: vi.fn(() => owner) }))

const { installPrivacyNet } = await import('../install-privacy-net.js')
const { webRequestOwnerFor } = await import('../../sessions/web-request-owner.js')
const { siteAsks } = await import('../../sessions/site-asks.js')

function rig (values: Record<string, string | boolean>, tab?: object) {
  const current = { 'privacy.cookies': 'all', 'privacy.secureDns': 'off', 'privacy.globalPrivacyControl': false, 'privacy.doNotTrack': false, 'privacy.httpsOnly': false, ...values } as Record<string, string | boolean>
  const listeners: Array<(change: { key: string }) => void> = []
  const configureHostResolver = vi.fn()
  const app = { configureHostResolver } as unknown as App
  const subscribe = vi.fn()
  const services = {
    settings: { get: (key: string) => current[key], onChange: (l: (change: { key: string }) => void) => { listeners.push(l); return () => {} } },
    windows: { findTab: (contents: unknown) => contents === tab && tab !== undefined ? { window: {}, tabId: 't1' } : null },
    tabLifecycle: { subscribe }
  } as unknown as ShellServices
  installPrivacyNet.install(app, services, {} as never, {} as never)
  return { configureHostResolver, subscribe, current, change: (key: string) => { for (const listener of listeners) listener({ key }) } }
}

describe('the privacy-net installer', () => {
  it('registers no handler while every control is at its default', () => {
    rig({})
    expect(webRequestOwnerFor).toHaveBeenCalledWith({ name: 'default' })
    expect(owner.onBeforeRequest).not.toHaveBeenCalled()
    expect(owner.onBeforeSendHeaders).not.toHaveBeenCalled()
    expect(owner.onHeadersReceived).not.toHaveBeenCalled()
  })

  it('registers each handler, in order, for the setting that needs it, and takes it out when the setting goes off', () => {
    const { current, change } = rig({})

    current['privacy.httpsOnly'] = true
    change('privacy.httpsOnly')
    expect(owner.onBeforeRequest).toHaveBeenCalledWith(10, { urls: ['http://*/*'], types: ['mainFrame'] }, expect.any(Function), expect.any(Function))
    expect(active).toEqual({ onBeforeRequest: 1, onBeforeSendHeaders: 0, onHeadersReceived: 0 })
    change('privacy.httpsOnly')
    expect(active.onBeforeRequest).toBe(1)
    current['privacy.httpsOnly'] = false
    change('privacy.httpsOnly')
    expect(active).toEqual({ onBeforeRequest: 0, onBeforeSendHeaders: 0, onHeadersReceived: 0 })

    for (const key of ['privacy.globalPrivacyControl', 'privacy.doNotTrack']) {
      current[key] = true
      change(key)
      expect(owner.onBeforeSendHeaders).toHaveBeenLastCalledWith(20, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, expect.any(Function), expect.any(Function))
      expect(active).toEqual({ onBeforeRequest: 0, onBeforeSendHeaders: 1, onHeadersReceived: 0 })
      current[key] = false
      change(key)
      expect(active.onBeforeSendHeaders).toBe(0)
    }

    current['privacy.cookies'] = 'blockThirdParty'
    change('privacy.cookies')
    expect(owner.onHeadersReceived).toHaveBeenLastCalledWith(20, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, expect.any(Function), expect.any(Function))
    expect(active).toEqual({ onBeforeRequest: 0, onBeforeSendHeaders: 1, onHeadersReceived: 1 })
    current['privacy.cookies'] = 'all'
    change('privacy.cookies')
    expect(active).toEqual({ onBeforeRequest: 0, onBeforeSendHeaders: 0, onHeadersReceived: 0 })
  })

  it('keeps the header handler while a signal or the cookie block still needs it', () => {
    const { current, change } = rig({ 'privacy.globalPrivacyControl': true, 'privacy.cookies': 'blockThirdParty' })
    expect(active).toEqual({ onBeforeRequest: 0, onBeforeSendHeaders: 1, onHeadersReceived: 1 })
    current['privacy.globalPrivacyControl'] = false
    change('privacy.globalPrivacyControl')
    expect(active.onBeforeSendHeaders).toBe(1)
    current['privacy.cookies'] = 'all'
    change('privacy.cookies')
    expect(active).toEqual({ onBeforeRequest: 0, onBeforeSendHeaders: 0, onHeadersReceived: 0 })
  })

  it('registers at launch for the controls the person already turned on', () => {
    rig({ 'privacy.httpsOnly': true, 'privacy.doNotTrack': true })
    expect(active).toEqual({ onBeforeRequest: 1, onBeforeSendHeaders: 1, onHeadersReceived: 0 })
  })

  it('matches only the addresses each handler filters on', () => {
    rig({ 'privacy.httpsOnly': true, 'privacy.doNotTrack': true })
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
