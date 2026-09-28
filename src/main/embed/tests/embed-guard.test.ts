import { describe, expect, it } from 'vitest'
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
