import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createContentRules } from '../content-rules.js'
import { createPopupBlocker } from '../popup-blocker.js'
import { POPUP_INPUT_WINDOW_MS } from '../popup-policy.js'
import { PopupBlocks } from '../popup-blocks.js'
import { SiteSettingsStore } from '../site-settings-store.js'
import { TabInteraction } from '../tab-interaction.js'

class FakeTab extends EventEmitter {
  input (type = 'mouseDown'): void { this.emit('input-event', {}, { type }) }
}

const PAGE = 'https://shop.example/cart'

function rig (options: { apps?: string[], popupsDefault?: 'allow' | 'block' } = {}) {
  let now = 10_000
  const store = new SiteSettingsStore(null)
  const rules = createContentRules({
    store,
    defaultFor: (kind) => kind === 'popups' ? options.popupsDefault ?? 'block' : 'allow',
    isApp: (origin) => options.apps?.includes(origin) === true
  })
  const interaction = new TabInteraction<FakeTab>(() => now)
  const blocks = new PopupBlocks<FakeTab>()
  const blocker = createPopupBlocker({ rules, interaction, blocks, clock: () => now })
  const tab = new FakeTab()
  blocker.watch(tab)
  return { store, blocker, blocks, tab, advance: (ms: number) => { now += ms } }
}

describe('the pop-up blocker', () => {
  it('blocks and lists a window a page opens with no input from the person', () => {
    const { blocker, blocks, tab } = rig()
    expect(blocker.check(tab, PAGE, 'https://ads.example/')).toBe(true)
    expect(blocks.list(tab)).toEqual(['https://ads.example/'])
  })

  it('lets through a window opened right after a real click or key press, and lists nothing', () => {
    const { blocker, blocks, tab } = rig()
    tab.input('mouseDown')
    expect(blocker.check(tab, PAGE, 'https://pay.example/')).toBe(false)
    expect(blocks.count(tab)).toBe(0)
  })

  it('lets one window through per input and blocks the rest', () => {
    const { blocker, blocks, tab } = rig()
    tab.input('keyDown')
    const verdicts = [1, 2, 3, 4, 5].map((n) => blocker.check(tab, PAGE, `https://w${String(n)}.example/`))
    expect(verdicts).toEqual([false, true, true, true, true])
    expect(blocks.count(tab)).toBe(4)
  })

  it('blocks a window opened long after the input', () => {
    const { blocker, tab, advance } = rig()
    tab.input('mouseDown')
    advance(POPUP_INPUT_WINDOW_MS + 1)
    expect(blocker.check(tab, PAGE, 'https://late.example/')).toBe(true)
  })

  it('never lets an input made in another tab open a window here', () => {
    const { blocker } = rig()
    const quiet = new FakeTab()
    const other = new FakeTab()
    blocker.watch(other)
    other.input('mouseDown')
    expect(blocker.check(quiet, PAGE, 'https://x.example/')).toBe(true)
  })

  it('lets a site the person allowed open windows at will, and blocks others', () => {
    const { blocker, store, tab } = rig()
    store.set('https://shop.example', 'popups', 'allow')
    expect(blocker.check(tab, PAGE, 'https://a.example/')).toBe(false)
    expect(blocker.check(tab, 'https://other.example/', 'https://a.example/')).toBe(true)
  })

  it('lets everything through when the default allows pop-ups, unless the site was set to block', () => {
    const { blocker, store, tab } = rig({ popupsDefault: 'allow' })
    expect(blocker.check(tab, PAGE, 'https://a.example/')).toBe(false)
    store.set('https://shop.example', 'popups', 'block')
    expect(blocker.check(tab, PAGE, 'https://a.example/')).toBe(true)
  })

  it('leaves a registered app and every page that is not a website alone', () => {
    const { blocker, blocks, tab } = rig({ apps: ['https://app.example'] })
    expect(blocker.check(tab, 'https://app.example/', 'https://a.example/')).toBe(false)
    for (const opener of ['orivon://settings/', 'chrome-extension://abc/p.html', 'file:///a.html', 'about:blank']) {
      expect(blocker.check(tab, opener, 'https://a.example/')).toBe(false)
    }
    expect(blocks.count(tab)).toBe(0)
  })

  it('starts watching a tab it was not told of, so the first open is judged and the next input counts', () => {
    const { blocker, tab } = rig()
    const late = new FakeTab()
    expect(blocker.check(late, PAGE, 'https://a.example/')).toBe(true)
    late.input('mouseDown')
    expect(blocker.check(late, PAGE, 'https://a.example/')).toBe(false)
    expect(tab.listenerCount('input-event')).toBe(1)
  })
})
