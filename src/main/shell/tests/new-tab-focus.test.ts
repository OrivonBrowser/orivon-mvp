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

function harness (input: Partial<NewTabFocusInput> = {}): { contents: EventEmitter & { isDestroyed: () => boolean }, focusAddressBar: ReturnType<typeof vi.fn>, state: NewTabFocusInput, destroyed: { value: boolean } } {
  const destroyed = { value: false }
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed.value })
  const focusAddressBar = vi.fn()
  const state = { ...wanted, ...input }
  watchNewTab(contents as never, { input: () => state, focusAddressBar })
  return { contents, focusAddressBar, state, destroyed }
}

const turn = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve) })

describe('watchNewTab', () => {
  it('focuses the bar at creation for a tab in front in a focused window', () => {
    const { focusAddressBar } = harness()
    expect(focusAddressBar).toHaveBeenCalledTimes(1)
  })

  it('does not focus the bar for a tab that is not wanted there, now or when its page loads', async () => {
    for (const input of [{ active: false }, { windowFocused: false }, { coveredByIntro: true }, { freshNewTab: false }]) {
      const { contents, focusAddressBar } = harness(input)
      contents.emit('focus')
      contents.emit('did-finish-load')
      await turn()
      expect(focusAddressBar).not.toHaveBeenCalled()
    }
  })

  it('takes the bar back once, a turn after the page takes the keyboard', async () => {
    const { contents, focusAddressBar } = harness()
    focusAddressBar.mockClear()
    contents.emit('focus')
    expect(focusAddressBar).not.toHaveBeenCalled()
    await turn()
    expect(focusAddressBar).toHaveBeenCalledTimes(1)
  })

  it('takes the bar back at the end of the load when the page never took the keyboard', async () => {
    const { contents, focusAddressBar } = harness()
    focusAddressBar.mockClear()
    contents.emit('did-finish-load')
    await turn()
    expect(focusAddressBar).toHaveBeenCalledTimes(1)
  })

  it('is silent after the first of the two events', async () => {
    const { contents, focusAddressBar } = harness()
    focusAddressBar.mockClear()
    contents.emit('focus')
    await turn()
    contents.emit('did-finish-load')
    contents.emit('focus')
    await turn()
    expect(focusAddressBar).toHaveBeenCalledTimes(1)
  })

  it('leaves the keyboard where it is once the person has moved on', async () => {
    const { contents, focusAddressBar, state } = harness()
    focusAddressBar.mockClear()
    contents.emit('focus')
    state.freshNewTab = false
    await turn()
    expect(focusAddressBar).not.toHaveBeenCalled()
  })

  it('does nothing for a page that is gone', async () => {
    const { contents, focusAddressBar, destroyed } = harness()
    focusAddressBar.mockClear()
    contents.emit('focus')
    destroyed.value = true
    await turn()
    expect(focusAddressBar).not.toHaveBeenCalled()
  })
})
