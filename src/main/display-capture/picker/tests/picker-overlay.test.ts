import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../../overlays/overlay-types.js'
import type { ShellWindow } from '../../../shell/window-registry.js'
import type { TabState } from '../../../shell/tab-types.js'
import type { DisplayChoice, DisplayHints, DisplayRequest } from '../../types.js'
import { createPicker, PICKER_OVERLAY, pickerOverlayFor, SHARE_GUARD_MS } from '../picker-overlay.js'
import type { PickerDeps } from '../picker-overlay.js'
import { PERMISSION_TEXT, SCREEN_SETTINGS_URL } from '../picker-model.js'
import type { PickerPlatform } from '../picker-model.js'
import { PickerStore } from '../picker-store.js'
import type { FeedTimers, RawSource } from '../picker-sources.js'

interface FakeTab { id: number, getURL: () => string, isDestroyed: () => boolean }
const fakeTab = (id: number): FakeTab => ({ id, getURL: () => `https://t${String(id)}.example/secret-path`, isDestroyed: () => false })
const state = (id: string, over: Partial<TabState> = {}): TabState => ({
  id, url: `https://${id}.example/`, displayUrl: `https://${id}.example/`, title: `Title ${id}`, favicon: null, isInternal: false, isNewTab: false, crashed: null, ...over
} as TabState)
const source = (id: string, name = id): RawSource => ({
  id, name, thumbnail: { isEmpty: () => false, toJPEG: () => Buffer.from('jpeg') }, appIcon: null
})

function rig (options: { platform?: Partial<PickerPlatform>, hints?: DisplayHints, audio?: boolean, sources?: RawSource[] } = {}) {
  const tabs = [fakeTab(1), fakeTab(2), fakeTab(3)]
  const states = [state('a'), state('b'), state('c')]
  const ids = ['a', 'b', 'c']
  let activeTabId = 'a'
  const window = {
    window: { isDestroyed: () => false },
    tabs: {
      getState: () => ({ activeTabId, tabs: states }),
      liveWebContents: (id: string) => tabs[ids.indexOf(id)]
    }
  } as unknown as ShellWindow
  const activated: string[] = []
  ;(window.tabs as unknown as { activateTab: (id: string) => void }).activateTab = (id) => { activated.push(id); activeTabId = id }
  const services = { windows: { all: () => [window], findTab: (contents: FakeTab) => ({ window, tabId: ids[tabs.indexOf(contents)] ?? '' }) } }
  const close = vi.fn()
  const sent: unknown[] = []
  const overlay = { window, services, close, send: (event: unknown) => { sent.push(event) } } as unknown as OverlayWindow
  const clock = { now: 1000 }
  const store = new PickerStore()
  let counter = 0
  const queue: Array<() => void> = []
  const timers: FeedTimers = { after: (run) => { queue.push(run); return () => { queue.splice(queue.indexOf(run), 1) } } }
  const getSources = vi.fn(async (listing: Parameters<PickerDeps['getSources']>[0]) => {
    void listing
    return options.sources ?? [source('window:11:0', 'Terminal'), source('window:12:0', 'Editor')]
  })
  const platform: PickerPlatform = { os: 'linux', wayland: false, screenDenied: false, ...options.platform }
  const deps: PickerDeps = {
    store,
    platform: () => platform,
    getSources,
    captureTab: vi.fn(async () => 'data:image/jpeg;base64,AAAA'),
    openSettings: vi.fn(),
    now: () => clock.now,
    timers
  }
  const handler = createPicker(deps, overlay)
  const request: DisplayRequest = { tab: tabs[0] as never, origin: 'https://meet.example', isApp: false, audio: options.audio === true, hints: options.hints ?? {} }
  const open = (): { view: Record<string, any>, id: string, answer: Promise<DisplayChoice | null> } => {
    const asked = store.add(window, 'a', request)
    const view = handler.show?.({ id: asked.question.id }) as Record<string, any>
    return { view, id: asked.question.id, answer: asked.answer }
  }
  const drawn = (id: string): void => { handler.request({ type: 'drawn', id }); clock.now += SHARE_GUARD_MS }
  const settle = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  return { activated, handler, store, deps, getSources, close, sent, clock, open, drawn, settle, tabs, setActive: (id: string) => { activeTabId = id }, platform }
}

const ownCard = (view: Record<string, any>): Record<string, any> => view['cards'].tab[0]

describe('the picker overlay', () => {
  it('is a 640px centred sheet that takes focus, ends on navigation and may grow to 540px', () => {
    const def = pickerOverlayFor({} as PickerDeps)
    expect(def.name).toBe(PICKER_OVERLAY)
    expect(def.placement).toEqual({ kind: 'area', at: 'center', width: 640 })
    expect(def).toMatchObject({ focus: 'take', layer: 'bar', keep: 'fresh', surface: 'panel' })
    expect(def.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: true, layout: false })
    expect(def.height?.max).toBe(540)
  })

  describe('show', () => {
    it('names the site, offers the tabs with the asking tab first, and opens on tabs without hints', () => {
      const r = rig()
      const { view } = r.open()
      expect(view['title']).toBe('Choose what to share with https://meet.example')
      expect(view['segments']).toEqual(['tab', 'window', 'screen'])
      expect(view['segment']).toBe('tab')
      expect(view['cards'].tab.map((card: Record<string, unknown>) => [card['label'], card['self']])).toEqual([['Title a', true], ['Title b', false], ['Title c', false]])
      expect(view['selected']).toBeNull()
    })

    it('hands the page ids made in main and nothing that names a tab or a desktop source', () => {
      const r = rig()
      const { view } = r.open()
      const text = JSON.stringify(view)
      expect(text).not.toMatch(/screen:|window:\d|webContents|secret-path/)
      const ids = view['cards'].tab.map((card: Record<string, unknown>) => card['id'])
      expect(new Set(ids).size).toBe(3)
      for (const id of ids) expect(id).toMatch(/^[0-9a-f]{16}$/)
    })

    it('opens on the surface the page named and preselects this tab when it prefers it', () => {
      expect(rig({ hints: { displaySurface: 'window' } }).open().view['segment']).toBe('window')
      expect(rig({ hints: { displaySurface: 'monitor' } }).open().view['segment']).toBe('screen')
      const r = rig({ hints: { preferCurrentTab: true } })
      const { view } = r.open()
      expect(view['segment']).toBe('tab')
      expect(view['selected']).toBe(ownCard(view)['id'])
    })

    it('drops the asking tab when the page excludes it, and the screen segment when it excludes monitors', () => {
      const { view } = rig({ hints: { selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'exclude' } }).open()
      expect(view['cards'].tab.map((card: Record<string, unknown>) => card['label'])).toEqual(['Title b', 'Title c'])
      expect(view['segments']).toEqual(['tab', 'window'])
    })

    it('says which audio options apply: tab audio when asked, system audio on Windows with the page default', () => {
      expect(rig({ audio: true }).open().view['audio']).toEqual({ tab: true, system: false, systemDefault: false })
      expect(rig({ audio: true, platform: { os: 'win32' }, hints: { systemAudio: 'include' } }).open().view['audio']).toEqual({ tab: true, system: true, systemDefault: true })
      expect(rig({ audio: false }).open().view['audio']).toMatchObject({ tab: false, system: false })
    })

    it('shows nothing for a question another window asked, one answered already, or one whose tab is not in front', () => {
      const r = rig()
      const other = r.store.add({}, 'a', { tab: r.tabs[0] as never, origin: 'https://x.example', isApp: false, audio: false, hints: {} })
      expect(r.handler.show?.({ id: other.question.id })).toBeUndefined()
      const asked = r.open()
      r.store.settle(asked.id, null)
      expect(r.handler.show?.({ id: asked.id })).toBeUndefined()
      const again = r.store.add((r.deps as unknown as { store: PickerStore }).store.get(asked.id)?.owner ?? {}, 'b', { tab: r.tabs[0] as never, origin: 'https://x.example', isApp: false, audio: false, hints: {} })
      expect(r.handler.show?.({ id: again.question.id })).toBeUndefined()
      expect(r.handler.show?.({ id: 'nonsense' })).toBeUndefined()
      expect(r.handler.show?.({ id: asked.id, extra: 1 })).toBeUndefined()
    })

    it('captures thumbnails for the tabs and offers the list again with them', async () => {
      const r = rig()
      r.open()
      await r.settle()
      expect(r.deps.captureTab).toHaveBeenCalledTimes(3)
      const update = r.sent.find((event) => (event as { type: string }).type === 'cards') as { segment: string, cards: Array<{ thumb: string | null }> }
      expect(update.segment).toBe('tab')
      expect(update.cards.every((card) => card.thumb === 'data:image/jpeg;base64,AAAA')).toBe(true)
    })
  })

  describe('share a tab', () => {
    it('refuses until the picker is drawn, for the guard after that, and while the keyboard has just moved', () => {
      const r = rig()
      const { view, id, answer } = r.open()
      const card = view['cards'].tab[1]['id']
      const done = vi.fn()
      void answer.then(done)
      r.handler.request({ type: 'share', id, card, audio: false })
      r.handler.request({ type: 'drawn', id })
      r.clock.now += SHARE_GUARD_MS - 1
      r.handler.request({ type: 'share', id, card, audio: false })
      r.clock.now += 1
      r.handler.key?.({ key: 'Tab', isAutoRepeat: false })
      r.handler.request({ type: 'share', id, card, audio: false })
      expect(r.store.get(id)?.settled).toBe(false)
      r.clock.now += SHARE_GUARD_MS
      r.handler.request({ type: 'share', id, card, audio: false })
      expect(r.store.get(id)).toBeUndefined()
      expect(r.close).toHaveBeenCalledTimes(1)
    })

    it('resolves with the tab, its label and tab audio only when the page asked and the person ticked it', async () => {
      for (const [asked, ticked, expected] of [[true, true, true], [true, false, false], [false, true, false]] as const) {
        const r = rig({ audio: asked })
        const { view, id, answer } = r.open()
        r.drawn(id)
        r.handler.request({ type: 'share', id, card: view['cards'].tab[1]['id'], audio: ticked })
        const choice = await answer
        expect(choice).toMatchObject({ kind: 'tab', audio: expected, label: 'Title b' })
        expect((choice as { tab: unknown }).tab).toBe(r.tabs[1])
      }
    })

    it('brings a tab that is not in front to the front as the choice resolves, and leaves the tab already in front alone', async () => {
      const r = rig()
      const { view, id, answer } = r.open()
      r.drawn(id)
      r.handler.request({ type: 'share', id, card: view['cards'].tab[0]['id'], audio: false })
      await answer
      expect(r.activated).toEqual([])
      const other = rig()
      const second = other.open()
      other.drawn(second.id)
      other.handler.request({ type: 'share', id: second.id, card: second.view['cards'].tab[2]['id'], audio: false })
      await second.answer
      expect(other.activated).toEqual(['c'])
    })

    it('refuses a card main never offered, and one of a tab that closed since', async () => {
      const r = rig()
      const { view, id } = r.open()
      r.drawn(id)
      r.handler.request({ type: 'share', id, card: 'forged', audio: false })
      r.handler.request({ type: 'share', id, card: String(r.tabs[1]?.id), audio: false })
      expect(r.store.get(id)?.settled).toBe(false)
      const card = view['cards'].tab[2]['id']
      r.tabs[2] = { ...fakeTab(3), isDestroyed: () => true }
      r.handler.request({ type: 'share', id, card, audio: false })
      expect(r.store.get(id)?.settled).toBe(false)
      expect(r.sent.filter((event) => (event as { type: string }).type === 'cards').length).toBeGreaterThan(0)
    })
  })

  describe('windows and screens', () => {
    it('lists the segment once it is in view, and shares a window without audio', async () => {
      const r = rig({ audio: true, platform: { os: 'win32' } })
      const { view, id, answer } = r.open()
      expect(r.getSources).not.toHaveBeenCalled()
      r.drawn(id)
      r.handler.request({ type: 'segment', id, segment: 'window' })
      await r.settle()
      expect(r.getSources).toHaveBeenCalledWith({ types: ['window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true })
      const update = [...r.sent].reverse().find((event) => (event as { type: string, segment: string }).segment === 'window') as { cards: Array<{ id: string, label: string, thumb: string }> }
      expect(update.cards.map((card) => card.label)).toEqual(['Terminal', 'Editor'])
      expect(JSON.stringify(update)).not.toContain('window:11')
      expect(view['cards'].window).toEqual([])
      r.handler.request({ type: 'share', id, card: update.cards[1]?.id, audio: true })
      expect(await answer).toEqual({ kind: 'window', source: { id: 'window:12:0', name: 'Editor' }, systemAudio: false, label: 'Editor' })
    })

    it('shares a screen with system audio only on Windows and only when ticked', async () => {
      for (const [os, ticked, expected] of [['win32', true, true], ['win32', false, false], ['linux', true, false]] as const) {
        const r = rig({ audio: true, platform: { os }, sources: [source('screen:0:0', 'Entire screen')] })
        const { id, answer } = r.open()
        r.drawn(id)
        r.handler.request({ type: 'segment', id, segment: 'screen' })
        await r.settle()
        const update = [...r.sent].reverse().find((event) => (event as { segment: string }).segment === 'screen') as { cards: Array<{ id: string }> }
        r.handler.request({ type: 'share', id, card: update.cards[0]?.id, audio: ticked })
        expect(await answer).toEqual({ kind: 'screen', source: { id: 'screen:0:0', name: 'Entire screen' }, systemAudio: expected, label: 'Entire screen' })
      }
    })

    it('keeps a card id across a refresh, so a selection survives it', async () => {
      const r = rig()
      const { id } = r.open()
      r.handler.request({ type: 'segment', id, segment: 'window' })
      await r.settle()
      const lastWindowCards = (): string[] => ([...r.sent].reverse().find((event) => (event as { segment: string }).segment === 'window') as { cards: Array<{ id: string }> }).cards.map((card) => card.id)
      const first = lastWindowCards()
      r.getSources.mockResolvedValueOnce([source('window:12:0', 'Editor'), source('window:11:0', 'Terminal')])
      r.handler.request({ type: 'segment', id, segment: 'tab' })
      r.handler.request({ type: 'segment', id, segment: 'window' })
      await r.settle()
      const second = lastWindowCards()
      expect(second).toEqual([first[1], first[0]])
    })

    it('does not list a segment the page excluded', async () => {
      const r = rig({ hints: { monitorTypeSurfaces: 'exclude' } })
      const { id } = r.open()
      r.handler.request({ type: 'segment', id, segment: 'screen' })
      await r.settle()
      expect(r.getSources).not.toHaveBeenCalled()
    })

    it('stops listing when the picker closes', async () => {
      const r = rig({ hints: { displaySurface: 'window' } })
      r.open()
      await r.settle()
      expect(r.getSources).toHaveBeenCalledTimes(1)
      r.handler.closed?.('request')
      await r.settle()
      r.handler.request({ type: 'segment', id: 'x', segment: 'window' })
      expect(r.getSources).toHaveBeenCalledTimes(1)
    })
  })

  describe('Linux Wayland', () => {
    const wayland = { wayland: true }

    it('shows one card each for windows and screens and asks the system for nothing until Share', () => {
      const r = rig({ platform: wayland })
      const { view } = r.open()
      expect(view['modes']).toEqual({ window: 'portal', screen: 'portal' })
      expect(view['cards'].window.map((card: Record<string, unknown>) => card['label'])).toEqual(['Choose a window in the system dialog'])
      expect(view['cards'].screen.map((card: Record<string, unknown>) => card['label'])).toEqual(['Choose a screen in the system dialog'])
      expect(r.getSources).not.toHaveBeenCalled()
    })

    it('asks the system for nothing at Share either: the choice carries a source id the capture has never been given', async () => {
      const r = rig({ platform: wayland })
      const { view, id, answer } = r.open()
      r.drawn(id)
      r.handler.request({ type: 'share', id, card: view['cards'].screen[0]['id'], audio: false })
      expect(r.getSources).not.toHaveBeenCalled()
      expect(await answer).toEqual({ kind: 'screen', source: { id: expect.stringMatching(/^screen:\d+:0$/), name: 'Shared screen' }, systemAudio: false, label: 'Shared screen', portal: true })
      expect(r.close).toHaveBeenCalled()
    })

    it('answers a window card with a window choice', async () => {
      const r = rig({ platform: wayland })
      const { view, id, answer } = r.open()
      r.drawn(id)
      r.handler.request({ type: 'segment', id, segment: 'window' })
      r.handler.request({ type: 'share', id, card: view['cards'].window[0]['id'], audio: false })
      expect(await answer).toMatchObject({ kind: 'window', source: { id: expect.stringMatching(/^window:\d+:0$/) }, label: 'Shared window' })
    })

    it('gives every share a different source id, above any id the capture numbers itself', async () => {
      const ids: number[] = []
      for (let i = 0; i < 2; i++) {
        const r = rig({ platform: wayland })
        const { view, id, answer } = r.open()
        r.drawn(id)
        r.handler.request({ type: 'share', id, card: view['cards'].screen[0]['id'], audio: false })
        const choice = await answer
        ids.push(Number(/^screen:(\d+):0$/.exec(choice !== null && 'source' in choice ? choice.source.id : '')?.[1]))
      }
      expect(new Set(ids).size).toBe(2)
      expect(ids.every((n) => n > 2 ** 40)).toBe(true)
    })
  })

  describe('macOS without Screen Recording permission', () => {
    const denied = { os: 'darwin' as const, screenDenied: true }

    it('lists nothing for windows and screens and says why', async () => {
      const r = rig({ platform: denied, hints: { displaySurface: 'monitor' } })
      const { view } = r.open()
      expect(view['modes']).toEqual({ window: 'permission', screen: 'permission' })
      expect(view['permissionText']).toBe(PERMISSION_TEXT)
      await r.settle()
      expect(r.getSources).not.toHaveBeenCalled()
    })

    it('opens the Screen Recording pane of System Settings, and only then', () => {
      const r = rig({ platform: denied })
      const { id } = r.open()
      r.handler.request({ type: 'open-settings', id })
      expect(r.deps.openSettings).toHaveBeenCalledWith(SCREEN_SETTINGS_URL)
      const other = rig()
      other.handler.request({ type: 'open-settings', id: other.open().id })
      expect(other.deps.openSettings).not.toHaveBeenCalled()
    })

    it('lists as usual once the permission is granted', async () => {
      const r = rig({ platform: { os: 'darwin', screenDenied: false }, hints: { displaySurface: 'window' } })
      expect(r.open().view['modes']).toEqual({ window: 'list', screen: 'list' })
      await r.settle()
      expect(r.getSources).toHaveBeenCalledTimes(1)
    })
  })

  describe('ways out and commands', () => {
    it('answers no on Cancel and closes', async () => {
      const r = rig()
      const { id, answer } = r.open()
      r.handler.request({ type: 'cancel', id })
      expect(await answer).toBeNull()
      expect(r.close).toHaveBeenCalledTimes(1)
    })

    it('ignores a command for a question that is not the one on screen, or with keys it does not know', () => {
      const r = rig()
      const { view, id } = r.open()
      r.drawn(id)
      const card = view['cards'].tab[1]['id']
      for (const command of [
        { type: 'share', id: 'other', card, audio: false }, { type: 'share', id, card, audio: false, extra: 1 }, { type: 'share', id, card },
        { type: 'cancel', id, origin: 'https://evil.example' }, { type: 'segment', id, segment: 'monitor' }, 'cancel', null, { type: 'drawn' }
      ]) expect(r.handler.request(command)).toBeUndefined()
      expect(r.store.get(id)?.settled).toBe(false)
      expect(r.close).not.toHaveBeenCalled()
    })

    it('ignores commands once the tab it asked for is no longer in front', () => {
      const r = rig()
      const { id } = r.open()
      r.setActive('b')
      r.handler.request({ type: 'cancel', id })
      expect(r.close).not.toHaveBeenCalled()
    })

    it('starts the guard over when the picker is moved, and tells the page', () => {
      const r = rig()
      const { view, id } = r.open()
      r.drawn(id)
      r.handler.moved?.()
      r.handler.request({ type: 'share', id, card: view['cards'].tab[1]['id'], audio: false })
      expect(r.store.get(id)?.settled).toBe(false)
      expect(r.sent).toContainEqual({ type: 'arm' })
    })
  })
})
