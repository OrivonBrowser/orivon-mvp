import { describe, expect, it, vi } from 'vitest'
import type { WebPreferences } from 'electron'
import { partitionFor } from '../../../broker/grants/origin-hash.js'
import { embedPartitionFor, guestRequestAllowed, guestRequestAllowedAsync, hardenGuest } from '../embed-guard.js'

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
      devTools: false
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

describe('guestRequestAllowed', () => {
  const granted = ['https://example.com']

  it('refuses everything, subresources included, with no live grant', () => {
    expect(guestRequestAllowed('https://example.com/', 'mainFrame', undefined)).toBe(false)
    expect(guestRequestAllowed('https://example.com/x.png', 'image', undefined)).toBe(false)
  })

  it('judges a top-frame and a subframe document against the grant', () => {
    expect(guestRequestAllowed('https://example.com/page', 'mainFrame', granted)).toBe(true)
    expect(guestRequestAllowed('https://other.example/page', 'mainFrame', granted)).toBe(false)
    expect(guestRequestAllowed('https://other.example/frame', 'subFrame', granted)).toBe(false)
  })

  it('lets a subresource through whatever its origin', () => {
    expect(guestRequestAllowed('https://cdn.other.example/lib.js', 'script', granted)).toBe(true)
    expect(guestRequestAllowed('https://cdn.other.example/x.png', 'image', granted)).toBe(true)
    expect(guestRequestAllowed('https://api.other.example/data', 'xhr', granted)).toBe(true)
  })
})

// C-7/A286: no cancellable webRequest event carries the address a document
// actually connects to, so a "*"-admitted NAME is resolved and checked
// here first, through an injected resolver standing in for the guest
// session's own Session.resolveHost (./embed-host.ts wires the real one).
describe('guestRequestAllowedAsync', () => {
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
    await expect(guestRequestAllowedAsync('https://example.com/', 'mainFrame', undefined, resolve)).resolves.toBe(false)
    await expect(guestRequestAllowedAsync('https://example.com/x.png', 'image', undefined, resolve)).resolves.toBe(false)
    expect(calls).toEqual([])
  })

  it('lets a subresource through under a "*" grant without ever calling resolve', async () => {
    const { resolve, calls } = resolverAnswering(['192.168.1.1'])
    await expect(guestRequestAllowedAsync('https://anything.example/lib.js', 'script', wildcard, resolve)).resolves.toBe(true)
    expect(calls).toEqual([])
  })

  it('allows an exact-origin match without calling resolve, even for a private/loopback origin named exactly (ADR-0039)', async () => {
    const { resolve, calls } = resolverAnswering(['10.0.0.1'])
    await expect(guestRequestAllowedAsync('https://intranet.internal/page', 'mainFrame', exactPrivate, resolve)).resolves.toBe(true)
    expect(calls).toEqual([])
  })

  it('refuses a "*"-admitted name that resolves to a private address', async () => {
    const { resolve } = resolverAnswering(['192.168.1.1'])
    await expect(guestRequestAllowedAsync('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('refuses a "*"-admitted name that resolves to a loopback address', async () => {
    const { resolve } = resolverAnswering(['127.0.0.1'])
    await expect(guestRequestAllowedAsync('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('refuses a "*"-admitted name whose answer mixes a public and a private address', async () => {
    const { resolve } = resolverAnswering(['93.184.216.34', '192.168.1.1'])
    await expect(guestRequestAllowedAsync('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('allows a "*"-admitted name whose every resolved address is public unicast', async () => {
    const { resolve, calls } = resolverAnswering(['93.184.216.34'])
    await expect(guestRequestAllowedAsync('https://good.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(true)
    expect(calls).toEqual(['good.example'])
  })

  it('refuses a "*"-admitted name whose resolve rejects (fail closed)', async () => {
    const resolve = vi.fn(async (): Promise<readonly string[]> => { throw new Error('resolution failed') })
    await expect(guestRequestAllowedAsync('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('refuses a "*"-admitted name that resolves to no address at all', async () => {
    const { resolve } = resolverAnswering([])
    await expect(guestRequestAllowedAsync('https://attacker.example/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
  })

  it('allows a "*"-admitted PUBLIC address literal without calling resolve (already proven public by the pure gate)', async () => {
    const { resolve, calls } = resolverAnswering(['192.168.1.1'])
    await expect(guestRequestAllowedAsync('http://93.184.216.34/', 'mainFrame', wildcard, resolve)).resolves.toBe(true)
    expect(calls).toEqual([])
  })

  it('refuses a loopback/localhost host under "*" with no lookup at all -- the pure hostname gate stays first', async () => {
    const { resolve, calls } = resolverAnswering(['93.184.216.34'])
    await expect(guestRequestAllowedAsync('http://127.0.0.1:8080/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
    await expect(guestRequestAllowedAsync('http://localhost:3000/', 'mainFrame', wildcard, resolve)).resolves.toBe(false)
    expect(calls).toEqual([])
  })
})
