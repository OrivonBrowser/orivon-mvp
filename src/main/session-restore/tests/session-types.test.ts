import { describe, expect, it } from 'vitest'
import { cleanBounds, MAX_SESSION_WINDOWS, MAX_WINDOW_TABS, parseSession } from '../session-types.js'

const pinnedTab = (n: number | string): Record<string, unknown> => ({ ...tab(n), pinned: true })
const tab = (n: number | string): Record<string, unknown> => ({ url: `https://a.example/${String(n)}`, title: String(n), pinned: false })
const file = (windows: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ version: 1, clean: false, windows, ...extra })
const window = (tabs: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({ bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: false, active: 0, tabs, ...extra })

describe('parseSession', () => {
  it('puts pinned tabs first, keeping the order within each kind and the front tab where it was', () => {
    const parsed = parseSession(file([window([tab(1), pinnedTab(2), tab(3), pinnedTab(4)], { active: 2 })]))
    expect(parsed?.windows[0]?.tabs.map((entry) => entry.title)).toEqual(['2', '4', '1', '3'])
    expect(parsed?.windows[0]?.tabs.map((entry) => entry.pinned)).toEqual([true, true, false, false])
    expect(parsed?.windows[0]?.active).toBe(3)
  })

  it('reads what the recorder writes', () => {
    const text = file([window([tab(1), tab(2)], { active: 1, maximized: true })], { clean: true })
    expect(parseSession(text)).toEqual({
      version: 1,
      clean: true,
      windows: [{ bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: true, active: 1, tabs: [{ url: 'https://a.example/1', title: '1', pinned: false }, { url: 'https://a.example/2', title: '2', pinned: false }] }]
    })
  })

  it('gives null for garbage, the wrong version and a file that is not a session', () => {
    for (const text of ['', 'not json', '[]', '4', 'null', JSON.stringify({ version: 2, windows: [] }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, windows: 'x' })]) {
      expect(parseSession(text), text).toBeNull()
    }
  })

  it('drops a tab that a tab could not open, and a window that is not one', () => {
    const parsed = parseSession(file([window([tab(1), { url: 'javascript:alert(1)' }, { url: 'file:///etc/passwd' }, { url: 'view-source:https://a.example/' }, 'x', tab(2)]), 'x', null, { tabs: 'x' }]))
    expect(parsed?.windows).toHaveLength(1)
    expect(parsed?.windows[0]?.tabs.map((entry) => entry.url)).toEqual(['https://a.example/1', 'https://a.example/2'])
  })

  it('keeps the front tab in front when a tab before it is dropped', () => {
    const parsed = parseSession(file([window([{ url: 'javascript:1' }, tab(1), tab(2)], { active: 2 })]))
    expect(parsed?.windows[0]?.active).toBe(1)
    expect(parseSession(file([window([tab(1)], { active: 9 })]))?.windows[0]?.active).toBe(0)
  })

  it('keeps a window that holds no tab: it shows the new-tab page', () => {
    expect(parseSession(file([window([])]))?.windows).toHaveLength(1)
  })

  it('caps the windows and the tabs in each', () => {
    const many = Array.from({ length: MAX_WINDOW_TABS + 20 }, (_, n) => tab(n))
    const parsed = parseSession(file(Array.from({ length: MAX_SESSION_WINDOWS + 5 }, () => window(many))))
    expect(parsed?.windows).toHaveLength(MAX_SESSION_WINDOWS)
    expect(parsed?.windows[0]?.tabs).toHaveLength(MAX_WINDOW_TABS)
  })

  it('reads clean as true only when it says true', () => {
    expect(parseSession(file([], { clean: 'yes' }))?.clean).toBe(false)
    expect(parseSession(file([], { clean: true }))?.clean).toBe(true)
  })

  it('checks an internal page again', () => {
    const parsed = parseSession(file([window([{ url: 'x', internal: { page: 'history', path: '/' } }, { url: 'x', internal: { page: 'bogus', path: '/' } }, { url: 'x', internal: { page: 'settings', path: 'no-slash' } }])]))
    expect(parsed?.windows[0]?.tabs.map((entry) => entry.url)).toEqual(['orivon://history/'])
  })
})

describe('cleanBounds', () => {
  it('rounds and clamps to what a screen can hold, and falls back when a number is not one', () => {
    expect(cleanBounds({ x: 10.6, y: -50, width: 5, height: 99_999 })).toEqual({ x: 11, y: -50, width: 100, height: 10_000 })
    expect(cleanBounds({ x: Infinity, y: NaN, width: '800', height: null })).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
    expect(cleanBounds(undefined)).toEqual({ x: 0, y: 0, width: 1280, height: 800 })
  })
})
