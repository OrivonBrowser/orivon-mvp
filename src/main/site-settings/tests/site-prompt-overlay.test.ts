import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { OverlayWindow } from '../../overlays/overlay-types.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { commandById } from '../../shortcuts/commands.js'
import { createAskSite, createOfferRestart } from '../ask-site.js'
import { PageAccess } from '../page-access.js'
import { ANSWER_GUARD_MS, createSitePrompt, sitePromptOverlay } from '../site-prompt-overlay.js'
import { SiteSettingsStore } from '../site-settings-store.js'

const SITE = 'https://meet.example'

class FakeTab extends EventEmitter {
  reload = vi.fn()
  constructor (public url = `${SITE}/room`) { super() }
  getURL (): string { return this.url }
}

function rig (options: { isPrivate?: boolean, defaults?: Record<string, string> } = {}) {
  const tab = new FakeTab()
  const shows: Array<{ payload: unknown }> = []
  let activeTabId: string | null = 't1'
  const window = {
    tabs: {
      getState: () => ({ activeTabId }),
      liveWebContents: (id: string) => id === 't1' ? tab : undefined
    },
    overlays: { show: (_name: string, _anchor?: unknown, payload?: unknown) => { shows.push({ payload }) }, close: vi.fn() }
  } as unknown as ShellWindow
  const store = new SiteSettingsStore(null)
  const run = vi.fn()
  const close = vi.fn()
  const services = {
    isPrivate: options.isPrivate === true,
    siteSettings: store,
    settings: { get: (key: string) => options.defaults?.[key] ?? 'ask' },
    commands: { run }
  }
  const access = new PageAccess<WebContents>()
  const send = vi.fn()
  const clock = { now: 0 }
  const overlay = { window, services, close, send } as unknown as OverlayWindow
  const handler = createSitePrompt(overlay, access, () => clock.now)
  const ask = createAskSite({ windows: { findTab: (contents) => contents === (tab as unknown) ? { window, tabId: 't1' } : null } })
  const offer = createOfferRestart({ windows: { findTab: (contents) => contents === (tab as unknown) ? { window, tabId: 't1' } : null } })
  const contents = tab as unknown as WebContents
  return { tab, contents, window, store, access, handler, close, send, clock, run, ask, offer, shows, setActive: (id: string | null) => { activeTabId = id } }
}

type Rig = ReturnType<typeof rig>
/** Shows the question, has the page report it drawn and lets the guard pass, as a person who read it would. */
const askView = (r: Rig): Record<string, unknown> => {
  const view = r.handler.show?.(r.shows[0]?.payload) as Record<string, unknown>
  r.handler.request({ type: 'drawn', id: view['id'] })
  r.clock.now += ANSWER_GUARD_MS
  return view
}

describe('the site-prompt overlay', () => {
  it('is a 360px panel under the address pill that a tab switch hides and that does not close on an address rewrite', () => {
    expect(sitePromptOverlay.placement).toEqual({ kind: 'anchor', width: 360, align: 'left' })
    expect(sitePromptOverlay.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: false, layout: false })
    expect(sitePromptOverlay).toMatchObject({ name: 'site-prompt', surface: 'panel', focus: 'take', layer: 'bar', keep: 'fresh' })
  })

  describe('ask', () => {
    it('shows the site, what it wants and the private note, built in main', () => {
      const r = rig({ isPrivate: true })
      void r.ask(['camera', 'microphone'], r.contents)
      expect(askView(r)).toMatchObject({
        mode: 'ask', origin: SITE, lines: [{ kinds: ['camera', 'microphone'], text: 'wants to use your camera and microphone' }], privateNote: 'Forgotten when this private window closes.', locationNote: null
      })
    })

    it('carries the location note for a location question', () => {
      const r = rig()
      void r.ask(['location'], r.contents)
      expect((askView(r)['locationNote'] as string)).toMatch(/no location service yet/)
    })

    it('delivers an answer to the question and closes, and only for the id on screen', async () => {
      const r = rig()
      const answer = r.ask(['camera'], r.contents)
      const view = askView(r)
      expect(r.handler.request({ type: 'answer', id: 'wrong', answer: 'allow' })).toBeUndefined()
      expect(r.close).not.toHaveBeenCalled()
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(await answer).toBe('allow')
      expect(r.close).toHaveBeenCalledTimes(1)
    })

    it('refuses an answer inside the guard, and takes it once the guard has passed', async () => {
      const r = rig()
      const answer = r.ask(['camera'], r.contents)
      const view = r.handler.show?.(r.shows[0]?.payload) as Record<string, unknown>
      expect(view['guardMs']).toBe(ANSWER_GUARD_MS)
      r.handler.request({ type: 'drawn', id: view['id'] })
      r.clock.now += ANSWER_GUARD_MS - 1
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(r.close).not.toHaveBeenCalled()
      r.clock.now += 1
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(await answer).toBe('allow')
    })

    it('refuses an answer within the guard of the last key, and never takes one from a held Enter', async () => {
      const r = rig()
      const answer = r.ask(['camera'], r.contents)
      const view = askView(r)
      r.handler.key?.({ key: 'Tab', isAutoRepeat: false })
      r.clock.now += 100
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(r.close).not.toHaveBeenCalled()
      expect(r.handler.key?.({ key: 'Enter', isAutoRepeat: true })).toBe(true)
      r.clock.now += ANSWER_GUARD_MS - 1
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(r.close).not.toHaveBeenCalled()
      r.clock.now += 1
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(await answer).toBe('allow')
    })

    it('does not start the guard until the page reports the question drawn, however long since the show', () => {
      const r = rig()
      const answer = r.ask(['camera'], r.contents)
      const view = r.handler.show?.(r.shows[0]?.payload) as Record<string, unknown>
      r.clock.now += ANSWER_GUARD_MS * 10
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(r.close).not.toHaveBeenCalled()
      r.handler.request({ type: 'drawn', id: 'wrong' })
      r.handler.request({ type: 'drawn', id: view['id'], extra: 1 })
      r.clock.now += ANSWER_GUARD_MS
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(r.close).not.toHaveBeenCalled()
      r.handler.request({ type: 'drawn', id: view['id'] })
      r.clock.now += ANSWER_GUARD_MS - 1
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(r.close).not.toHaveBeenCalled()
      r.clock.now += 1
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(r.close).toHaveBeenCalledTimes(1)
      void answer
    })

    it('starts the guard over when the overlay is moved, and tells the page', () => {
      const r = rig()
      void r.ask(['camera'], r.contents)
      const view = askView(r)
      r.handler.moved?.()
      expect(r.send).toHaveBeenCalledWith({ type: 'arm' })
      r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })
      expect(r.close).not.toHaveBeenCalled()
    })

    it('answers dismiss when the overlay closes without an answer', async () => {
      const r = rig()
      const answer = r.ask(['camera'], r.contents)
      askView(r)
      r.handler.closed?.('escape')
      expect(await answer).toBe('dismiss')
    })

    it('ignores an answer after the question ended, or a show that names a question it does not hold', async () => {
      const r = rig()
      const answer = r.ask(['camera'], r.contents)
      const view = askView(r)
      r.handler.closed?.('escape')
      await answer
      expect(r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })).toBeUndefined()
      expect(r.handler.show?.({ mode: 'ask', id: 'made-up' })).toBeUndefined()
      expect(r.handler.show?.({ mode: 'ask' })).toBeUndefined()
      expect(r.handler.show?.('allow')).toBeUndefined()
    })

    it('refuses an answer that is not exactly allow or block, and commands of any other shape', () => {
      const r = rig()
      void r.ask(['camera'], r.contents)
      const view = askView(r)
      for (const command of [
        { type: 'answer', id: view['id'], answer: 'dismiss' }, { type: 'answer', id: view['id'] }, { type: 'answer', answer: 'allow' },
        { type: 'answer', id: view['id'], answer: 'allow', extra: 1 }, { type: 'nope' }, 'answer', null, 7
      ]) {
        expect(r.handler.request(command)).toBeUndefined()
      }
      expect(r.close).not.toHaveBeenCalled()
    })

    it('stays open and answerable when the page only rewrites its own address, and ends on a new document', async () => {
      const r = rig()
      const answer = r.ask(['camera'], r.contents)
      const view = askView(r)
      r.tab.emit('did-navigate-in-page')
      expect(r.handler.request({ type: 'answer', id: view['id'], answer: 'allow' })).toBeUndefined()
      await expect(answer).resolves.toBe('allow')
      const second = r.ask(['camera'], r.contents)
      r.tab.emit('did-navigate')
      await expect(second).resolves.toBe('dismiss')
    })

    it('does not let a prompt for another window be answered from this one', () => {
      const r = rig()
      const other = rig()
      void other.ask(['camera'], other.contents)
      expect(r.handler.show?.(other.shows[0]?.payload)).toBeUndefined()
    })
  })

  describe('the WebGPU question', () => {
    it('names the button that grants and, when granting turns the graphics mode on, what a restart costs', () => {
      const r = rig()
      void r.ask(['webgpu'], r.contents, { restart: true })
      expect(askView(r)).toMatchObject({
        mode: 'ask', origin: SITE, lines: [{ kinds: ['webgpu'], text: 'wants to use your graphics card for WebGPU' }], allowLabel: 'Grant WebGPU',
        restartNote: 'Orivon restarts to turn WebGPU on. It may use more battery, and on some laptops videos can go blank.'
      })
      const plain = rig()
      void plain.ask(['webgpu'], plain.contents)
      expect(askView(plain)).toMatchObject({ allowLabel: 'Grant WebGPU', restartNote: null })
    })

    it('keeps the camera question as it was', () => {
      const r = rig()
      void r.ask(['camera'], r.contents)
      expect(askView(r)).toMatchObject({ allowLabel: 'Allow', restartNote: null })
    })
  })

  describe('restart', () => {
    /** Shows the offer, has the page report it drawn and lets the guard pass. */
    function offered (r: Rig, run: () => void = () => {}): Record<string, unknown> {
      r.offer(r.contents, { reopens: 'site', run })
      const view = r.handler.show?.(r.shows[0]?.payload) as Record<string, unknown>
      r.handler.request({ type: 'drawn', id: view['id'] })
      r.clock.now += ANSWER_GUARD_MS
      return view
    }

    it('shows what happens after the restart, built in main, with the guard', () => {
      const r = rig()
      r.offer(r.contents, { reopens: 'site', run: () => {} })
      expect(r.handler.show?.(r.shows[0]?.payload)).toMatchObject({
        mode: 'restart', line: 'WebGPU starts after Orivon restarts.', note: 'Orivon opens this site again. Your other tabs and windows are not restored.', guardMs: ANSWER_GUARD_MS
      })
    })

    it('says the tabs and windows open again when the offer was made on a start that restores them', () => {
      const r = rig()
      r.offer(r.contents, { reopens: 'session', run: () => {} })
      expect(r.handler.show?.(r.shows[0]?.payload)).toMatchObject({ mode: 'restart', note: 'Your tabs and windows open again.' })
    })

    it('says nothing of this site opening again when the offer was made for a tab that carries a tunnel of its own', () => {
      const r = rig()
      r.offer(r.contents, { reopens: 'none', run: () => {} })
      expect(r.handler.show?.(r.shows[0]?.payload)).toMatchObject({ mode: 'restart', note: 'Your tabs and windows are not restored.' })
    })

    it('restarts on the command that names the offer on screen, closing first, and only once', () => {
      const r = rig()
      const order: string[] = []
      r.close.mockImplementation(() => { order.push('close') })
      const view = offered(r, () => { order.push('restart') })
      expect(r.handler.request({ type: 'restart', id: view['id'] })).toBeUndefined()
      expect(order).toEqual(['close', 'restart'])
    })

    it('refuses the command inside the guard, before the page reports the offer drawn, and within the guard of a key', () => {
      const r = rig()
      const run = vi.fn()
      r.offer(r.contents, { reopens: 'site', run })
      const view = r.handler.show?.(r.shows[0]?.payload) as Record<string, unknown>
      r.clock.now += ANSWER_GUARD_MS * 10
      r.handler.request({ type: 'restart', id: view['id'] })
      r.handler.request({ type: 'drawn', id: view['id'] })
      r.clock.now += ANSWER_GUARD_MS - 1
      r.handler.request({ type: 'restart', id: view['id'] })
      r.clock.now += 1
      r.handler.key?.({ key: 'Enter', isAutoRepeat: true })
      r.handler.request({ type: 'restart', id: view['id'] })
      expect(run).not.toHaveBeenCalled()
      r.clock.now += ANSWER_GUARD_MS
      r.handler.request({ type: 'restart', id: view['id'] })
      expect(run).toHaveBeenCalledTimes(1)
    })

    it('starts the guard over when the overlay is moved, and tells the page', () => {
      const r = rig()
      const run = vi.fn()
      const view = offered(r, run)
      r.handler.moved?.()
      expect(r.send).toHaveBeenCalledWith({ type: 'arm' })
      r.handler.request({ type: 'restart', id: view['id'] })
      expect(run).not.toHaveBeenCalled()
    })

    it('refuses an id it is not showing, an answer meant for a question, and commands of any other shape', () => {
      const r = rig()
      const run = vi.fn()
      const view = offered(r, run)
      for (const command of [
        { type: 'restart', id: 'wrong' }, { type: 'restart' }, { type: 'restart', id: view['id'], extra: 1 }, { type: 'restart', id: 7 },
        { type: 'answer', id: view['id'], answer: 'allow' }, { type: 'Restart', id: view['id'] }, 'restart', null
      ]) {
        expect(r.handler.request(command)).toBeUndefined()
      }
      expect(run).not.toHaveBeenCalled()
      expect(r.close).not.toHaveBeenCalled()
    })

    it('does not restart from a question, which holds no restart, nor from an offer that ended', () => {
      const r = rig()
      const run = vi.fn()
      const answer = r.ask(['webgpu'], r.contents, { restart: true })
      const question = askView(r)
      expect(r.handler.request({ type: 'restart', id: question['id'] })).toBeUndefined()
      expect(r.close).not.toHaveBeenCalled()
      void answer
      const other = rig()
      const view = offered(other, run)
      other.handler.closed?.('escape')
      other.handler.request({ type: 'restart', id: view['id'] })
      expect(run).not.toHaveBeenCalled()
    })

    it('does not let an offer for another window be shown from this one, nor one it does not hold', () => {
      const r = rig()
      const other = rig()
      other.offer(other.contents, { reopens: 'site', run: () => {} })
      expect(r.handler.show?.(other.shows[0]?.payload)).toBeUndefined()
      expect(r.handler.show?.({ mode: 'restart', id: 'made-up' })).toBeUndefined()
      expect(r.handler.show?.({ mode: 'restart' })).toBeUndefined()
    })

    it('holds the surface when the chip is pressed, as a question does: a click meant for the chip does not end the offer', () => {
      const r = rig()
      offered(r)
      expect(r.handler.holdsOnToggle?.()).toBe(true)
      r.handler.closed?.('request')
      expect(r.handler.holdsOnToggle?.()).toBe(false)
    })

    it('does not hold the surface for the review bubble, which a press on the chip closes', () => {
      const r = rig()
      r.access.note(r.contents, SITE, 'camera', 'allowed')
      r.handler.show?.({ mode: 'review' })
      expect(r.handler.holdsOnToggle?.()).toBe(false)
    })

    it('is forgotten when it is closed, which is Later', () => {
      const r = rig()
      const run = vi.fn()
      const view = offered(r, run)
      r.handler.closed?.('request')
      expect(r.handler.request({ type: 'restart', id: view['id'] })).toBeUndefined()
      expect(run).not.toHaveBeenCalled()
    })
  })

  describe('review', () => {
    function reviewRig (options: Parameters<typeof rig>[0] = {}): Rig {
      const r = rig(options)
      r.access.note(r.contents, SITE, 'camera', 'blocked')
      r.access.note(r.contents, SITE, 'location', 'allowed')
      return r
    }
    const review = (r: Rig): Record<string, unknown> | undefined => r.handler.show?.({ mode: 'review' }) as Record<string, unknown> | undefined

    it('lists one row per kind this page was asked about, with what is in force', () => {
      const r = reviewRig({ defaults: { 'sites.camera': 'block' } })
      r.store.set(SITE, 'location', 'allow')
      expect(review(r)).toMatchObject({
        mode: 'review', origin: SITE, settingsLink: commandById('siteSettings.open')?.pending !== true,
        rows: [
          { kind: 'camera', label: 'Camera', value: 'block', askOffered: false, allowOffered: true },
          { kind: 'location', label: 'Location', value: 'allow', askOffered: true, allowOffered: true }
        ]
      })
    })

    it('shows nothing when the page was not asked about anything, or the tab is not the one in front', () => {
      expect(review(rig())).toBeUndefined()
      const r = reviewRig()
      r.setActive('t2')
      expect(review(r)).toBeUndefined()
      r.setActive(null)
      expect(review(r)).toBeUndefined()
    })

    it('shows nothing once the tab is on another site than the record describes', () => {
      const r = reviewRig()
      r.tab.url = 'https://elsewhere.example/'
      expect(review(r)).toBeUndefined()
    })

    it('stores Allow and Block for the page\'s own site and marks the page', () => {
      const r = reviewRig()
      review(r)
      expect(r.handler.request({ type: 'set', kind: 'camera', value: 'allow' })).toEqual({ kind: 'camera', value: 'allow' })
      expect(r.store.get(SITE, 'camera')).toBe('allow')
      expect(r.access.entries(r.contents).find((entry) => entry.kind === 'camera')?.state).toBe('allowed')
      r.handler.request({ type: 'set', kind: 'location', value: 'block' })
      expect(r.store.get(SITE, 'location')).toBe('block')
    })

    it('offers no Allow for screen sharing and stores nothing when one is sent', () => {
      const r = reviewRig()
      r.access.note(r.contents, SITE, 'screenShare', 'blocked')
      const rows = (review(r)?.['rows'] ?? []) as Array<Record<string, unknown>>
      expect(rows.find((row) => row['kind'] === 'screenShare')).toMatchObject({ allowOffered: false })
      expect(r.handler.request({ type: 'set', kind: 'screenShare', value: 'allow' })).toBeUndefined()
      expect(r.store.get(SITE, 'screenShare')).toBeUndefined()
      expect(r.handler.request({ type: 'set', kind: 'screenShare', value: 'block' })).toEqual({ kind: 'screenShare', value: 'block' })
      expect(r.store.get(SITE, 'screenShare')).toBe('block')
    })

    it('forgets the answer for Ask', () => {
      const r = reviewRig()
      r.store.set(SITE, 'camera', 'block')
      review(r)
      expect(r.handler.request({ type: 'set', kind: 'camera', value: 'ask' })).toEqual({ kind: 'camera', value: 'ask' })
      expect(r.store.get(SITE, 'camera')).toBeUndefined()
    })

    it('changes nothing for a kind the page was not asked about, or an unknown one, or a foreign value', () => {
      const r = reviewRig()
      review(r)
      for (const command of [
        { type: 'set', kind: 'microphone', value: 'allow' }, { type: 'set', kind: 'bogus', value: 'allow' },
        { type: 'set', kind: 'camera', value: 'maybe' }, { type: 'set', kind: 'camera' }, { type: 'set', value: 'allow' },
        { type: 'set', kind: 'camera', value: 'allow', origin: 'https://evil.example' }
      ]) {
        expect(r.handler.request(command)).toBeUndefined()
      }
      expect(r.store.entries()).toEqual([])
    })

    it('never takes the site from the page: a set after the tab moved on changes nothing', () => {
      const r = reviewRig()
      review(r)
      r.tab.url = 'https://elsewhere.example/'
      expect(r.handler.request({ type: 'set', kind: 'camera', value: 'allow' })).toBeUndefined()
      expect(r.store.entries()).toEqual([])
      expect(r.close).toHaveBeenCalled()
    })

    it('changes nothing from a set when it was never shown in review, or after the tab switched', () => {
      const r = reviewRig()
      expect(r.handler.request({ type: 'set', kind: 'camera', value: 'allow' })).toBeUndefined()
      review(r)
      r.setActive('t2')
      expect(r.handler.request({ type: 'set', kind: 'camera', value: 'allow' })).toBeUndefined()
      expect(r.store.entries()).toEqual([])
    })

    it('reloads the page and closes', () => {
      const r = reviewRig()
      review(r)
      r.handler.request({ type: 'reload' })
      expect(r.tab.reload).toHaveBeenCalledTimes(1)
      expect(r.close).toHaveBeenCalledTimes(1)
    })

    it('closes on a new document in the tab, and not on an in-page address change', () => {
      const r = reviewRig()
      review(r)
      r.tab.emit('did-navigate-in-page')
      expect(r.close).not.toHaveBeenCalled()
      r.tab.emit('did-navigate')
      expect(r.close).toHaveBeenCalledTimes(1)
      r.handler.closed?.('navigation')
      r.tab.emit('did-navigate')
      expect(r.close).toHaveBeenCalledTimes(1)
    })

    it('opens Site settings only once that command exists', () => {
      const r = reviewRig()
      review(r)
      r.handler.request({ type: 'settings' })
      if (commandById('siteSettings.open')?.pending === true) {
        expect(r.run).not.toHaveBeenCalled()
      } else {
        expect(r.run).toHaveBeenCalledWith('siteSettings.open', r.window)
      }
    })

    it('does not answer a question from the review, and a close in review settles nothing', () => {
      const r = reviewRig()
      review(r)
      expect(r.handler.request({ type: 'answer', id: 'x', answer: 'allow' })).toBeUndefined()
      expect(() => { r.handler.closed?.('blur') }).not.toThrow()
    })
  })
})
