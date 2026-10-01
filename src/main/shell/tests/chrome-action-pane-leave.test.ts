import { describe, expect, it, vi } from 'vitest'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { WindowContext } from '../window-context.js'

function context (): { ctx: WindowContext, pageFocus: ReturnType<typeof vi.fn>, chromeFocus: ReturnType<typeof vi.fn> } {
  const pageFocus = vi.fn()
  const chromeFocus = vi.fn()
  const window = { chrome: { webContents: { focus: chromeFocus, isDestroyed: () => false, send: vi.fn() } }, tabs: { activeWebContents: () => ({ focus: pageFocus }) } }
  return { ctx: { window: window as never, services: {} as never }, pageFocus, chromeFocus }
}

describe('the pane.leave chrome action', () => {
  it('is registered under its name', () => {
    expect(CHROME_ACTIONS['pane.leave']).toBeTypeOf('function')
  })

  it.each([1, -1])('hands the keyboard on to the page past an end of the chrome, going %i', (direction) => {
    const { ctx, pageFocus } = context()
    runChromeAction('pane.leave', { direction }, ctx)
    expect(pageFocus).toHaveBeenCalledTimes(1)
  })

  it('gives the keyboard to the page when asked to', () => {
    const { ctx, pageFocus } = context()
    runChromeAction('pane.leave', { to: 'page' }, ctx)
    expect(pageFocus).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, null, 'page', 7, {}, { direction: 0 }, { direction: 2 }, { direction: '1' }, { direction: true }, { to: 'address' }, { to: 'side-panel' }, { to: ['page'] }])('moves nothing for the payload %j', (payload) => {
    const { ctx, pageFocus, chromeFocus } = context()
    runChromeAction('pane.leave', payload, ctx)
    expect(pageFocus).not.toHaveBeenCalled()
    expect(chromeFocus).not.toHaveBeenCalled()
  })
})
