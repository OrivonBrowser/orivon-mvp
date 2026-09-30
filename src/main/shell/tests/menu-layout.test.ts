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

interface Setup { shortcuts: ShortcutService, ctx: WindowContext, closedTabs: ClosedStack, bar: { mode: string, items: number } }

async function setup (url = 'https://a.example/', zoomPercent = 100, onTop = false): Promise<Setup> {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), 'linux')
  await store.load()
  const shortcuts = new ShortcutService(store, 'linux')
  const closedTabs = new ClosedStack()
  const bar = { mode: 'auto', items: 0 }
  const ctx = {
    window: {
      window: { isAlwaysOnTop: () => onTop },
      tabs: { getState: () => ({ tabs: [{ id: 'a', url, displayUrl: url, isNewTab: url === 'orivon://newtab/', isInternal: false }], activeTabId: 'a' }) }
    },
    services: { shortcuts, closedTabs, settings: { get: () => bar.mode }, bookmarks: { children: () => new Array(bar.items).fill({}) }, zoom: { percentFor: (origin: string | null) => origin === null ? 100 : zoomPercent } }
  } as unknown as WindowContext
  return { shortcuts, ctx, closedTabs, bar }
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
    expect(items.find((item) => item.kind === 'submenu' && item.label === 'More tools')).toBeDefined()
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
    const more = menuItems(ctx).find((item) => item.kind === 'submenu' && item.label === 'More tools')
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
    const on = vi.fn(() => true)
    const hint = vi.fn(() => 'note')
    const items = menuItems(ctx, ['tab.new', 'bookmarks.open', { check: 'bookmark.allTabs', on }, { item: 'import.open', hint }])
    expect(items).toEqual([expect.objectContaining({ id: 'tab.new' })])
    expect(on).not.toHaveBeenCalled()
    expect(hint).not.toHaveBeenCalled()
  })

  it('shows none of the library commands while they are pending, and the Bookmarks submenu only with what has landed', async () => {
    const { ctx } = await setup()
    const items = menuItems(ctx)
    const submenu = items.find((item) => item.kind === 'submenu' && item.label === 'Bookmarks')
    expect(submenu).toMatchObject({ items: [expect.objectContaining({ id: 'bookmarks.toggleBar' })] })
    const ids = runnableIds(items)
    for (const id of ['bookmarks.open', 'bookmark.allTabs', 'readingList.open', 'readingList.add', 'import.open']) {
      expect(ids.has(id as never), id).toBe(false)
    }
  })
})

describe('the bookmarks bar check', () => {
  const tick = (items: readonly MenuItemView[]): boolean | null | undefined => {
    const submenu = items.find((item) => item.kind === 'submenu' && item.label === 'Bookmarks') as Extract<MenuItemView, { kind: 'submenu' }>
    return (find(submenu.items, 'bookmarks.toggleBar') as Extract<MenuItemView, { kind: 'command' }> | undefined)?.checked
  }

  it('is on when the bar is shown by the setting or by an item in it, and off otherwise', async () => {
    const { ctx, bar } = await setup()

    expect(tick(menuItems(ctx))).toBe(false)
    bar.items = 2
    expect(tick(menuItems(ctx))).toBe(true)
    bar.mode = 'never'
    expect(tick(menuItems(ctx))).toBe(false)
    bar.mode = 'always'
    bar.items = 0
    expect(tick(menuItems(ctx))).toBe(true)
  })
})

const submenu = (items: readonly MenuItemView[], label: string): readonly MenuItemView[] => (items.find((item) => item.kind === 'submenu' && item.label === label) as Extract<MenuItemView, { kind: 'submenu' }>).items
const more = (items: readonly MenuItemView[]): readonly MenuItemView[] => submenu(items, 'More tools')
const share = (items: readonly MenuItemView[]): readonly MenuItemView[] => submenu(items, 'Share')

describe('the Share rows', () => {
  it('list Copy link, Email link and the QR code, in that order', async () => {
    const { ctx } = await setup()
    const rows = share(menuItems(ctx))
    expect(rows.flatMap((item) => item.kind === 'command' ? [item.id] : [])).toEqual(['share.copyLink', 'share.email', 'page.qr'])
    expect(find(rows, 'page.qr')).toMatchObject({ label: 'Create QR code for this page' })
    expect(find(more(menuItems(ctx)), 'page.qr')).toBeUndefined()
    for (const id of ['share.copyLink', 'share.email', 'page.qr']) {
      expect(find(rows, id), id).not.toHaveProperty('disabled')
      expect(runnableIds(menuItems(ctx)).has(id as never), id).toBe(true)
    }
  })

  it('are greyed, with the reason under them, on the new-tab page and a shell page', async () => {
    for (const url of ['orivon://newtab/', 'orivon://settings/']) {
      const { ctx } = await setup(url)
      const rows = share(menuItems(ctx))
      expect(find(rows, 'share.copyLink'), url).toMatchObject({ disabled: true, hint: 'No address' })
      expect(find(rows, 'share.email'), url).toMatchObject({ disabled: true, hint: 'No address' })
      const ids = runnableIds(menuItems(ctx))
      expect(ids.has('share.copyLink'), url).toBe(false)
      expect(ids.has('share.email'), url).toBe(false)
    }
  })
})

describe('the Create shortcut row', () => {
  const row = async (url: string, isPrivate = false): Promise<MenuItemView | undefined> => {
    const { ctx } = await setup(url)
    const services = { ...(ctx.services as object), isPrivate } as unknown as WindowContext['services']
    return find(more(menuItems({ ...ctx, services })), 'site.shortcut')
  }

  it('is offered for a web page, when this system can make one', async () => {
    const platform = process.platform
    const shown = await row('https://a.example/')
    if (platform === 'linux' || platform === 'win32') expect(shown).toMatchObject({ label: 'Create shortcut', hint: null })
    else expect(shown).toMatchObject({ disabled: true, hint: 'Not available on macOS' })
  })

  it('is greyed in a private window and on a page with no address', async () => {
    if (process.platform !== 'linux' && process.platform !== 'win32') return
    expect(await row('https://a.example/', true)).toMatchObject({ disabled: true, hint: 'Not available in a private window' })
    expect(await row('orivon://newtab/')).toMatchObject({ disabled: true, hint: 'No address' })
  })
})

describe('the QR code row', () => {
  it('is greyed, and not runnable, on the new-tab page', async () => {
    const { ctx } = await setup('orivon://newtab/')
    expect(find(share(menuItems(ctx)), 'page.qr')).toMatchObject({ disabled: true })
    expect(runnableIds(menuItems(ctx)).has('page.qr')).toBe(false)
  })
})

describe('the about and task manager entries', () => {
  it('list About Orivon, the JavaScript console and the Task manager', async () => {
    const { ctx } = await setup()
    const ids = runnableIds(menuItems(ctx))
    for (const id of ['about.open', 'devtools.console', 'tasks.open']) expect(ids.has(id as never), id).toBe(true)
  })
})

describe('runnableIds', () => {
  it('holds every listed command at every depth, and the zoom row\'s four', async () => {
    const { ctx } = await setup()
    const ids = runnableIds(menuItems(ctx))
    for (const id of ['tab.new', 'split.toggle', 'tab.search', 'page.print', 'page.save', 'page.screenshot', 'page.pip', 'page.pdf', 'page.qr', 'page.viewSource', 'window.alwaysOnTop', 'zoom.in', 'zoom.out', 'zoom.reset', 'window.fullscreen']) expect(ids.has(id as never), id).toBe(true)
    expect(ids.has('tab.close')).toBe(false)
  })

  it('keeps zoom commands out when the page cannot zoom, and full screen in', async () => {
    const { ctx } = await setup('orivon://newtab/')
    const ids = runnableIds(menuItems(ctx))
    expect(ids.has('zoom.in')).toBe(false)
    expect(ids.has('window.fullscreen')).toBe(true)
  })
})
