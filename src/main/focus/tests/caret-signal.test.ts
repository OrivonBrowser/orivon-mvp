import { describe, expect, it, vi } from 'vitest'
import type { TabSignalContext } from '../../shell/tab-signals.js'
import { caretSignal } from '../caret-signal.js'

function tab (options: { on: boolean, dashboard?: boolean, services?: boolean, destroyed?: boolean, shown?: boolean }): { context: TabSignalContext, set: ReturnType<typeof vi.fn>, record: { isDashboardTab: boolean }, navigate: () => void } {
  const set = vi.fn()
  const listeners: Array<() => void> = []
  const record = {
    isDashboardTab: options.dashboard === true,
    host: options.services === false ? {} : { services: { settings: { get: () => options.on } } }
  }
  const wc = { setCaretBrowsingEnabled: set, isDestroyed: () => options.destroyed === true, on: (_event: string, listener: () => void) => { listeners.push(listener) } }
  const context = { wc, record, shown: () => options.shown !== false } as unknown as TabSignalContext
  return { context, set, record, navigate: () => { for (const listener of listeners) listener() } }
}

describe('the caret tab signal', () => {
  it('puts the setting on the page a tab shows', () => {
    const on = tab({ on: true })
    caretSignal.apply?.(on.context)
    expect(on.set).toHaveBeenCalledWith(true)
    const off = tab({ on: false })
    caretSignal.apply?.(off.context)
    expect(off.set).toHaveBeenCalledWith(false)
  })

  it('keeps it off the new-tab page', () => {
    const { context, set } = tab({ on: true, dashboard: true })
    caretSignal.apply?.(context)
    expect(set).toHaveBeenCalledWith(false)
  })

  it('gives it to the new-tab page once that page navigates to a site', () => {
    const { context, set, record, navigate } = tab({ on: true, dashboard: true })
    caretSignal.wire?.(context)
    navigate()
    expect(set).toHaveBeenLastCalledWith(false)
    record.isDashboardTab = false
    navigate()
    expect(set).toHaveBeenLastCalledWith(true)
  })

  it('ignores a navigation of a view that is swapped out', () => {
    const { context, set, navigate } = tab({ on: true, shown: false })
    caretSignal.wire?.(context)
    navigate()
    expect(set).not.toHaveBeenCalled()
  })

  it('does nothing without the shell\'s services, or for a destroyed page', () => {
    const bare = tab({ on: true, services: false })
    caretSignal.apply?.(bare.context)
    const gone = tab({ on: true, destroyed: true })
    caretSignal.apply?.(gone.context)
    expect(bare.set).not.toHaveBeenCalled()
    expect(gone.set).not.toHaveBeenCalled()
  })
})
