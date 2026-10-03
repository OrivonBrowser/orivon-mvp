import { describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'

const owner = { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn(), onHeadersReceived: vi.fn() }
const { clearStorageData } = vi.hoisted(() => ({ clearStorageData: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ session: { defaultSession: { name: 'default', clearStorageData } } }))
vi.mock('../../sessions/web-request-owner.js', () => ({ webRequestOwnerFor: vi.fn(() => owner) }))
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: () => false }))

const { installContentSettings } = await import('../install-content-settings.js')
const { webRequestOwnerFor } = await import('../../sessions/web-request-owner.js')
const { SiteSettingsStore } = await import('../site-settings-store.js')
const { siteSound } = await import('../site-sound.js')
const { siteContentBlocks } = await import('../site-content-blocks.js')
const { sitePopups } = await import('../site-popups.js')
const { SCRIPT_BLOCK_POLICY } = await import('../content-rules.js')

const SITE = 'https://shop.example'

function rig (values: Record<string, string> = {}, windows: unknown[] = []) {
  const store = new SiteSettingsStore(null)
  let settingsListener: ((change: { key: string }) => void) | undefined
  const onStart = vi.fn()
  const subscribe = vi.fn()
  const services = {
    settings: { get: (key: string) => values[key] ?? (key === 'sites.popups' ? 'block' : key === 'sites.autoDownloads' ? 'ask' : 'allow'), onChange: (l: (change: { key: string }) => void) => { settingsListener = l; return () => {} } },
    siteSettings: store,
    windows: { all: () => windows, findTab: () => null },
    tabLifecycle: { subscribe },
    downloads: { onStart }
  } as unknown as ShellServices
  installContentSettings.install({} as never, services, {} as never, {} as never)
  return { store, subscribe, onStart, changeSetting: (key: string) => { settingsListener?.({ key }) } }
}

type HeadersHandler = (details: unknown, current: { responseHeaders: Record<string, string[]> }) => { responseHeaders: Record<string, string[]> }
type RequestHandler = (details: unknown, current: object) => object

const headersHandler = (): HeadersHandler => owner.onHeadersReceived.mock.calls.at(-1)?.[3] as HeadersHandler
const requestHandler = (): RequestHandler => owner.onBeforeRequest.mock.calls.at(-1)?.[3] as RequestHandler

describe('the content-settings installer', () => {
  it('registers on the default session\'s one owner, after the privacy controls, for web addresses only', () => {
    rig()
    expect(webRequestOwnerFor).toHaveBeenCalledWith(expect.objectContaining({ name: 'default' }))
    expect(owner.onHeadersReceived).toHaveBeenCalledWith(30, { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame', 'subFrame'] }, expect.any(Function), expect.any(Function))
    expect(owner.onBeforeRequest).toHaveBeenCalledWith(30, { urls: ['http://*/*', 'https://*/*'], types: ['image'] }, expect.any(Function), expect.any(Function))
    const matches = owner.onHeadersReceived.mock.calls.at(-1)?.[2] as (url: string) => boolean
    expect(matches('https://a.example/')).toBe(true)
    expect(matches('orivon://settings/')).toBe(false)
  })

  it('follows tabs as they are created and their views replaced', () => {
    const { subscribe } = rig()
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ tabCreated: expect.any(Function), viewReplaced: expect.any(Function) }))
  })

  describe('JavaScript', () => {
    const page = { resourceType: 'mainFrame', url: `${SITE}/cart` }

    it('adds the script block to a main frame of a site told to block JavaScript, beside the page\'s own policy', () => {
      const { store } = rig()
      store.set(SITE, 'javascript', 'block')
      const result = headersHandler()(page, { responseHeaders: { 'Content-Security-Policy': ["default-src 'self'"], 'Content-Type': ['text/html'] } })
      expect(result.responseHeaders['Content-Security-Policy']).toEqual(["default-src 'self'", SCRIPT_BLOCK_POLICY])
    })

    it('takes the service workers off a site told to block JavaScript, and off every site when blocking becomes the default', () => {
      clearStorageData.mockClear()
      const { store, changeSetting } = rig({ 'sites.javascript': 'block' })
      store.set(SITE, 'javascript', 'block')
      expect(clearStorageData).toHaveBeenCalledWith({ origin: SITE, storages: ['serviceworkers'] })
      store.set('https://allowed.example', 'javascript', 'allow')
      expect(clearStorageData).toHaveBeenCalledTimes(1)
      changeSetting('sites.javascript')
      expect(clearStorageData).toHaveBeenLastCalledWith({ storages: ['serviceworkers'] })
    })

    it('hands the same headers back for a site that was not told to, and for a PDF', () => {
      const { store } = rig()
      const current = { responseHeaders: { 'Content-Type': ['text/html'] } }
      expect(headersHandler()(page, current)).toBe(current)
      store.set(SITE, 'javascript', 'block')
      const pdf = { responseHeaders: { 'content-type': ['application/pdf'] } }
      expect(headersHandler()(page, pdf)).toBe(pdf)
    })

    it('judges a frame by the top page it sits in, not by its own address', () => {
      const { store } = rig()
      store.set(SITE, 'javascript', 'block')
      const frame = { resourceType: 'subFrame', url: 'https://widgets.example/w', frame: { top: { url: `${SITE}/cart` } } }
      expect(headersHandler()(frame, { responseHeaders: {} }).responseHeaders['Content-Security-Policy']).toEqual([SCRIPT_BLOCK_POLICY])
      const other = { resourceType: 'subFrame', url: `${SITE}/w`, frame: { top: { url: 'https://other.example/' } } }
      const current = { responseHeaders: {} }
      expect(headersHandler()(other, current)).toBe(current)
    })

    it('leaves a response that is not a document alone, however the page is set', () => {
      const { store } = rig()
      store.set(SITE, 'javascript', 'block')
      const current = { responseHeaders: {} }
      for (const resourceType of ['image', 'script', 'xhr', 'stylesheet']) {
        expect(headersHandler()({ resourceType, url: `${SITE}/a`, frame: { top: { url: `${SITE}/` } } }, current)).toBe(current)
      }
    })

    it('follows a changed default on the next response', () => {
      const values: Record<string, string> = {}
      rig(values)
      const current = { responseHeaders: {} }
      expect(headersHandler()(page, current)).toBe(current)
      values['sites.javascript'] = 'block'
      expect(headersHandler()(page, current)).not.toBe(current)
    })
  })

  describe('images', () => {
    it('cancels an image of a page whose site blocks images, and no other', () => {
      const { store } = rig()
      store.set(SITE, 'images', 'block')
      const current = {}
      expect(requestHandler()({ resourceType: 'image', url: 'https://cdn.example/a.png', frame: { top: { url: `${SITE}/` } } }, current)).toEqual({ cancel: true })
      expect(requestHandler()({ resourceType: 'image', url: 'https://cdn.example/a.png', frame: { top: { url: 'https://other.example/' } } }, current)).toBe(current)
    })

    it('never cancels a navigation or any other request that is not an image, whatever page the tab shows', () => {
      const { store } = rig()
      store.set(SITE, 'images', 'block')
      const current = {}
      for (const resourceType of ['mainFrame', 'subFrame', 'script', 'xhr']) {
        expect(requestHandler()({ resourceType, url: 'https://elsewhere.example/', webContents: { getURL: () => `${SITE}/` } }, current)).toBe(current)
      }
    })

    it('falls back to the tab\'s address when the request has no frame', () => {
      const { store } = rig()
      store.set(SITE, 'images', 'block')
      expect(requestHandler()({ resourceType: 'image', url: 'https://cdn.example/a.png', webContents: { getURL: () => `${SITE}/` } }, {})).toEqual({ cancel: true })
    })

    it('lets an image through when the page cannot be placed', () => {
      rig({ 'sites.images': 'block' })
      const current = {}
      expect(requestHandler()({ resourceType: 'image', url: 'https://cdn.example/a.png' }, current)).toBe(current)
    })
  })

  describe('the key\'s mark', () => {
    it('is on for a site with any of the three switched off, and announces each change to a setting', () => {
      const { store, changeSetting } = rig()
      const changed = vi.fn()
      siteContentBlocks.onChange(changed)
      expect(siteContentBlocks.blocked(`${SITE}/`)).toBe(false)
      store.set(SITE, 'images', 'block')
      expect(siteContentBlocks.blocked(`${SITE}/`)).toBe(true)
      expect(siteContentBlocks.blocked('https://other.example/')).toBe(false)
      expect(changed).toHaveBeenCalledTimes(1)
      changeSetting('sites.javascript')
      expect(changed).toHaveBeenCalledTimes(2)
      changeSetting('privacy.cookies')
      expect(changed).toHaveBeenCalledTimes(2)
    })
  })

  describe('sound', () => {
    it('silences a site told to be silent and no other', () => {
      const { store } = rig()
      store.set(SITE, 'sound', 'block')
      expect(siteSound.blocked(`${SITE}/video`)).toBe(true)
      expect(siteSound.blocked('https://other.example/')).toBe(false)
    })

    it('applies the rule to every open tab when a site\'s answer or the default changes', () => {
      const setAudioMuted = vi.fn()
      const changed = vi.fn()
      const record = { muted: false, view: { webContents: { isDestroyed: () => false, getURL: () => `${SITE}/video`, setAudioMuted } } }
      const window = { tabs: { ids: () => ['a'], record: () => record, changed } }
      const { store, changeSetting } = rig({}, [window])
      store.set(SITE, 'sound', 'block')
      expect(setAudioMuted).toHaveBeenLastCalledWith(true)
      expect(changed).toHaveBeenCalledTimes(1)
      changeSetting('sites.sound')
      expect(changed).toHaveBeenCalledTimes(2)
      changeSetting('privacy.cookies')
      expect(changed).toHaveBeenCalledTimes(2)
    })
  })

  it('blocks pop-ups from a page with no recent input, and answers false for a tab it knows nothing of before', () => {
    rig()
    const tab = { on: vi.fn(), listenerCount: vi.fn() } as never
    expect(sitePopups.check(tab, `${SITE}/`, 'https://ads.example/')).toBe(true)
  })

  it('watches automatic downloads', () => {
    expect(rig().onStart).toHaveBeenCalledWith(expect.any(Function))
  })
})
