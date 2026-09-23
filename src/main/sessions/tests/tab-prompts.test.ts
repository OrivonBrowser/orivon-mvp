import { describe, expect, it } from 'vitest'
import { tabPromptState } from '../tab-prompts.js'
import { fakeTab } from './fake-tab.js'

describe('tabPromptState', () => {
  it('starts with no prompt open, touched, and nothing dismissed', () => {
    expect(tabPromptState(fakeTab())).toEqual({ prompting: false, touched: true, notificationsDismissed: false })
  })

  it('is one state per tab, however often it is asked for', () => {
    const tab = fakeTab()
    const state = tabPromptState(tab)
    state.touched = false
    expect(tabPromptState(tab)).toBe(state)
    expect(tabPromptState(fakeTab())).not.toBe(state)
  })

  it('counts a click, a tap or a key press as the person touching the page, and nothing that merely passes over it', () => {
    const tab = fakeTab()
    const state = tabPromptState(tab)
    for (const passive of ['mouseMove', 'mouseEnter', 'mouseWheel', 'keyUp', 'mouseUp', 'gestureScrollUpdate']) {
      state.touched = false
      tab.touch(passive)
      expect(state.touched, passive).toBe(false)
    }
    for (const active of ['mouseDown', 'pointerDown', 'touchStart', 'rawKeyDown', 'keyDown']) {
      state.touched = false
      tab.touch(active)
      expect(state.touched, active).toBe(true)
    }
  })

  it('forgets a dismissed notification question when the page loads again', () => {
    const tab = fakeTab()
    const state = tabPromptState(tab)
    state.notificationsDismissed = true
    tab.navigate()
    expect(state.notificationsDismissed).toBe(false)
  })
})
