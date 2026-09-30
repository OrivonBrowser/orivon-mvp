import { describe, expect, it, type vi } from 'vitest'
import { openSnapshot } from '../open-snapshot.js'
import { fakeTabs } from './tabs-fake.js'

describe('openSnapshot', () => {
  it('opens the address as a tab, pinned when it was', () => {
    const fake = fakeTabs()
    const id = openSnapshot(fake.tabs, { url: 'https://a.example/', title: 'A', pinned: true }, true)
    expect(id).toBeDefined()
    expect(fake.calls).toEqual(['create https://a.example/ front'])
    expect(fake.records.get(id ?? '')?.pinned).toBe(true)
  })

  it('gives the new tab its back and forward list, ending on the entry that was shown', () => {
    const fake = fakeTabs()
    const entries = [{ url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }]
    const id = openSnapshot(fake.tabs, { url: 'https://a.example/2', title: 'Two', pinned: false, entries, index: 1 }, true)
    const wc = fake.records.get(id ?? '')?.view.webContents as unknown as { stop: ReturnType<typeof vi.fn>, reload: ReturnType<typeof vi.fn>, navigationHistory: { restore: ReturnType<typeof vi.fn> } }
    expect(wc.navigationHistory.restore).toHaveBeenCalledExactlyOnceWith({ entries, index: 1 })
    // The load createTab began is stopped first and the restored entry loaded once after.
    expect(wc.stop.mock.invocationCallOrder[0]).toBeLessThan(wc.navigationHistory.restore.mock.invocationCallOrder[0] ?? 0)
    expect(wc.reload).toHaveBeenCalledTimes(1)
  })

  it('leaves the tab on its address when the list cannot be restored', () => {
    const fake = fakeTabs()
    const original = fake.tabs.createTab
    fake.tabs.createTab = ((url?: string, active?: boolean) => {
      const id = original(url, active)
      ;(fake.records.get(id)?.view.webContents as unknown as { navigationHistory: { restore: () => never } }).navigationHistory.restore = () => { throw new Error('refused') }
      return id
    }) as never
    const entries = [{ url: 'https://a.example/1', title: '' }, { url: 'https://a.example/2', title: '' }]
    expect(openSnapshot(fake.tabs, { url: 'https://a.example/2', title: '', pinned: false, entries, index: 1 }, true)).toBeDefined()
  })

  it('opens it behind the tab in front when asked', () => {
    const fake = fakeTabs()
    openSnapshot(fake.tabs, { url: 'https://a.example/', title: '', pinned: false }, false)
    expect(fake.calls).toEqual(['create https://a.example/ back'])
  })

  it('refuses an address a tab would refuse, even from a snapshot that was not checked', () => {
    const fake = fakeTabs()
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'view-source:https://a.example/', 'chrome://gpu', 'about:blank']) {
      expect(openSnapshot(fake.tabs, { url, title: '', pinned: false }, true), url).toBeUndefined()
    }
    expect(fake.calls).toEqual([])
  })

  it('refuses an internal page that does not exist, and opens one that does through the shell', () => {
    const fake = fakeTabs()
    expect(openSnapshot(fake.tabs, { url: 'orivon://nope/', title: '', pinned: false, internal: { page: 'nope' as never, path: '/' } }, true)).toBeUndefined()
    const id = openSnapshot(fake.tabs, { url: 'orivon://settings/search', title: 'S', pinned: true, internal: { page: 'settings', path: '/search' } }, true)
    expect(fake.calls).toEqual(['internal settings/search'])
    expect(fake.records.get(id ?? '')?.pinned).toBe(true)
  })

  it('leaves alone an internal page that is already open, and does not pin it', () => {
    const fake = fakeTabs()
    const first = openSnapshot(fake.tabs, { url: 'orivon://history/', title: '', pinned: false, internal: { page: 'history', path: '/' } }, true)
    const second = openSnapshot(fake.tabs, { url: 'orivon://history/', title: '', pinned: true, internal: { page: 'history', path: '/' } }, true)
    expect(second).toBe(first)
    expect(fake.records.get(first ?? '')?.pinned).toBe(false)
    expect(fake.order).toHaveLength(1)
  })

  it('opens nothing when the window has no room', () => {
    const fake = fakeTabs(false)
    expect(openSnapshot(fake.tabs, { url: 'https://a.example/', title: '', pinned: false }, true)).toBeUndefined()
    expect(fake.calls).toEqual([])
  })
})
