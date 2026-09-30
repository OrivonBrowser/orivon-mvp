import { describe, expect, it, vi } from 'vitest'
import type { WebPreferences } from 'electron'
import { partitionFor } from '../../../broker/grants/origin-hash.js'
import { embedPartitionFor, guestRequestAllowed, hardenGuest } from '../embed-guard.js'

// ADR-0039: whatever a <webview> asked for, the guest it gets is sandboxed,
// isolated, in the app's own embed partition, running the shell's preload.
// A miss here is silent: the guest still shows the page, with more power
// than the person granted.

const APP = 'https://app.example'
const SETTINGS = { preloadPath: '/out/preload/embed.js', partition: embedPartitionFor(APP), devTools: false }

describe('embedPartitionFor', () => {
  it('is a persist: partition, keyed by the app origin, and never the app\'s own partition', () => {
    const partition = embedPartitionFor(APP)
    expect(partition.startsWith('persist:embed-')).toBe(true)
    expect(partition).not.toBe(partitionFor(APP))
    expect(embedPartitionFor('https://other.example')).not.toBe(partition)
  })
})

describe('hardenGuest', () => {
  it('replaces the preload and partition the app named, and locks every security-relevant preference', () => {
    const webPreferences: WebPreferences = {
      preload: '/tmp/the-apps-own.js',
      partition: 'persist:the-apps-choice',
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      webviewTag: true,
      plugins: true,
      devTools: true,
      enableBlinkFeatures: 'Anything',
      additionalArguments: ['--orivon-app-tab']
    }
    const params: Record<string, string> = {
      src: 'https://example.com/',
      preload: 'file:///tmp/the-apps-own.js',
      partition: 'persist:the-apps-choice',
      nodeintegration: 'true',
      disablewebsecurity: 'true',
      allowpopups: 'true',
      webpreferences: 'nodeIntegration=yes',
      enableblinkfeatures: 'Anything',
      plugins: 'true',
      useragent: 'kept'
    }

    hardenGuest(webPreferences, params, SETTINGS)

    expect(webPreferences).toEqual({
      preload: SETTINGS.preloadPath,
      partition: SETTINGS.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      plugins: false,
      devTools: false,
      disablePopups: false
    })
    expect(params).toEqual({
      src: 'https://example.com/',
      useragent: 'kept',
      partition: SETTINGS.partition,
      preload: SETTINGS.preloadPath
    })
  })

  it('leaves DevTools on only when asked (developer mode)', () => {
    const webPreferences: WebPreferences = {}
    hardenGuest(webPreferences, {}, { ...SETTINGS, devTools: true })
    expect(webPreferences.devTools).toBe(true)
  })
})

// A286: no cancellable webRequest event carries the address a document
// actually connects to, so a "*"-admitted NAME is resolved and checked
// here first, through an injected resolver standing in for the guest
// session's own Session.resolveHost (./embed-host.ts wires the real one).
describe('guestRequestAllowed', () => {
  const wildcard = ['*']
  const exactPrivate = ['https://intranet.internal']

  function resolverAnswering (addresses: readonly string[]): { resolve: (host: string) => Promise<readonly string[]>, calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      resolve: async (host) => { calls.push(host); return addresses }
    }
  }

  it('refuses everything, subresources included, with no live grant, never calling resolve', async () => {
    const { resolve, calls } = resolverAnswering(['93.184.216.34'])
    await expect(guestRequestAllowed('https://example.com/', 'mainFrame', undefined, resolve)).resolves.toBe(false)
    await expect(guestRequestAllowed('https://example.com/x.png', 'image', undefined, resolve)).resolves.toBe(false)
    expect(calls).toEqual([])
  })

  it('judges a top-frame and a subframe document against an exact grant, never calling resolve', async () => {
    const { resolve, calls } = resolverAnswering(['93.184.216.34'])
    const granted = ['https://example.com']
    await expect(guestRequestAllowed('https://example.com/page', 'mainFrame', granted, resolve)).resolves.toBe(true)
    await expect(guestRequestAllowed('https://other.example/page', 'mainFrame', granted, resolve)).resolves.toBe(false)
    await expect(guestRequestAllowed('https://other.example/frame', 'subFrame', granted, resolve)).resolves.toBe(false)
    await expect(guestRequestAllowed('https://cdn.other.example/lib.js', 'script', granted, resolve)).resolves.toBe(true)
    expect(calls).toEqual([])
  })

  it('lets a subresource through under a "*" grant without ever calling resolve', async () => {
    const { resolve, calls } = resolverAnswering(['192.168.1.1'])
    await expect(guestRequestAllowed('https://anything.example/lib.js', 'script', wildcard, resolve)).resolves.toBe(true)
    expect(calls).toEqual([])
  })

  it('allows an exact-origin match without calling resolve, even for a private/loopback origin named exactly (ADR-0039)', async () => {
    const { resolve, calls } = resolverAnswering(['10.0.0.1'])
    await expect(guestRequestAllowed('https://intranet.internal/page', 'mainFrame', exactPrivate, resolve)).resolves.toBe(true)
    expect(calls).toEqual([])
  })

  it('refuses a "*"-admitted name that resolves to a private address', async () => {
    const { resolve } = resolverAnswering(['192.168.1.1'])
    await expect(guestRequestAllowed('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('refuses a "*"-admitted name that resolves to a loopback address', async () => {
    const { resolve } = resolverAnswering(['127.0.0.1'])
    await expect(guestRequestAllowed('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('refuses a "*"-admitted name whose answer mixes a public and a private address', async () => {
    const { resolve } = resolverAnswering(['93.184.216.34', '192.168.1.1'])
    await expect(guestRequestAllowed('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('allows a "*"-admitted name whose every resolved address is public unicast', async () => {
    const { resolve, calls } = resolverAnswering(['93.184.216.34'])
    await expect(guestRequestAllowed('https://good.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(true)
    expect(calls).toEqual(['good.example'])
  })

  it('refuses a "*"-admitted name whose resolve rejects (fail closed)', async () => {
    const resolve = vi.fn(async (): Promise<readonly string[]> => { throw new Error('resolution failed') })
    await expect(guestRequestAllowed('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('refuses a "*"-admitted name that resolves to no address at all', async () => {
    const { resolve } = resolverAnswering([])
    await expect(guestRequestAllowed('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('allows a "*"-admitted PUBLIC address literal without calling resolve (already proven public by the pure gate)', async () => {
    const { resolve, calls } = resolverAnswering(['192.168.1.1'])
    await expect(guestRequestAllowed('http://93.184.216.34/', 'mainFrame', wildcard, resolve)).resolves.toBe(true)
    expect(calls).toEqual([])
  })

  it('refuses a loopback/localhost host under "*" with no lookup at all -- the pure hostname gate stays first', async () => {
    const { resolve, calls } = resolverAnswering(['93.184.216.34'])
    await expect(guestRequestAllowed('http://127.0.0.1:8080/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
    await expect(guestRequestAllowed('http://localhost:3000/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
    expect(calls).toEqual([])
  })
})

// ADR-0047: a local pattern reaches only a listener the embedding app itself
// holds. The guard asks `listenerHeld` for the pattern's port, resolves no
// name for it, and fails closed when it is not given the question at all.
describe('guestRequestAllowed -- the local pattern', () => {
  const local = ['http://*.localhost:8123']

  function neverResolves (): { resolve: (host: string) => Promise<readonly string[]>, calls: string[] } {
    const calls: string[] = []
    return { calls, resolve: async (host) => { calls.push(host); return ['127.0.0.1'] } }
  }

  it('loads a document under the pattern while the app holds the port, resolving no name', async () => {
    const { resolve, calls } = neverResolves()
    const asked: number[] = []
    const held = (port: number): boolean => { asked.push(port); return true }
    await expect(guestRequestAllowed('http://a.localhost:8123/', 'mainFrame', local, resolve, held)).resolves.toBe(true)
    await expect(guestRequestAllowed('http://b.localhost:8123/frame', 'subFrame', local, resolve, held)).resolves.toBe(true)
    expect(asked).toEqual([8123, 8123])
    expect(calls).toEqual([])
  })

  it('refuses a document under the pattern while the app holds no listener on the port', async () => {
    const { resolve } = neverResolves()
    await expect(guestRequestAllowed('http://a.localhost:8123/', 'mainFrame', local, resolve, () => false)).resolves.toBe(false)
  })

  it('refuses it when the question is not supplied (fail closed)', async () => {
    const { resolve } = neverResolves()
    await expect(guestRequestAllowed('http://a.localhost:8123/', 'mainFrame', local, resolve)).resolves.toBe(false)
  })

  it('refuses it when the question throws', async () => {
    const { resolve } = neverResolves()
    const throwing = (): boolean => { throw new Error('broker gone') }
    await expect(guestRequestAllowed('http://a.localhost:8123/', 'mainFrame', local, resolve, throwing)).resolves.toBe(false)
  })

  it('does not ask about a listener for a document the pattern does not admit', async () => {
    const { resolve } = neverResolves()
    const held = vi.fn(() => true)
    await expect(guestRequestAllowed('http://a.localhost:8124/', 'mainFrame', local, resolve, held)).resolves.toBe(false)
    await expect(guestRequestAllowed('http://127.0.0.1:8123/', 'mainFrame', local, resolve, held)).resolves.toBe(false)
    expect(held).not.toHaveBeenCalled()
  })

  it('never asks about a listener for a subresource, which is always the page\'s own business', async () => {
    const { resolve } = neverResolves()
    const held = vi.fn(() => false)
    await expect(guestRequestAllowed('http://a.localhost:8123/x.js', 'script', local, resolve, held)).resolves.toBe(true)
    expect(held).not.toHaveBeenCalled()
  })

  it('still resolves and checks a public name admitted by "*" listed beside the pattern', async () => {
    const { resolve, calls } = neverResolves()
    await expect(guestRequestAllowed('https://attacker.example/', 'mainFrame', ['*', ...local], resolve, () => true)).resolves.toBe(false)
    expect(calls).toEqual(['attacker.example'])
  })
})
