import { describe, expect, it, vi } from 'vitest'
import type { ChromeContext } from '../chrome/context.js'
import { createChromeShown } from '../chrome/chrome-shown.js'
import { CHROME_MODULES } from '../chrome/modules.js'

function setup (initial: 'visible' | 'hidden'): { act: ReturnType<typeof vi.fn>, change: (to: 'visible' | 'hidden') => void } {
  let state = initial
  const listeners: Array<() => void> = []
  const doc = { get visibilityState () { return state }, addEventListener: (_type: string, listener: () => void) => { listeners.push(listener) } }
  const act = vi.fn()
  createChromeShown(doc as never).init({ shell: { act } } as unknown as ChromeContext)
  return { act, change: (to) => { state = to; for (const listener of listeners) listener() } }
}

describe('the chrome-shown module', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('chrome-shown')
  })

  it('says nothing while the page is visible', () => {
    const { act, change } = setup('visible')
    change('visible')
    expect(act).not.toHaveBeenCalled()
  })

  it('tells main each time the page turns hidden', () => {
    const { act, change } = setup('visible')
    change('hidden')
    change('visible')
    change('hidden')
    expect(act.mock.calls).toEqual([['chrome.hidden'], ['chrome.hidden']])
  })

  it('tells main at start when the page is already hidden', () => {
    expect(setup('hidden').act).toHaveBeenCalledExactlyOnceWith('chrome.hidden')
  })
})
