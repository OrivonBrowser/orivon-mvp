import { describe, expect, it, vi } from 'vitest'
import { homeOpen } from '../actions/home-open.js'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { WindowContext } from '../window-context.js'

function context (homeUrl: string): { ctx: WindowContext, navigate: ReturnType<typeof vi.fn>, createTab: ReturnType<typeof vi.fn> } {
  const navigate = vi.fn()
  const createTab = vi.fn()
  const tabs = { getState: () => ({ tabs: [{ id: 'a', isNewTab: false }], activeTabId: 'a' }), navigate, createTab }
  const settings = { get: () => homeUrl }
  return { ctx: { window: { tabs }, services: { settings } } as unknown as WindowContext, navigate, createTab }
}

describe('the home.open chrome action', () => {
  it('is registered', () => {
    expect(CHROME_ACTIONS['home.open']).toBe(homeOpen)
  })

  it('loads the home page here for a click and in a new tab for a middle click', () => {
    const { ctx, navigate, createTab } = context('example.com')
    runChromeAction('home.open', { newTab: false }, ctx)
    expect(navigate).toHaveBeenCalledWith('a', 'https://example.com/')
    runChromeAction('home.open', { newTab: true }, ctx)
    expect(createTab).toHaveBeenCalledWith('https://example.com/', false)
  })

  it('ignores a payload that is not exactly one boolean', () => {
    const { ctx, navigate, createTab } = context('example.com')
    for (const payload of [undefined, null, {}, { newTab: 'yes' }, { newTab: 1 }, 'true', 7]) runChromeAction('home.open', payload, ctx)
    expect(navigate).not.toHaveBeenCalled()
    expect(createTab).not.toHaveBeenCalled()
  })
})
