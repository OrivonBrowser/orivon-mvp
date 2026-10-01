import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import type { ShellWindow } from '../../shell/window-registry.js'
import { createAskSite, pendingAsk, SITE_PROMPT_OVERLAY, askSite, bindAskSite } from '../ask-site.js'
import { slotClosed, tabSlotEvents } from '../../overlays/tab-slots.js'

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
