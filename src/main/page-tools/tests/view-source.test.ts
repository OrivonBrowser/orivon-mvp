import { describe, expect, it, vi } from 'vitest'
import { canViewSource, openTypedViewSource, openViewSource } from '../view-source.js'
import type { SourceTabs } from '../view-source.js'

function tabs (record: Record<string, unknown> | null = { partition: undefined, internalPage: null, isDashboardTab: false }, active: string | null = 'b'): SourceTabs & { openTrusted: ReturnType<typeof vi.fn>, moveTab: ReturnType<typeof vi.fn> } {
  return {
    getState: () => ({ tabs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], activeTabId: active }),
    record: () => record ?? undefined,
    openTrusted: vi.fn(() => ['n', {}]),
    moveTab: vi.fn()
  } as never
}

describe('openViewSource', () => {
  it('opens the source of a web page in a new tab straight after the active one', () => {
    const manager = tabs()
    expect(openViewSource(manager, 'https://a.example/x?y=1')).toBe(true)
    expect(manager.openTrusted).toHaveBeenCalledWith('view-source:https://a.example/x?y=1')
    expect(manager.moveTab).toHaveBeenCalledWith('n', 2)
  })

  it('opens nothing for an address that is not http or https', () => {
    const manager = tabs()
    for (const url of ['orivon://settings/', 'file:///etc/passwd', 'view-source:https://a.example/', 'javascript:alert(1)', 'about:blank', '']) {
      expect(openViewSource(manager, url), url).toBe(false)
    }
    expect(manager.openTrusted).not.toHaveBeenCalled()
  })

  it('leaves out an app\'s tab, a shell page, the new-tab page and a window with no active tab', () => {
    for (const record of [{ partition: 'persist:app', internalPage: null, isDashboardTab: false }, { partition: undefined, internalPage: 'history', isDashboardTab: false }, { partition: undefined, internalPage: null, isDashboardTab: true }, null]) {
      const manager = tabs(record)
      expect(openViewSource(manager, 'https://a.example/')).toBe(false)
      expect(manager.openTrusted).not.toHaveBeenCalled()
    }
    expect(openViewSource(tabs(null, null), 'https://a.example/')).toBe(false)
  })

  it('reports a window that has no room for another tab', () => {
    const manager = tabs()
    manager.openTrusted.mockReturnValue(undefined)
    expect(openViewSource(manager, 'https://a.example/')).toBe(false)
    expect(manager.moveTab).not.toHaveBeenCalled()
  })
})

describe('openTypedViewSource', () => {
  it('opens the source of a typed address from the new-tab page, a shell page or an app, which are not the page asked about', () => {
    for (const record of [{ partition: undefined, internalPage: null, isDashboardTab: true }, { partition: undefined, internalPage: 'history', isDashboardTab: false }, { partition: 'persist:app', internalPage: null, isDashboardTab: false }, null]) {
      const manager = tabs(record)
      expect(openTypedViewSource(manager, 'https://a.example/x'), JSON.stringify(record)).toBe(true)
      expect(manager.openTrusted).toHaveBeenCalledWith('view-source:https://a.example/x')
      expect(manager.moveTab).toHaveBeenCalledWith('n', 2)
    }
  })

  it('opens a tab even in a window with no active one, and still only for a web address', () => {
    const manager = tabs(null, null)
    expect(openTypedViewSource(manager, 'https://a.example/')).toBe(true)
    expect(manager.moveTab).not.toHaveBeenCalled()
    for (const url of ['orivon://settings/', 'file:///etc/passwd', 'view-source:https://a.example/', 'javascript:alert(1)', '']) {
      expect(openTypedViewSource(manager, url), url).toBe(false)
    }
    expect(manager.openTrusted).toHaveBeenCalledTimes(1)
  })

  it('reports a window that has no room for another tab', () => {
    const manager = tabs()
    manager.openTrusted.mockReturnValue(undefined)
    expect(openTypedViewSource(manager, 'https://a.example/')).toBe(false)
  })
})

describe('canViewSource', () => {
  const plain = { partition: undefined, internalPage: null, isDashboardTab: false }

  it('is true for a web page in an ordinary tab, and false for anything openViewSource refuses', () => {
    expect(canViewSource(plain, 'https://a.example/')).toBe(true)
    expect(canViewSource({ ...plain, partition: 'persist:app' }, 'https://a.example/')).toBe(false)
    expect(canViewSource({ ...plain, internalPage: 'history' }, 'https://a.example/')).toBe(false)
    expect(canViewSource({ ...plain, isDashboardTab: true }, 'https://a.example/')).toBe(false)
    expect(canViewSource(undefined, 'https://a.example/')).toBe(false)
    expect(canViewSource(plain, 'file:///etc/passwd')).toBe(false)
    expect(canViewSource(plain, 'orivon://settings/')).toBe(false)
  })
})
