import { describe, expect, it, vi } from 'vitest'

const all = vi.hoisted(() => [] as unknown[])
vi.mock('electron', () => ({ BaseWindow: { getAllWindows: () => all } }))

const { windowShowing } = await import('../showing-window.js')

function fakeWindow (children: object[], destroyed = false): object {
  return { isDestroyed: () => destroyed, contentView: { children } }
}

describe('windowShowing', () => {
  it('finds the window a tab\'s view is attached to', () => {
    const tab = {}
    const other = fakeWindow([{ webContents: {} }])
    const showing = fakeWindow([{ webContents: {} }, { webContents: tab }])
    all.splice(0, all.length, other, showing)
    expect(windowShowing(tab)).toBe(showing)
  })

  it('finds none for a tab no window shows, as every background tab is', () => {
    all.splice(0, all.length, fakeWindow([{ webContents: {} }]), fakeWindow([{}]))
    expect(windowShowing({})).toBeUndefined()
  })

  it('never answers with a destroyed window', () => {
    const tab = {}
    all.splice(0, all.length, fakeWindow([{ webContents: tab }], true))
    expect(windowShowing(tab)).toBeUndefined()
  })
})
