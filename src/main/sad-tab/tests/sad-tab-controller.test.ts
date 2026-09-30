import { describe, expect, it, vi } from 'vitest'
import { syncSadTab, watchActivations } from '../sad-tab-controller.js'
import { markUnresponsive, waiveUnresponsive } from '../sad-tab-state.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { TabRecord } from '../../shell/tab-types.js'

interface Rig {
  window: ShellWindow
  show: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  open: { value: boolean }
  setActive: (id: string | null) => void
}

function rig (records: Record<string, TabRecord>, active: string | null): Rig {
  const open = { value: false }
  let current = active
  const contents = (id: string): object => ({ id })
  const show = vi.fn(() => { open.value = true })
  const close = vi.fn(() => { open.value = false })
  const window = {
    window: { isDestroyed: () => false },
    tabs: {
      activeWebContents: () => current === null ? undefined : contents(current),
      findTabIdByWebContents: (wc: { id: string }) => wc.id,
      record: (id: string) => records[id]
    },
    overlays: { isOpen: () => open.value, show, close }
  } as unknown as ShellWindow
  return { window, show, close, open, setActive: (id) => { current = id } }
}

const crashed = (reason = 'crashed'): TabRecord => ({ crashed: reason }) as unknown as TabRecord
const healthy = (): TabRecord => ({ crashed: null }) as unknown as TabRecord

describe('the sad-tab card of a window', () => {
  it('opens for an active crashed tab, naming the tab', () => {
    const { window, show } = rig({ a: crashed() }, 'a')
    syncSadTab(window)
    expect(show).toHaveBeenCalledWith('sad-tab', undefined, { id: 'a' })
  })

  it('does not open for a tab that crashed in the background', () => {
    const { window, show } = rig({ a: healthy(), b: crashed() }, 'a')
    syncSadTab(window)
    expect(show).not.toHaveBeenCalled()
  })

  it('opens when the crashed tab becomes the active one', () => {
    const r = rig({ a: healthy(), b: crashed() }, 'a')
    r.setActive('b')
    syncSadTab(r.window)
    expect(r.show).toHaveBeenCalledWith('sad-tab', undefined, { id: 'b' })
  })

  it('is not shown again by a state push that changed nothing', () => {
    const { window, show } = rig({ a: crashed() }, 'a')
    syncSadTab(window)
    syncSadTab(window)
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('closes when the tab is healthy again, and only when it is open', () => {
    const records = { a: crashed() }
    const r = rig(records, 'a')
    syncSadTab(r.window)
    records.a.crashed = null
    syncSadTab(r.window)
    expect(r.close).toHaveBeenCalledWith('sad-tab')
    syncSadTab(r.window)
    expect(r.close).toHaveBeenCalledTimes(1)
  })

  it('opens for a page that stopped answering, and stays closed once the person waits, until the next event', () => {
    const tab = healthy()
    const r = rig({ a: tab }, 'a')
    markUnresponsive(tab)
    syncSadTab(r.window)
    expect(r.show).toHaveBeenCalledTimes(1)

    waiveUnresponsive(tab)
    syncSadTab(r.window)
    expect(r.close).toHaveBeenCalledWith('sad-tab')

    r.show.mockClear()
    markUnresponsive(tab)
    syncSadTab(r.window)
    expect(r.show).toHaveBeenCalledTimes(1)
  })

  it('shows again when the trouble changes kind in the same tab', () => {
    const tab = healthy()
    const r = rig({ a: tab }, 'a')
    markUnresponsive(tab)
    syncSadTab(r.window)
    tab.crashed = 'killed'
    syncSadTab(r.window)
    expect(r.show).toHaveBeenCalledTimes(2)
  })

  it('does nothing in a window with no tab, or one that is being destroyed', () => {
    const r = rig({}, null)
    expect(() => { syncSadTab(r.window) }).not.toThrow()
    expect(r.show).not.toHaveBeenCalled()
    const gone = { window: { isDestroyed: () => true } } as unknown as ShellWindow
    expect(() => { syncSadTab(gone) }).not.toThrow()
  })
})

describe('watching activations', () => {
  it('syncs the window of a tab that became active, a turn later, and subscribes once per lifecycle', () => {
    vi.useFakeTimers()
    try {
      let listener: { tabActivated: (contents: unknown) => void } | undefined
      const subscribe = vi.fn((given: typeof listener) => { listener = given; return () => {} })
      const lifecycle = { subscribe } as never
      const r = rig({ a: crashed() }, 'a')
      const contents = { isDestroyed: () => false }
      watchActivations(lifecycle, () => r.window)
      watchActivations(lifecycle, () => r.window)
      expect(subscribe).toHaveBeenCalledTimes(1)

      listener?.tabActivated(contents)
      expect(r.show).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(r.show).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves a page that was destroyed meanwhile alone', () => {
    vi.useFakeTimers()
    try {
      let listener: { tabActivated: (contents: unknown) => void } | undefined
      const lifecycle = { subscribe: (given: typeof listener) => { listener = given; return () => {} } } as never
      const windowOf = vi.fn()
      watchActivations(lifecycle, windowOf)
      listener?.tabActivated({ isDestroyed: () => true })
      vi.runAllTimers()
      expect(windowOf).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
