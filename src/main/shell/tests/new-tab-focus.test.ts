import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { watchNewTab, wantsAddressBar } from '../new-tab-focus.js'
import type { NewTabFocusInput } from '../new-tab-focus.js'

const wanted: NewTabFocusInput = { active: true, freshNewTab: true, windowFocused: true, coveredByIntro: false }

describe('wantsAddressBar', () => {
  it('wants the bar for a fresh new tab in front of a focused window', () => {
    expect(wantsAddressBar(wanted)).toBe(true)
  })

  it('does not want it for a background tab, a tab that navigated, an unfocused window or an open welcome screen', () => {
    expect(wantsAddressBar({ ...wanted, active: false })).toBe(false)
    expect(wantsAddressBar({ ...wanted, freshNewTab: false })).toBe(false)
    expect(wantsAddressBar({ ...wanted, windowFocused: false })).toBe(false)
    expect(wantsAddressBar({ ...wanted, coveredByIntro: true })).toBe(false)
  })
})

function harness (input: Partial<NewTabFocusInput> = {}): { contents: EventEmitter & { isDestroyed: () => boolean }, focusAddressBar: ReturnType<typeof vi.fn>, returnKeyboard: ReturnType<typeof vi.fn>, placed: ReturnType<typeof vi.fn>, state: NewTabFocusInput, destroyed: { value: boolean } } {
  const destroyed = { value: false }
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed.value })
  const focusAddressBar = vi.fn()
  const returnKeyboard = vi.fn()
  const placed = vi.fn()
  const state = { ...wanted, ...input }
  watchNewTab(contents as never, { input: () => state, focusAddressBar, returnKeyboard, placed })
  return { contents, focusAddressBar, returnKeyboard, placed, state, destroyed }
}

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

describe('watchNewTab', () => {
  it('focuses the bar at creation for a tab in front in a focused window', () => {
    const { focusAddressBar } = harness()
    expect(focusAddressBar).toHaveBeenCalledTimes(1)
  })

  it('does not touch the keyboard for a tab that is not wanted there, now or when its page loads', async () => {
    for (const input of [{ active: false }, { windowFocused: false }, { coveredByIntro: true }, { freshNewTab: false }]) {
      const { contents, focusAddressBar, returnKeyboard } = harness(input)
      contents.emit('focus')
      contents.emit('did-finish-load')
      await turn()
      expect(focusAddressBar).not.toHaveBeenCalled()
      expect(returnKeyboard).not.toHaveBeenCalled()
    }
  })

  it('returns the keyboard to the chrome once, a turn after the page takes it, without selecting the bar again', async () => {
    const { contents, focusAddressBar, returnKeyboard } = harness()
    focusAddressBar.mockClear()
    contents.emit('focus')
    expect(returnKeyboard).not.toHaveBeenCalled()
    await turn()
    expect(returnKeyboard).toHaveBeenCalledTimes(1)
    expect(focusAddressBar).not.toHaveBeenCalled()
  })

  it('returns it at the end of the load when the page never took the keyboard', async () => {
    const { contents, focusAddressBar, returnKeyboard } = harness()
    focusAddressBar.mockClear()
    contents.emit('did-finish-load')
    await turn()
    expect(returnKeyboard).toHaveBeenCalledTimes(1)
    expect(focusAddressBar).not.toHaveBeenCalled()
  })

  it('is silent after the first of the two events', async () => {
    const { contents, returnKeyboard } = harness()
    contents.emit('focus')
    await turn()
    contents.emit('did-finish-load')
    contents.emit('focus')
    await turn()
    expect(returnKeyboard).toHaveBeenCalledTimes(1)
  })

  it('leaves the keyboard where it is once the person has moved on', async () => {
    const { contents, returnKeyboard, state } = harness()
    contents.emit('focus')
    state.freshNewTab = false
    await turn()
    expect(returnKeyboard).not.toHaveBeenCalled()
  })

  it('does nothing for a page that is gone', async () => {
    const { contents, returnKeyboard, destroyed } = harness()
    contents.emit('focus')
    destroyed.value = true
    await turn()
    expect(returnKeyboard).not.toHaveBeenCalled()
  })
})

describe('watchNewTab: when the keyboard is placed', () => {
  it('says so once, after the keyboard has gone back to the chrome, and not before the page has taken it', async () => {
    const { contents, returnKeyboard, placed } = harness()
    await turn()
    expect(placed).not.toHaveBeenCalled()
    contents.emit('focus')
    expect(placed).not.toHaveBeenCalled()
    await turn()
    expect(returnKeyboard).toHaveBeenCalledTimes(1)
    expect(placed).toHaveBeenCalledTimes(1)
    expect(returnKeyboard.mock.invocationCallOrder[0]).toBeLessThan(placed.mock.invocationCallOrder[0] as number)
    contents.emit('did-finish-load')
    contents.emit('did-fail-load')
    contents.emit('destroyed')
    await turn()
    expect(placed).toHaveBeenCalledTimes(1)
  })

  it('says so at the end of the load when the page never took the keyboard, and when the load failed', async () => {
    for (const event of ['did-finish-load', 'did-fail-load']) {
      const { contents, placed } = harness()
      contents.emit(event)
      await turn()
      expect(placed, event).toHaveBeenCalledTimes(1)
    }
  })

  it('says so for a tab the keyboard is not wanted in, which the page can still take it from', async () => {
    for (const input of [{ active: false }, { windowFocused: false }, { coveredByIntro: true }, { freshNewTab: false }]) {
      const { contents, placed, returnKeyboard } = harness(input)
      contents.emit('focus')
      await turn()
      expect(returnKeyboard).not.toHaveBeenCalled()
      expect(placed).toHaveBeenCalledTimes(1)
    }
  })

  it('says so when the page is destroyed before it did either, and for a page that is gone when the turn comes', async () => {
    const gone = harness()
    gone.contents.emit('destroyed')
    expect(gone.placed).toHaveBeenCalledTimes(1)
    const later = harness()
    later.contents.emit('focus')
    later.destroyed.value = true
    await turn()
    expect(later.returnKeyboard).not.toHaveBeenCalled()
    expect(later.placed).toHaveBeenCalledTimes(1)
  })
})
