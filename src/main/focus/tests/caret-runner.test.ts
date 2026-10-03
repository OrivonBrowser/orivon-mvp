import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WindowContext } from '../../shell/window-context.js'
import type { ShellServices } from '../../shell/shell-services.js'

const requestSlot = vi.fn()
vi.mock('../../overlays/tab-slots.js', () => ({ requestSlot: (ask: unknown) => requestSlot(ask), slotClosed: vi.fn() }))
const showToast = vi.fn()
vi.mock('../../page-tools/toast.js', () => ({ showToast: (...args: unknown[]) => { showToast(...args) } }))

const { applyCaret, dropCaretAsk, toggleCaret } = await import('../caret-runner.js')

function context (values: { on?: boolean, ask?: boolean }, activeTabId: string | null = 'a'): { ctx: WindowContext, set: ReturnType<typeof vi.fn> } {
  const state = { 'accessibility.caretBrowsing': values.on ?? false, 'accessibility.caretAsk': values.ask ?? true } as Record<string, boolean>
  const set = vi.fn((key: string, value: boolean) => { state[key] = value })
  const ctx = {
    window: { tabs: { getState: () => ({ activeTabId }) } },
    services: { settings: { get: (key: string) => state[key], set } }
  } as unknown as WindowContext
  return { ctx, set }
}

beforeEach(() => {
  requestSlot.mockReset()
  requestSlot.mockImplementation(() => ({ cancel: vi.fn() }))
  showToast.mockReset()
})

describe('toggleCaret', () => {
  it('asks in a sheet over the tab in front, and sets nothing yet', () => {
    const { ctx, set } = context({})
    toggleCaret(ctx)
    expect(requestSlot).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'a', slot: 'center', overlay: 'caret-confirm' }))
    expect(set).not.toHaveBeenCalled()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('asks once for a window while its sheet is up, and again when the sheet has closed', () => {
    const { ctx } = context({})
    toggleCaret(ctx)
    toggleCaret(ctx)
    expect(requestSlot).toHaveBeenCalledTimes(1)
    ;(requestSlot.mock.calls[0]?.[0] as { closed: () => void }).closed()
    toggleCaret(ctx)
    expect(requestSlot).toHaveBeenCalledTimes(2)
  })

  it('asks again in the tab in front when the sheet was left waiting in another tab, ending that one', () => {
    const state = { active: 'a' }
    const cancels: Array<ReturnType<typeof vi.fn>> = []
    requestSlot.mockImplementation((ask: { closed: () => void }) => {
      const cancel = vi.fn(() => { ask.closed() })
      cancels.push(cancel)
      return { cancel }
    })
    const ctx = {
      window: { tabs: { getState: () => ({ activeTabId: state.active }) } },
      services: { settings: { get: (key: string) => key === 'accessibility.caretAsk', set: vi.fn() } }
    } as unknown as WindowContext
    toggleCaret(ctx)
    state.active = 'b'
    toggleCaret(ctx)
    expect(requestSlot.mock.calls.map((call) => (call[0] as { tabId: string }).tabId)).toEqual(['a', 'b'])
    expect(cancels[0]).toHaveBeenCalledOnce()
    toggleCaret(ctx)
    expect(requestSlot).toHaveBeenCalledTimes(2)
  })

  it('ends the sheet for good when its tab is left, so F7 asks afresh', () => {
    const { ctx } = context({})
    const cancel = vi.fn()
    requestSlot.mockImplementation(() => ({ cancel }))
    toggleCaret(ctx)
    dropCaretAsk(ctx.window)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('turns on at once, with a toast, when it is not to ask', () => {
    const { ctx, set } = context({ ask: false })
    toggleCaret(ctx)
    expect(requestSlot).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith('accessibility.caretBrowsing', true)
    expect(showToast).toHaveBeenCalledWith(ctx.window, 'caretOn')
  })

  it('turns off without asking, even when it asks before turning on', () => {
    const { ctx, set } = context({ on: true, ask: true })
    toggleCaret(ctx)
    expect(requestSlot).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith('accessibility.caretBrowsing', false)
    expect(showToast).toHaveBeenCalledWith(ctx.window, 'caretOff')
  })

  it('asks nothing of a window with no tab', () => {
    const { ctx } = context({}, null)
    toggleCaret(ctx)
    expect(requestSlot).not.toHaveBeenCalled()
  })
})

describe('applyCaret', () => {
  function windows (on: boolean): { services: Pick<ShellServices, 'windows' | 'settings'>, contents: Record<string, ReturnType<typeof vi.fn>> } {
    const contents = { a: vi.fn(), b: vi.fn(), newtab: vi.fn(), gone: vi.fn() }
    const records: Record<string, { isDashboardTab: boolean, view: { webContents: { setCaretBrowsingEnabled: ReturnType<typeof vi.fn>, isDestroyed: () => boolean } } }> = {}
    for (const [id, fn] of Object.entries(contents)) records[id] = { isDashboardTab: id === 'newtab', view: { webContents: { setCaretBrowsingEnabled: fn, isDestroyed: () => id === 'gone' } } }
    const services = {
      settings: { get: () => on },
      windows: { all: () => [{ tabs: { ids: () => ['a', 'b'], record: (id: string) => records[id] } }, { tabs: { ids: () => ['newtab', 'gone', 'missing'], record: (id: string) => records[id] } }] }
    } as unknown as Pick<ShellServices, 'windows' | 'settings'>
    return { services, contents }
  }

  it('sets it on every tab of every window, except the new-tab page and a destroyed page', () => {
    const { services, contents } = windows(true)
    applyCaret(services)
    expect(contents['a']).toHaveBeenCalledWith(true)
    expect(contents['b']).toHaveBeenCalledWith(true)
    expect(contents['newtab']).not.toHaveBeenCalled()
    expect(contents['gone']).not.toHaveBeenCalled()
  })

  it('takes it off the tabs when the setting is off', () => {
    const { services, contents } = windows(false)
    applyCaret(services)
    expect(contents['a']).toHaveBeenCalledWith(false)
  })
})
