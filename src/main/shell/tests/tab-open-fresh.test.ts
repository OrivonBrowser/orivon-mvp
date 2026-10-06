import { describe, expect, it, vi } from 'vitest'
import { TabOpener } from '../tab-open.js'
import type { TabOpenerHost } from '../tab-open.js'
import type { TabFactory } from '../tab-factory.js'

function setup (capacity = false): { opener: TabOpener, fresh: ReturnType<typeof vi.fn>, contents: object } {
  const contents = { loadURL: vi.fn(() => Promise.resolve()) }
  const fresh = vi.fn()
  const host: TabOpenerHost = {
    add: vi.fn(), activate: vi.fn(), changed: vi.fn(), atCapacity: () => capacity, activeId: () => 'front', records: () => [], freshTabInFront: fresh
  }
  const built = { id: 't1', target: 'file:///dashboard', record: { view: { webContents: contents } } }
  const factory = { content: () => built, trusted: () => built }
  return { opener: new TabOpener(host, factory as unknown as TabFactory), fresh, contents }
}

describe('TabOpener.createTab: a fresh tab in front', () => {
  it('reports a tab opened with no address, in front', () => {
    const { opener, fresh, contents } = setup()
    expect(opener.createTab()).toBe('t1')
    expect(fresh).toHaveBeenCalledWith('t1', contents)
  })

  it('reports no tab opened with an address, or behind the current one, or refused at the limit', () => {
    const a = setup()
    a.opener.createTab('https://a.example/')
    const b = setup()
    b.opener.createTab(undefined, false)
    const c = setup(true)
    c.opener.createTab()
    expect(a.fresh).not.toHaveBeenCalled()
    expect(b.fresh).not.toHaveBeenCalled()
    expect(c.fresh).not.toHaveBeenCalled()
  })
})

describe('TabOpener.openTrusted: a fresh tab in front', () => {
  it('reports a tab opened with no address, as an extension\'s tabs.create({}) does', () => {
    const { opener, fresh, contents } = setup()
    expect(opener.openTrusted()?.[0]).toBe('t1')
    expect(fresh).toHaveBeenCalledWith('t1', contents)
  })

  it('reports no tab opened with an address, or refused at the limit', () => {
    const a = setup()
    a.opener.openTrusted('https://a.example/')
    const b = setup(true)
    b.opener.openTrusted()
    expect(a.fresh).not.toHaveBeenCalled()
    expect(b.fresh).not.toHaveBeenCalled()
  })
})
