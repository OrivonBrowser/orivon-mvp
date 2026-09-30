import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import { askChooser } from '../ask-chooser.js'
import { choosers } from '../chooser-store.js'

const SPEC = { title: 'T', confirm: 'Go', empty: 'None', items: [{ id: 'a', title: 'A' }] }

function fakeWindow (active = 't1'): { window: ShellWindow, shows: Array<{ name: string, payload: unknown }>, closeHook: () => void } {
  const shows: Array<{ name: string, payload: unknown }> = []
  const window = {
    tabs: { getState: () => ({ activeTabId: active }) },
    overlays: { show: (name: string, _anchor: unknown, payload: unknown) => { shows.push({ name, payload }) }, close: vi.fn() }
  } as unknown as ShellWindow
  return { window, shows, closeHook: () => undefined }
}

describe('askChooser', () => {
  it('shows a chooser for the tab and resolves with the chosen id', async () => {
    const { window, shows } = fakeWindow()
    const asked = askChooser(window, 't1', SPEC)
    expect(shows).toHaveLength(1)
    expect(shows[0]?.name).toBe('chooser')
    const { id } = shows[0]?.payload as { id: string }
    expect(choosers.get(id)?.tabId).toBe('t1')
    choosers.resolve(id, 'a')
    expect(await asked).toBe('a')
  })

  it('resolves null when the sheet ends without a choice', async () => {
    const { slotClosed } = await import('../../overlays/tab-slots.js')
    const { window, shows } = fakeWindow()
    const asked = askChooser(window, 't1', SPEC)
    expect(shows).toHaveLength(1)
    slotClosed(window, 'chooser', 'escape')
    expect(await asked).toBeNull()
  })

  it('waits for its tab when it is not in front', () => {
    const { window, shows } = fakeWindow('t1')
    void askChooser(window, 't2', SPEC)
    expect(shows).toHaveLength(0)
  })
})
