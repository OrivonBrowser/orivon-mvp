import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { commandById } from '../../shortcuts/commands.js'
import { PopupBlocks } from '../popup-blocks.js'
import { createPopupsBubble, popupsBlockedOverlay } from '../popups-overlay.js'
import { SiteSettingsStore } from '../site-settings-store.js'

const SITE = 'https://news.example'

class FakeTab extends EventEmitter {
  constructor (public url = `${SITE}/story`) { super() }
  getURL (): string { return this.url }
}

function rig (options: { blocked?: string[], defaultAllows?: boolean } = {}) {
  const tab = new FakeTab()
  const other = new FakeTab('https://other.example/')
  let activeTabId: string | null = 't1'
  const createTab = vi.fn()
  const window = {
    tabs: {
      getState: () => ({ activeTabId }),
      liveWebContents: (id: string) => id === 't1' ? tab : id === 't2' ? other : undefined,
      createTab
    }
  } as unknown as ShellWindow
  const store = new SiteSettingsStore(null)
  const run = vi.fn()
  const close = vi.fn()
  const services = { siteSettings: store, commands: { run }, settings: { get: () => options.defaultAllows === true ? 'allow' : 'block' } }
  const blocks = new PopupBlocks<WebContents>()
  for (const url of options.blocked ?? ['https://ads.example/1', 'https://ads.example/2']) blocks.add(tab as unknown as WebContents, url)
  const handler = createPopupsBubble({ window, services, close, send: vi.fn() } as unknown as OverlayWindow, blocks)
  return { tab, handler, store, close, run, createTab, blocks, setActive: (id: string | null) => { activeTabId = id } }
}

describe('the popups-blocked overlay', () => {
  it('is a 340px popup under the chip that closes like the other popups', () => {
    expect(popupsBlockedOverlay).toMatchObject({
      name: 'popups-blocked', placement: { kind: 'anchor', width: 340, align: 'left' }, surface: 'panel', layer: 'popup', focus: 'take', keep: 'fresh'
    })
    expect(popupsBlockedOverlay.closeOn).toEqual({ blur: true, tabSwitch: true, navigation: false, layout: true })
  })

  describe('show', () => {
    it('lists what the page in front tried to open, newest first, built in main', () => {
      const r = rig()
      expect(r.handler.show?.(undefined)).toMatchObject({
        origin: SITE, allowed: false, more: 0,
        rows: [{ host: 'ads.example', url: 'https://ads.example/2' }, { host: 'ads.example', url: 'https://ads.example/1' }]
      })
    })

    it('reports a site that is already allowed', () => {
      const r = rig()
      r.store.set(SITE, 'popups', 'allow')
      expect(r.handler.show?.(undefined)).toMatchObject({ allowed: true })
    })

    it('offers the Site settings link only once that command exists', () => {
      const r = rig()
      const view = r.handler.show?.(undefined) as { settingsLink: boolean }
      expect(view.settingsLink).toBe(commandById('siteSettings.open')?.pending !== true)
    })

    it('shows nothing when the page has nothing blocked or no tab is in front', () => {
      expect(rig({ blocked: [] }).handler.show?.(undefined)).toBeUndefined()
      const r = rig()
      r.setActive(null)
      expect(r.handler.show?.(undefined)).toBeUndefined()
      r.setActive('gone')
      expect(r.handler.show?.(undefined)).toBeUndefined()
    })
  })

  describe('open', () => {
    it('opens the address main recorded at that position in a new tab, then closes', () => {
      const r = rig()
      r.handler.show?.(undefined)
      r.handler.request({ type: 'open', index: 1 })
      expect(r.createTab).toHaveBeenCalledWith('https://ads.example/1')
      expect(r.close).toHaveBeenCalled()
    })

    it('refuses a position past the list, a bad shape and an address the page supplies', () => {
      const r = rig()
      r.handler.show?.(undefined)
      r.handler.request({ type: 'open', index: 2 })
      r.handler.request({ type: 'open', index: 0, url: 'https://evil.example/' })
      r.handler.request({ type: 'open', index: '0' })
      expect(r.createTab).not.toHaveBeenCalled()
    })

    it('does nothing before the bubble was shown, or once another tab is in front', () => {
      const r = rig()
      r.handler.request({ type: 'open', index: 0 })
      r.handler.show?.(undefined)
      r.setActive('t2')
      r.handler.request({ type: 'open', index: 0 })
      expect(r.createTab).not.toHaveBeenCalled()
    })

    it('does nothing when the page has moved to another site since the bubble opened', () => {
      const r = rig()
      r.handler.show?.(undefined)
      r.tab.url = 'https://elsewhere.example/'
      r.handler.request({ type: 'open', index: 0 })
      expect(r.createTab).not.toHaveBeenCalled()
    })
  })

  describe('apply', () => {
    it('stores an allow for the site the bubble was opened on, and only that one', () => {
      const r = rig()
      r.handler.show?.(undefined)
      r.handler.request({ type: 'apply', allow: true })
      expect(r.store.get(SITE, 'popups')).toBe('allow')
      expect(r.store.forOrigin('https://ads.example').size).toBe(0)
      expect(r.close).toHaveBeenCalled()
    })

    it('forgets an allow when the person goes back to blocking', () => {
      const r = rig()
      r.store.set(SITE, 'popups', 'allow')
      r.handler.show?.(undefined)
      r.handler.request({ type: 'apply', allow: false })
      expect(r.store.get(SITE, 'popups')).toBeUndefined()
    })

    it('keeps a block of the site\'s own when the default allows and the person keeps blocking', () => {
      const r = rig({ defaultAllows: true })
      r.store.set(SITE, 'popups', 'block')
      r.handler.show?.(undefined)
      r.handler.request({ type: 'apply', allow: false })
      expect(r.store.get(SITE, 'popups')).toBe('block')
    })

    it('turns an allow into a block of the site\'s own when the default allows', () => {
      const r = rig({ defaultAllows: true })
      r.store.set(SITE, 'popups', 'allow')
      r.handler.show?.(undefined)
      r.handler.request({ type: 'apply', allow: false })
      expect(r.store.get(SITE, 'popups')).toBe('block')
    })

    it('writes nothing for the tab in front when it is not the one the bubble was opened for', () => {
      const r = rig()
      r.handler.show?.(undefined)
      r.setActive('t2')
      r.handler.request({ type: 'apply', allow: true })
      expect(r.store.get('https://other.example', 'popups')).toBeUndefined()
      expect(r.store.get(SITE, 'popups')).toBeUndefined()
    })
  })

  describe('settings', () => {
    it('opens Site settings only when the command is no longer pending', () => {
      const r = rig()
      r.handler.show?.(undefined)
      r.handler.request({ type: 'settings' })
      if (commandById('siteSettings.open')?.pending === true) expect(r.run).not.toHaveBeenCalled()
      else expect(r.run).toHaveBeenCalledWith('siteSettings.open', expect.anything())
    })
  })

  it('forgets what it listed when it closes', () => {
    const r = rig()
    r.handler.show?.(undefined)
    r.handler.closed?.('escape')
    r.handler.request({ type: 'open', index: 0 })
    expect(r.createTab).not.toHaveBeenCalled()
  })
})
