import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn() } }))

const { tabMenuTemplate } = await import('../tab-menu.js')

const actions = () => ({ newTabRight: vi.fn(), reload: vi.fn(), duplicate: vi.fn(), togglePin: vi.fn(), toggleMute: vi.fn(), newGroup: vi.fn(), ungroup: vi.fn(), sleep: vi.fn(), moveToNewWindow: vi.fn(), separate: vi.fn(), close: vi.fn(), closeOthers: vi.fn(), closeRight: vi.fn(), run: vi.fn() })
const model = (overrides: Partial<Parameters<typeof tabMenuTemplate>[0]> = {}): Parameters<typeof tabMenuTemplate>[0] => ({
  canDuplicate: true, pinned: false, muted: false, canPin: true, othersClosable: true, rightClosable: true, tabCount: 3, inSplit: false, splitPartners: [], grouped: false, groups: [], otherWindows: [], ...overrides
})
const labels = (template: MenuItemConstructorOptions[]): string[] => template.filter((item) => item.type !== 'separator').map((item) => item.label ?? '')
const find = (template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions | undefined => template.find((item) => item.label === label)

describe('a tab\'s menu', () => {
  it('offers what can be done to one tab, in order', () => {
    expect(labels(tabMenuTemplate(model(), actions()))).toEqual(['New Tab to the Right', 'Reload', 'Duplicate', 'Pin Tab', 'Mute Tab', 'Put Tab to Sleep', 'Add Tab to New Group', 'Split with', 'Move Tab to New Window', 'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right', 'Reopen Closed Tab', 'Bookmark All Tabs…'])
  })

  it('runs the action of the entry chosen', () => {
    const a = actions()
    const template = tabMenuTemplate(model(), a)
    for (const label of ['New Tab to the Right', 'Reload', 'Duplicate', 'Pin Tab', 'Mute Tab', 'Move Tab to New Window', 'Close Tab', 'Close Other Tabs', 'Close Tabs to the Right', 'Reopen Closed Tab']) (find(template, label)?.click as () => void)()
    expect(a.newTabRight).toHaveBeenCalledTimes(1)
    expect(a.togglePin).toHaveBeenCalledTimes(1)
    expect(a.toggleMute).toHaveBeenCalledTimes(1)
    expect(a.closeRight).toHaveBeenCalledTimes(1)
    expect(a.run).toHaveBeenCalledWith('tab.reopen')
    expect(a.reload).toHaveBeenCalledTimes(1)
    expect(a.duplicate).toHaveBeenCalledTimes(1)
    expect(a.moveToNewWindow).toHaveBeenCalledTimes(1)
    expect(a.close).toHaveBeenCalledTimes(1)
    expect(a.closeOthers).toHaveBeenCalledTimes(1)
  })

  it('offers sleep for a tab behind the one in front, and not for the one in front', () => {
    const a = actions()
    const behind = tabMenuTemplate(model({ canSleep: true }), a)
    expect(find(behind, 'Put Tab to Sleep')?.enabled).toBe(true)
    ;(find(behind, 'Put Tab to Sleep')?.click as () => void)()
    expect(a.sleep).toHaveBeenCalledTimes(1)
    expect(find(tabMenuTemplate(model({ canSleep: false }), actions()), 'Put Tab to Sleep')?.enabled).toBe(false)
  })

  it('leaves a window\'s only tab where it is', () => {
    expect(find(tabMenuTemplate(model({ tabCount: 1 }), actions()), 'Move Tab to New Window')?.enabled).toBe(false)
  })

  it('has nothing to close beside a tab when no unpinned one is left, or to its right', () => {
    const template = tabMenuTemplate(model({ othersClosable: false, rightClosable: false }), actions())
    expect(find(template, 'Close Other Tabs')?.enabled).toBe(false)
    expect(find(template, 'Close Tabs to the Right')?.enabled).toBe(false)
  })

  it('offers the opposite of what a tab is: Unpin and Unmute for a pinned, muted tab', () => {
    const template = tabMenuTemplate(model({ pinned: true, muted: true }), actions())
    expect(find(template, 'Unpin Tab')?.enabled).toBe(true)
    expect(find(template, 'Unmute Tab')?.enabled).not.toBe(false)
    expect(find(template, 'Pin Tab')).toBeUndefined()
    expect(find(template, 'Mute Tab')).toBeUndefined()
  })

  it('does not pin a tab that is in a split, and always offers Reopen Closed Tab', () => {
    const template = tabMenuTemplate(model({ canPin: false, inSplit: true, tabCount: 1, othersClosable: false }), actions())
    expect(find(template, 'Pin Tab')?.enabled).toBe(false)
    expect(find(template, 'Reopen Closed Tab')?.enabled).not.toBe(false)
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

describe('a tab\'s menu: groups', () => {
  it('starts a new group, and offers Remove from Group only to a member', () => {
    const a = actions()
    const alone = tabMenuTemplate(model(), a)
    ;(find(alone, 'Add Tab to New Group')?.click as () => void)()
    expect(a.newGroup).toHaveBeenCalledTimes(1)
    expect(find(alone, 'Remove from Group')).toBeUndefined()
    expect(find(alone, 'Add Tab to Group')).toBeUndefined()
    const member = tabMenuTemplate(model({ grouped: true }), a)
    ;(find(member, 'Remove from Group')?.click as () => void)()
    expect(a.ungroup).toHaveBeenCalledTimes(1)
  })

  it('lists the groups it could join, each running its own join', () => {
    const join = vi.fn()
    const template = tabMenuTemplate(model({ groups: [{ label: 'Work', join }, { label: 'Untitled Group (Green)', join: vi.fn() }] }), actions())
    const submenu = find(template, 'Add Tab to Group')?.submenu as MenuItemConstructorOptions[]
    expect(submenu.map((item) => item.label)).toEqual(['Work', 'Untitled Group (Green)'])
    ;(submenu[0]?.click as () => void)()
    expect(join).toHaveBeenCalledTimes(1)
  })
})
