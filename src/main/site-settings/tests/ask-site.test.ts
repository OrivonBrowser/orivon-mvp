import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ShellWindow } from '../../shell/window-registry.js'
import { createAskSite, createOfferRestart, pendingAsk, pendingRestart, restartOfferOpen, SITE_PROMPT_OVERLAY, askSite, bindAskSite } from '../ask-site.js'
import { slotClosed, tabSlotEvents } from '../../overlays/tab-slots.js'
import { crossingAnchor, promptAnchor, promptAnchorReport, TOOLBAR_OVERLAP } from '../../shell/actions/prompt-anchor.js'

class FakeTab extends EventEmitter {
  constructor (public url = 'https://meet.example/room') { super() }
  getURL (): string { return this.url }
}

function rig (active = 't1') {
  let activeTabId = active
  const shows: Array<{ overlay: string, anchor: unknown, payload: unknown }> = []
  const closes: string[] = []
  const window = {
    tabs: { getState: () => ({ activeTabId }) },
    overlays: {
      show: (overlay: string, anchor?: unknown, payload?: unknown) => { shows.push({ overlay, anchor, payload }) },
      close: (overlay?: string) => { if (overlay !== undefined) closes.push(overlay) }
    }
  } as unknown as ShellWindow
  const tab = new FakeTab()
  const ask = createAskSite({ windows: { findTab: (contents) => contents === (tab as unknown) ? { window, tabId: 't1' } : null } })
  return { window, shows, closes, tab, contents: tab as unknown as WebContents, ask, activate: (id: string) => { activeTabId = id } }
}

const idOf = (shows: Array<{ payload: unknown }>): string => (shows[0]?.payload as { id: string }).id

describe('askSite', () => {
  it('asks under the address bar of the tab it came from, holding the question by a random id', async () => {
    const { ask, shows, contents } = rig()
    const answer = ask(['camera', 'microphone'], contents, { sysex: false })
    expect(shows).toHaveLength(1)
    expect(shows[0]?.overlay).toBe(SITE_PROMPT_OVERLAY)
    const payload = shows[0]?.payload as { mode: string, id: string }
    expect(payload.mode).toBe('ask')
    expect(payload.id).toMatch(/^[0-9a-f]{24}$/)
    const held = pendingAsk(payload.id)
    expect(held).toMatchObject({ origin: 'https://meet.example', kinds: ['camera', 'microphone'], sysex: false })
    held?.settle('allow')
    expect(await answer).toBe('allow')
    expect(pendingAsk(payload.id)).toBeUndefined()
  })

  it('holds whether granting also turns a setting on, for the question to say so', () => {
    const { ask, shows, contents } = rig()
    void ask(['webgpu'], contents, { restart: true })
    expect(pendingAsk(idOf(shows))).toMatchObject({ kinds: ['webgpu'], sysex: false, restart: true })
    const plain = rig()
    void plain.ask(['webgpu'], plain.contents)
    expect(pendingAsk(idOf(plain.shows))).toMatchObject({ restart: false })
  })

  it('opens across the toolbar line, its top edge inside the address pill, not below it', () => {
    const { ask, shows, window, contents } = rig()
    const pill = { x: 120, y: 40, width: 600, height: 32 }
    promptAnchorReport(pill, { window } as never)
    void ask(['camera'], contents)
    expect(shows[0]?.anchor).toEqual(crossingAnchor(window))
    expect(shows[0]?.anchor).not.toEqual(promptAnchor(window))
    // overlayBounds puts the panel GAP under the anchor's bottom, so the anchor ends TOOLBAR_OVERLAP + GAP above the pill's bottom.
    const anchor = shows[0]?.anchor as { y: number, height: number }
    expect(pill.y + pill.height - (anchor.y + anchor.height)).toBeGreaterThanOrEqual(TOOLBAR_OVERLAP)
  })

  it('answers dismiss for every way out but an answer', async () => {
    const closed = rig()
    const one = closed.ask(['camera'], closed.contents)
    slotClosed(closed.window, SITE_PROMPT_OVERLAY, 'escape')
    expect(await one).toBe('dismiss')
  })

  it('answers dismiss when the tab loads another page, shown or not, and never shows it after', async () => {
    const { ask, tab, contents, shows, closes } = rig()
    const answer = ask(['location'], contents)
    tab.emit('did-navigate')
    expect(await answer).toBe('dismiss')
    expect(closes).toEqual([SITE_PROMPT_OVERLAY])
    expect(pendingAsk(idOf(shows))).toBeUndefined()
    expect(tab.listenerCount('did-navigate')).toBe(0)
  })

  it('answers dismiss when the tab closes', async () => {
    const { ask, window, contents } = rig()
    const answer = ask(['camera'], contents)
    tabSlotEvents.tabClosed(window, 't1')
    expect(await answer).toBe('dismiss')
  })

  it('queues three more questions for a tab and refuses the rest', async () => {
    const { ask, contents, shows } = rig()
    const answers = Array.from({ length: 6 }, (_, index) => ask(['camera'], contents, { sysex: index === 0 }))
    expect(shows).toHaveLength(1)
    expect(await answers[5]).toBe('dismiss')
    expect(await Promise.race([answers[4], Promise.resolve('waiting')])).toBe('dismiss')
  })

  it('does not show a question for a tab that is in the background until it comes to the front', async () => {
    const { ask, contents, shows, activate, window } = rig('other')
    const answer = ask(['camera'], contents)
    expect(shows).toEqual([])
    activate('t1')
    tabSlotEvents.tabActivated(window, 't1')
    await Promise.resolve()
    expect(shows).toHaveLength(1)
    pendingAsk(idOf(shows))?.settle('block')
    expect(await answer).toBe('block')
  })

  it('answers dismiss for contents no window owns, or with no origin', async () => {
    const { ask } = rig()
    expect(await ask(['camera'], new FakeTab() as unknown as WebContents)).toBe('dismiss')
    const blank = rig()
    blank.tab.url = 'about:blank'
    expect(await blank.ask(['camera'], blank.contents)).toBe('dismiss')
  })

  it('does not know an id it never issued', () => {
    expect(pendingAsk('nope')).toBeUndefined()
    expect(pendingAsk(7)).toBeUndefined()
    expect(pendingAsk({})).toBeUndefined()
  })

  it('dismisses until an ask is bound', async () => {
    bindAskSite(undefined)
    expect(await askSite(['camera'], new FakeTab() as unknown as WebContents)).toBe('dismiss')
  })
})

describe('offering a restart', () => {
  function offerRig (active = 't1') {
    const base = rig(active)
    const offer = createOfferRestart({ windows: { findTab: (contents) => contents === (base.tab as unknown) ? { window: base.window, tabId: 't1' } : null } })
    return { ...base, offer }
  }

  it('shows the offer under the address bar, holding the way to restart by a random id', () => {
    const { offer, shows, contents, window } = offerRig()
    const run = vi.fn()
    offer(contents, { reopens: 'site', run })
    expect(shows).toHaveLength(1)
    expect(shows[0]?.overlay).toBe(SITE_PROMPT_OVERLAY)
    const payload = shows[0]?.payload as { mode: string, id: string }
    expect(payload.mode).toBe('restart')
    expect(payload.id).toMatch(/^[0-9a-f]{24}$/)
    const held = pendingRestart(payload.id)
    expect(held?.window).toBe(window)
    expect(held?.reopens).toBe('site')
    held?.run()
    expect(run).toHaveBeenCalledTimes(1)
    // It is not a question: nothing is held under that id as one.
    expect(pendingAsk(payload.id)).toBeUndefined()
  })

  it.each(['session', 'site', 'none'] as const)('holds what the start brings back (%s), for the view and the restart to agree', (reopens) => {
    const { offer, shows, contents } = offerRig()
    offer(contents, { reopens, run: () => {} })
    expect(pendingRestart((shows[0]?.payload as { id: string }).id)?.reopens).toBe(reopens)
  })

  /** The tab loads a page: the address changes, then the event that says so. */
  const navigate = (tab: FakeTab, url: string): void => {
    tab.url = url
    tab.emit('did-navigate')
  }

  it('stays up through the pages of its own site, which a game may move to when it finds no WebGPU, and can still restart', () => {
    const { offer, tab, shows, contents, closes } = offerRig()
    const run = vi.fn()
    offer(contents, { reopens: 'site', run })
    const id = (shows[0]?.payload as { id: string }).id
    navigate(tab, 'https://meet.example/webgpu-unsupported')
    navigate(tab, 'https://meet.example/room?again=1#top')
    expect(pendingRestart(id)).toBeDefined()
    expect(tab.listenerCount('did-navigate')).toBe(1)
    expect(closes).toEqual([])
    pendingRestart(id)?.run()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['another site', 'https://other.example/'],
    ['the same host on another port', 'https://meet.example:8443/room'],
    ['the same host over http', 'http://meet.example/room'],
    ['a page with no web origin', 'about:blank']
  ])('ends when the tab goes to %s, and is gone for good', (_label, url) => {
    const { offer, tab, shows, contents, closes } = offerRig()
    offer(contents, { reopens: 'site', run: () => {} })
    const id = (shows[0]?.payload as { id: string }).id
    navigate(tab, url)
    expect(pendingRestart(id)).toBeUndefined()
    expect(tab.listenerCount('did-navigate')).toBe(0)
    expect(closes).toEqual([SITE_PROMPT_OVERLAY])
    navigate(tab, 'https://meet.example/room')
    expect(pendingRestart(id)).toBeUndefined()
  })

  it('is forgotten when its surface closes, and when its tab closes', () => {
    const first = offerRig()
    first.offer(first.contents, { reopens: 'site', run: () => {} })
    const firstId = (first.shows[0]?.payload as { id: string }).id
    slotClosed(first.window, SITE_PROMPT_OVERLAY, 'escape')
    expect(pendingRestart(firstId)).toBeUndefined()
    expect(first.tab.listenerCount('did-navigate')).toBe(0)
    const second = offerRig()
    second.offer(second.contents, { reopens: 'site', run: () => {} })
    const secondId = (second.shows[0]?.payload as { id: string }).id
    tabSlotEvents.tabClosed(second.window, 't1')
    expect(pendingRestart(secondId)).toBeUndefined()
    expect(second.tab.listenerCount('did-navigate')).toBe(0)
  })

  it('holds at most one offer per tab: a second is not made while the first is up, and one can be made after it ended', () => {
    const { offer, tab, shows, contents, window } = offerRig()
    expect(restartOfferOpen(contents)).toBe(false)
    const first = vi.fn()
    offer(contents, { reopens: 'site', run: first })
    expect(restartOfferOpen(contents)).toBe(true)
    const second = vi.fn()
    offer(contents, { reopens: 'session', run: second })
    expect(shows).toHaveLength(1)
    expect(tab.listenerCount('did-navigate')).toBe(1)
    const id = (shows[0]?.payload as { id: string }).id
    pendingRestart(id)?.run()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    slotClosed(window, SITE_PROMPT_OVERLAY, 'request')
    expect(restartOfferOpen(contents)).toBe(false)
    offer(contents, { reopens: 'site', run: second })
    expect(shows).toHaveLength(2)
    expect(restartOfferOpen(contents)).toBe(true)
  })

  it('does not count an offer for another tab, and is open for no contents it never held', () => {
    const one = offerRig()
    const other = offerRig()
    one.offer(one.contents, { reopens: 'site', run: () => {} })
    expect(restartOfferOpen(other.contents)).toBe(false)
    expect(restartOfferOpen(new FakeTab() as unknown as WebContents)).toBe(false)
  })

  it('offers nothing for a tab that shows no web origin', () => {
    const { offer, tab, shows, contents } = offerRig()
    tab.url = 'about:blank'
    offer(contents, { reopens: 'site', run: () => {} })
    expect(shows).toEqual([])
    expect(restartOfferOpen(contents)).toBe(false)
  })

  it('offers nothing for contents no window owns, and knows no id it never issued', () => {
    const { offer, shows } = offerRig()
    offer(new FakeTab() as unknown as WebContents, { reopens: 'site', run: () => {} })
    expect(shows).toEqual([])
    expect(pendingRestart('nope')).toBeUndefined()
    expect(pendingRestart(7)).toBeUndefined()
  })
})
