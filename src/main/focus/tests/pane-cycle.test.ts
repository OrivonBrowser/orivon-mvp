import { describe, expect, it, vi } from 'vitest'
import { SHELL_EVENT_CHANNEL } from '../../channels.js'
import type { WindowContext } from '../../shell/window-context.js'
import type { ExternalPane } from '../external-panes.js'
import { cyclePane, focusPage, goToChromePane, leaveChrome } from '../pane-cycle.js'

interface Setup { ctx: WindowContext, chromeFocus: ReturnType<typeof vi.fn>, pageFocus: ReturnType<typeof vi.fn>, sent: unknown[] }

/** `inChrome`: the chrome's contents hold the keyboard; otherwise the page does. */
function setup (inChrome: boolean): Setup {
  const chromeFocus = vi.fn()
  const pageFocus = vi.fn()
  const sent: unknown[] = []
  const ctx = {
    window: {
      chrome: { webContents: { focus: chromeFocus, isFocused: () => inChrome, isDestroyed: () => false, send: (channel: string, event: unknown) => { if (channel === SHELL_EVENT_CHANNEL) sent.push(event) } } },
      tabs: { activeWebContents: () => ({ focus: pageFocus }) }
    },
    services: {}
  } as unknown as WindowContext
  return { ctx, chromeFocus, pageFocus, sent }
}

const panel = (state: { open: boolean, focused: boolean }, focus = vi.fn()): ExternalPane => ({ name: 'side-panel', available: () => state.open, focused: () => state.focused, focus })

describe('cyclePane', () => {
  it('goes from the page into the chrome at its first pane going forward, and its last going back', () => {
    const forward = setup(false)
    cyclePane(forward.ctx, 1, [])
    expect(forward.chromeFocus).toHaveBeenCalledTimes(1)
    expect(forward.sent).toEqual([{ type: 'module', module: 'panes', payload: { type: 'enter', edge: 'first' } }])

    const back = setup(false)
    cyclePane(back.ctx, -1, [])
    expect(back.sent).toEqual([{ type: 'module', module: 'panes', payload: { type: 'enter', edge: 'last' } }])
  })

  it('leaves a step made inside the chrome to the chrome', () => {
    const { ctx, chromeFocus, pageFocus, sent } = setup(true)
    cyclePane(ctx, 1, [])
    cyclePane(ctx, -1, [])
    expect(sent.map((event) => (event as { payload: unknown }).payload)).toEqual([{ type: 'step', direction: 1 }, { type: 'step', direction: -1 }])
    expect(chromeFocus).not.toHaveBeenCalled()
    expect(pageFocus).not.toHaveBeenCalled()
  })

  it('goes from the page to an open side panel going back, and from the panel to the page going forward', () => {
    const state = { open: true, focused: false }
    const focus = vi.fn()
    const back = setup(false)
    cyclePane(back.ctx, -1, [panel(state, focus)])
    expect(focus).toHaveBeenCalledTimes(1)
    expect(back.sent).toEqual([])

    state.focused = true
    const forward = setup(false)
    cyclePane(forward.ctx, 1, [panel(state, focus)])
    expect(forward.pageFocus).toHaveBeenCalledTimes(1)
  })

  it('goes from the panel back into the chrome\'s last pane, and forward into its first', () => {
    const state = { open: true, focused: true }
    const back = setup(false)
    cyclePane(back.ctx, -1, [panel(state)])
    expect(back.sent).toEqual([{ type: 'module', module: 'panes', payload: { type: 'enter', edge: 'last' } }])
  })

  it('skips a panel that is closed', () => {
    const focus = vi.fn()
    const { ctx, sent } = setup(false)
    cyclePane(ctx, -1, [panel({ open: false, focused: false }, focus)])
    expect(focus).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
  })

  it('treats the chrome as not holding the keyboard while a panel does', () => {
    const { ctx, sent, pageFocus } = setup(true)
    cyclePane(ctx, 1, [panel({ open: true, focused: true })])
    expect(sent).toEqual([])
    expect(pageFocus).toHaveBeenCalledTimes(1)
  })
})

describe('leaveChrome', () => {
  it('goes to the page past the last pane, and back to the page before the first', () => {
    const forward = setup(true)
    leaveChrome(forward.ctx, 1, [])
    expect(forward.pageFocus).toHaveBeenCalledTimes(1)

    const back = setup(true)
    leaveChrome(back.ctx, -1, [])
    expect(back.pageFocus).toHaveBeenCalledTimes(1)
  })

  it('stops at an open side panel first going forward, and at it last going back from the page side', () => {
    const focus = vi.fn()
    const forward = setup(true)
    leaveChrome(forward.ctx, 1, [panel({ open: true, focused: false }, focus)])
    expect(focus).toHaveBeenCalledTimes(1)
    expect(forward.pageFocus).not.toHaveBeenCalled()

    const back = setup(true)
    leaveChrome(back.ctx, -1, [panel({ open: true, focused: false }, focus)])
    expect(back.pageFocus).toHaveBeenCalledTimes(1)
  })

  it('gives the keyboard to the page on request', () => {
    const { ctx, pageFocus } = setup(true)
    focusPage(ctx)
    expect(pageFocus).toHaveBeenCalledTimes(1)
  })
})

describe('goToChromePane', () => {
  it('takes the keyboard into the chrome and names the pane', () => {
    const { ctx, chromeFocus, sent } = setup(false)
    goToChromePane(ctx, 'toolbar')
    expect(chromeFocus).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([{ type: 'module', module: 'panes', payload: { type: 'go', pane: 'toolbar' } }])
  })
})
