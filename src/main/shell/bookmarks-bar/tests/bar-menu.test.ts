import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { barMenuTemplate, openAllLabel } from '../bar-menu.js'
import type { BarMenuActions, BarMenuModel } from '../bar-menu.js'

const actions = (): { [K in keyof BarMenuActions]-?: Mock<() => void> } => ({
  openInTab: vi.fn<() => void>(), openInWindow: vi.fn<() => void>(), openInPrivate: vi.fn<() => void>(), openAll: vi.fn<() => void>(), copyLink: vi.fn<() => void>(),
  remove: vi.fn<() => void>(), toggleBar: vi.fn<() => void>(), openManager: vi.fn<() => void>()
})
const model = (overrides: Partial<BarMenuModel> = {}): BarMenuModel => ({ target: { kind: 'url' }, isPrivate: false, barShown: true, ...overrides })
const labels = (template: MenuItemConstructorOptions[]): string[] => template.map((item) => item.type === 'separator' ? '-' : item.label ?? '')
const find = (template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions => template.find((item) => item.label === label) as MenuItemConstructorOptions

describe('the bookmarks bar menu', () => {
  it('offers a page its open items, copy, delete, the bar check and the manager', () => {
    expect(labels(barMenuTemplate(model(), actions()))).toEqual([
      'Open in New Tab', 'Open in New Window', 'Open in Private Window', '-', 'Copy Link', 'Delete', '-', 'Show Bookmarks Bar', 'Bookmark Manager'
    ])
  })

  it('leaves the manager out while nothing can open it', () => {
    const { openManager, ...rest } = actions()
    expect(openManager).toBeDefined()
    expect(labels(barMenuTemplate(model({ target: { kind: 'bar' } }), rest))).toEqual(['Show Bookmarks Bar'])
  })

  it('offers a folder Open All, delete, and the same two at the foot', () => {
    expect(labels(barMenuTemplate(model({ target: { kind: 'folder', pages: 3 } }), actions()))).toEqual(['Open All (3)', '-', 'Delete', '-', 'Show Bookmarks Bar', 'Bookmark Manager'])
  })

  it('offers the empty bar only the bar check and the manager', () => {
    expect(labels(barMenuTemplate(model({ target: { kind: 'bar' } }), actions()))).toEqual(['Show Bookmarks Bar', 'Bookmark Manager'])
  })

  it('leaves out the private window in a private window, and disables Open All on an empty folder', () => {
    expect(labels(barMenuTemplate(model({ isPrivate: true }), actions()))).not.toContain('Open in Private Window')
    expect(find(barMenuTemplate(model({ target: { kind: 'folder', pages: 0 } }), actions()), 'Open All (0)').enabled).toBe(false)
  })

  it('names how many pages Open All makes when the folder holds more than the cap', () => {
    expect(openAllLabel(25)).toBe('Open All (25)')
    expect(openAllLabel(40)).toBe('Open All (25 of 40)')
  })

  it('ticks the bar check while the bar is shown, and runs the item chosen', () => {
    const a = actions()
    const template = barMenuTemplate(model({ barShown: false }), a)
    expect(find(template, 'Show Bookmarks Bar')).toMatchObject({ type: 'checkbox', checked: false })
    expect(find(barMenuTemplate(model(), a), 'Show Bookmarks Bar').checked).toBe(true)

    const click = (label: string): void => { (find(template, label).click as () => void)() }
    click('Open in New Tab'); click('Open in New Window'); click('Open in Private Window'); click('Copy Link'); click('Delete'); click('Show Bookmarks Bar'); click('Bookmark Manager')
    for (const name of ['openInTab', 'openInWindow', 'openInPrivate', 'copyLink', 'remove', 'toggleBar', 'openManager'] as const) expect(a[name], name).toHaveBeenCalledTimes(1)
  })
})
