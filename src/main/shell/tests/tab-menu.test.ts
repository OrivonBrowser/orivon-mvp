import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() } }))

const { tabMenuTemplate } = await import('../tab-menu.js')

const actions = () => ({ reload: vi.fn(), duplicate: vi.fn(), moveToNewWindow: vi.fn(), separate: vi.fn(), close: vi.fn(), closeOthers: vi.fn() })
const model = (overrides: Partial<Parameters<typeof tabMenuTemplate>[0]> = {}): Parameters<typeof tabMenuTemplate>[0] => ({
  canDuplicate: true, tabCount: 3, inSplit: false, splitPartners: [], otherWindows: [], ...overrides
})
const labels = (template: MenuItemConstructorOptions[]): string[] => template.filter((item) => item.type !== 'separator').map((item) => item.label ?? '')
const find = (template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined => template.find((item) => item.label === label)

describe('a tab\'s menu', () => {
  it('offers what can be done to one tab, in order', () => {
    expect(labels(tabMenuTemplate(model(), actions()))).toEqual(['Reload', 'Duplicate', 'Split with', 'Move Tab to New Window', 'Close Tab', 'Close Other Tabs'])
  })

  it('runs the action of the entry chosen', () => {
    const a = actions()
    const template = tabMenuTemplate(model(), a)
    for (const label of ['Reload', 'Duplicate', 'Move Tab to New Window', 'Close Tab', 'Close Other Tabs']) (find(template, label)?.click as () => void)()
    expect(a.reload).toHaveBeenCalledTimes(1)
    expect(a.duplicate).toHaveBeenCalledTimes(1)
    expect(a.moveToNewWindow).toHaveBeenCalledTimes(1)
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(a.closeOthers).toHaveBeenCalledTimes(1)
  })

  it('leaves a window\'s only tab where it is, and has nothing to close beside it', () => {
    const template = tabMenuTemplate(model({ tabCount: 1 }), actions())
    expect(find(template, 'Move Tab to New Window')?.enabled).toBe(false)
    expect(find(template, 'Close Other Tabs')?.enabled).toBe(false)
  })

  it('does not copy a page that is one of the shell\'s own', () => {
    expect(find(tabMenuTemplate(model({ canDuplicate: false }), actions()), 'Duplicate')?.enabled).toBe(false)
  })

  it('lists the other windows only when there are some', () => {
    expect(find(tabMenuTemplate(model(), actions()), 'Move Tab to Window')).toBeUndefined()
    const move = vi.fn()
    const template = tabMenuTemplate(model({ otherWindows: [{ label: 'Window 2: Docs', move }] }), actions())
    const submenu = find(template, 'Move Tab to Window')?.submenu as MenuItemConstructorOptions[]
    expect(submenu.map((item) => item.label)).toEqual(['Window 2: Docs'])
    ;(submenu[0]?.click as () => void)()
    expect(move).toHaveBeenCalledTimes(1)
  })

  it('offers the tabs it could be split with, or to separate the pair it is in', () => {
    const split = vi.fn()
    const alone = tabMenuTemplate(model({ splitPartners: [{ label: 'News', split }, { label: 'Mail', split: vi.fn() }] }), actions())
    const partners = find(alone, 'Split with')?.submenu as MenuItemConstructorOptions[]
    expect(partners.map((item) => item.label)).toEqual(['News', 'Mail'])
    ;(partners[0]?.click as () => void)()
    expect(split).toHaveBeenCalledTimes(1)
    expect(find(alone, 'Separate Tabs')).toBeUndefined()

    const a = actions()
    const joined = tabMenuTemplate(model({ inSplit: true }), a)
    expect(find(joined, 'Split with')).toBeUndefined()
    ;(find(joined, 'Separate Tabs')?.click as () => void)()
    expect(a.separate).toHaveBeenCalledTimes(1)
  })

  it('has no one to split with when it is the only tab', () => {
    expect(find(tabMenuTemplate(model({ tabCount: 1, splitPartners: [] }), actions()), 'Split with')?.enabled).toBe(false)
  })

  it('never begins or ends with a separator, or has two in a row', () => {
    for (const template of [tabMenuTemplate(model(), actions()), tabMenuTemplate(model({ inSplit: true, otherWindows: [{ label: 'w', move: vi.fn() }] }), actions())]) {
      expect(template[0]?.type).not.toBe('separator')
      expect(template.at(-1)?.type).not.toBe('separator')
      template.forEach((item, at) => { if (item.type === 'separator') expect(template[at - 1]?.type).not.toBe('separator') })
    }
  })
})
