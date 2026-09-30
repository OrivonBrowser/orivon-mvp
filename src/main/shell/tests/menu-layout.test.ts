import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commandById } from '../../shortcuts/commands.js'
import { ShortcutService } from '../../shortcuts/shortcut-service.js'
import { ShortcutStore } from '../../shortcuts/shortcut-store.js'
import { ClosedStack } from '../../session-restore/closed-stack.js'
import { MENU_LAYOUT, menuItems, runnableIds } from '../menu-layout.js'
import type { MenuEntry, MenuItemView } from '../menu-layout.js'
import type { WindowContext } from '../window-context.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-menu-layout-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

interface Setup { shortcuts: ShortcutService, ctx: WindowContext, closedTabs: ClosedStack }

async function setup (url = 'https://a.example/', zoomPercent = 100, onTop = false): Promise<Setup> {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), 'linux')
  await store.load()
  const shortcuts = new ShortcutService(store, 'linux')
  const closedTabs = new ClosedStack()
  const ctx = {
    window: {
      window: { isAlwaysOnTop: () => onTop },
      tabs: { getState: () => ({ tabs: [{ id: 'a', url }], activeTabId: 'a' }) }
    },
    services: { shortcuts, closedTabs, zoom: { percentFor: (origin: string | null) => origin === null ? 100 : zoomPercent } }
  } as unknown as WindowContext
  return { shortcuts, ctx, closedTabs }
}

const commandsIn = (entries: readonly MenuEntry[]): string[] => entries.flatMap((entry): string[] => {
  if (entry === '-') return []
  if (typeof entry === 'string') return [entry]
  if ('check' in entry) return [entry.check]
  if ('item' in entry) return [entry.item]
  if ('submenu' in entry) return commandsIn(entry.items)
  return []
})

const find = (items: readonly MenuItemView[], id: string): MenuItemView | undefined => items.find((item) => item.kind === 'command' && item.id === id)

describe('the main menu layout', () => {
  it('names only commands that exist', () => {
    for (const id of commandsIn(MENU_LAYOUT)) expect(commandById(id), id).toBeDefined()
  })

  it('never starts, ends or doubles a separator, at any depth', async () => {
    const { ctx } = await setup()
    const check = (items: readonly MenuItemView[]): void => {
      expect(items[0]?.kind).not.toBe('separator')
      expect(items.at(-1)?.kind).not.toBe('separator')
      items.forEach((item, at) => {
        if (item.kind === 'separator') expect(items[at - 1]?.kind).not.toBe('separator')
        if (item.kind === 'submenu') check(item.items)
      })
    }
    check(menuItems(ctx))
  })

  it('has the zoom row after the history group, and More tools as a submenu', async () => {
    const { ctx } = await setup()
    const items = menuItems(ctx)
    expect(items.map((item) => item.kind)).toContain('zoom')
    expect(items.find((item) => item.kind === 'submenu')).toMatchObject({ label: 'More tools' })
  })

  it('lists Find in page with its key, between Print and Save page as', async () => {
    const { ctx } = await setup()
    const items = menuItems(ctx)
    const at = items.findIndex((item) => item.kind === 'command' && item.id === 'find.open')
    expect(items[at]).toMatchObject({ label: 'Find in page', keys: ['Ctrl', 'F'] })
    expect(items[at - 1]).toMatchObject({ label: 'Print' })
    expect(items[at + 1]).toMatchObject({ label: 'Save page as' })
  })

  it('lists Search tabs with its key in More tools, right after Split view', async () => {
    const { ctx } = await setup()
    const more = menuItems(ctx).find((item) => item.kind === 'submenu')
    const rows = more?.kind === 'submenu' ? more.items : []
    const at = rows.findIndex((item) => item.kind === 'command' && item.id === 'tab.search')
    expect(rows[at]).toMatchObject({ label: 'Search tabs', keys: ['Ctrl', 'Shift', 'A'] })
    expect(rows[at - 1]).toMatchObject({ id: 'split.toggle' })
  })
})

describe('menuItems', () => {
  it('shows each command under the keys it has now', async () => {
    const { shortcuts, ctx } = await setup()
    expect(find(menuItems(ctx), 'tab.new')).toMatchObject({ label: 'New tab', keys: ['Ctrl', 'T'], hint: null, checked: null })

    shortcuts.set('tab.new', 'Ctrl+Shift+Y')

    expect(find(menuItems(ctx), 'tab.new')).toMatchObject({ keys: ['Ctrl', 'Shift', 'Y'] })
  })

  it('shows no keys for a command the person cleared', async () => {
    const { shortcuts, ctx } = await setup()
    shortcuts.clear('bookmark.toggle')
    expect(find(menuItems(ctx), 'bookmark.toggle')).toMatchObject({ keys: null })
  })

  it('reports the zoom level of the page, and a page with no zoom of its own as not zoomable', async () => {
    expect(menuItems((await setup('https://a.example/', 125)).ctx).find((item) => item.kind === 'zoom')).toEqual({ kind: 'zoom', percent: 125, zoomable: true })
    expect(menuItems((await setup('orivon://newtab/', 125)).ctx).find((item) => item.kind === 'zoom')).toEqual({ kind: 'zoom', percent: 100, zoomable: false })
  })

  it('ticks a check entry from its predicate', async () => {
    const layout: MenuEntry[] = [{ check: 'window.alwaysOnTop', on: ({ window }) => window.window.isAlwaysOnTop() }]
    expect(menuItems((await setup(undefined, 100, true)).ctx, layout)).toEqual([expect.objectContaining({ id: 'window.alwaysOnTop', checked: true })])
    expect(menuItems((await setup(undefined, 100, false)).ctx, layout)).toEqual([expect.objectContaining({ checked: false })])
  })

  it('carries a hint, which may be absent', async () => {
    const { ctx } = await setup()
    expect(menuItems(ctx, [{ item: 'history.open', hint: () => '3 new' }])).toEqual([expect.objectContaining({ hint: '3 new' })])
    expect(menuItems(ctx, [{ item: 'history.open', hint: () => null }])).toEqual([expect.objectContaining({ hint: null })])
  })

  it('shows what Reopen closed tab would bring back, directly under History, and nothing when there is none', async () => {
    const { ctx, closedTabs } = await setup()
    const rows = (): MenuItemView[] => menuItems(ctx)
    const under = (): MenuItemView | undefined => rows()[rows().findIndex((row) => row.kind === 'command' && row.id === 'history.open') + 1]
    expect(under()).toMatchObject({ id: 'tab.reopen', label: 'Reopen closed tab', keys: ['Ctrl', 'Shift', 'T'], hint: null })

    closedTabs.push({ kind: 'tab', tab: { url: 'https://a.example/', title: 'Invoice 2231 - Acme', pinned: false }, index: 0, windowKey: 1 })
    expect(under()).toMatchObject({ id: 'tab.reopen', hint: 'Invoice 2231 - Acme' })
  })

  it('drops a submenu with nothing in it, and the separators it leaves doubled', async () => {
    const { ctx } = await setup()
    const items = menuItems(ctx, ['tab.new', '-', { submenu: 'Empty', items: ['-'] }, '-', 'app.quit'])
    expect(items.map((item) => item.kind)).toEqual(['command', 'separator', 'command'])
  })

  it('leaves out an entry whose command does not exist', async () => {
    const { ctx } = await setup()
    expect(menuItems(ctx, ['tab.new', 'no.such' as never])).toHaveLength(1)
  })

  it('leaves out a command whose feature is still pending, and never reads its tick or its hint', async () => {
    const { ctx } = await setup()
    const read = vi.fn(() => true)
    const items = menuItems(ctx, ['tab.new', 'downloads.open', { check: 'bookmarks.toggleBar', on: read }, { item: 'about.open', hint: read }])
    expect(items).toEqual([expect.objectContaining({ id: 'tab.new' })])
    expect(read).not.toHaveBeenCalled()
  })

  it('shows none of the library commands while they are pending, and no Bookmarks submenu', async () => {
    const { ctx } = await setup()
    const items = menuItems(ctx)
    expect(items.some((item) => item.kind === 'submenu' && item.label === 'Bookmarks')).toBe(false)
    const ids = runnableIds(items)
    for (const id of ['downloads.open', 'bookmarks.open', 'bookmarks.toggleBar', 'bookmark.allTabs', 'readingList.open', 'readingList.add', 'page.qr', 'devtools.console', 'tasks.open', 'import.open', 'about.open']) {
      expect(ids.has(id as never), id).toBe(false)
    }
  })
})

describe('runnableIds', () => {
  it('holds every listed command at every depth, and the zoom row\'s four', async () => {
    const { ctx } = await setup()
    const ids = runnableIds(menuItems(ctx))
    for (const id of ['tab.new', 'split.toggle', 'tab.search', 'page.print', 'page.save', 'page.screenshot', 'page.pip', 'page.pdf', 'page.viewSource', 'window.alwaysOnTop', 'zoom.in', 'zoom.out', 'zoom.reset', 'window.fullscreen']) expect(ids.has(id as never), id).toBe(true)
    expect(ids.has('tab.close')).toBe(false)
  })

  it('keeps zoom commands out when the page cannot zoom, and full screen in', async () => {
    const { ctx } = await setup('orivon://newtab/')
    const ids = runnableIds(menuItems(ctx))
    expect(ids.has('zoom.in')).toBe(false)
    expect(ids.has('window.fullscreen')).toBe(true)
  })
})
