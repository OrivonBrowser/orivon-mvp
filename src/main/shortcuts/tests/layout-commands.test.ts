import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMANDS, commandById } from '../commands.js'
import type { CommandDef } from '../commands.js'
import { parseBinding } from '../accelerator.js'
import { checkBinding } from '../rules.js'
import { ShortcutService } from '../shortcut-service.js'
import { ShortcutStore } from '../shortcut-store.js'
import { ClosedStack } from '../../session-restore/closed-stack.js'
import { MENU_LAYOUT, menuItems, runnableIds } from '../../shell/menu-layout.js'
import type { MenuEntry } from '../../shell/menu-layout.js'
import type { WindowContext } from '../../shell/window-context.js'

// The layout, reading and accessibility commands: their rows exist ahead of the features that run them, so the
// id, the label, the category and the keys are what those features and Settings > Shortcuts rely on.
const ROWS: ReadonlyArray<[id: string, label: string, category: string, binding: string | undefined, yields: boolean]> = [
  ['sidePanel.toggle', 'Side panel', 'window', 'Mod+Alt+B', false],
  ['tab.group', 'Add tab to new group', 'tabs', undefined, false],
  ['tab.ungroup', 'Remove tab from group', 'tabs', undefined, false],
  ['tab.sleep', 'Put tab to sleep', 'tabs', undefined, false],
  ['page.reader', 'Reader view', 'tools', 'F9', false],
  ['page.forceDark', 'Dark mode for this site', 'tools', undefined, false],
  ['caret.toggle', 'Caret browsing', 'tools', 'F7', true],
  ['focus.nextPane', 'Next pane', 'navigation', 'F6', false],
  ['focus.previousPane', 'Previous pane', 'navigation', 'Shift+F6', false],
  ['window.newGuest', 'New guest window', 'window', undefined, false]
]

// Rows whose feature has landed: they run something now, so they carry no pending flag. One id a line.
const LANDED: readonly string[] = [
  'page.reader'
]

const commandsIn = (entries: readonly MenuEntry[]): string[] => entries.flatMap((entry): string[] => {
  if (entry === '-') return []
  if (typeof entry === 'string') return [entry]
  if ('check' in entry) return [entry.check]
  if ('item' in entry) return [entry.item]
  if ('submenu' in entry) return commandsIn(entry.items)
  return []
})

describe('the layout, reading and accessibility command rows', () => {
  it.each(ROWS)('%s is "%s" in %s with its default and its yield flag', (id, label, category, binding, yields) => {
    const def = commandById(id) as CommandDef | undefined

    expect(def).toMatchObject({ id, label, category })
    expect(def?.default).toBe(binding)
    expect(def?.yieldToApp === true).toBe(yields)
    if (binding !== undefined) {
      const chord = parseBinding(binding, 'linux')
      expect(chord).not.toBeNull()
      if (chord !== null) expect(checkBinding(chord, 'linux')).toBeNull()
    }
  })

  it('marks every row whose feature has not landed pending, and no other', () => {
    const listed = new Set(ROWS.map(([id]) => id))
    const pending = COMMANDS.filter((def) => (def as CommandDef).pending === true && listed.has(def.id)).map((def) => def.id)

    expect([...pending].sort()).toEqual(ROWS.map(([id]) => id).filter((id) => !LANDED.includes(id)).sort())
  })

  it('gives F6 to the next-pane command and keeps the address bar on Mod+L and Alt+D', () => {
    expect(commandById('nav.focusAddress')).toMatchObject({ default: 'Mod+L', aliases: ['Alt+D'] })
    const holders = COMMANDS.filter((def) => [(def as CommandDef).default, ...((def as CommandDef).aliases ?? [])].includes('F6')).map((def) => def.id)
    expect(holders).toEqual(['focus.nextPane'])
  })

  it('gives no default key to two commands', () => {
    const keys = COMMANDS.flatMap((def) => [(def as CommandDef).default, ...((def as CommandDef).aliases ?? [])]).filter((key): key is string => key !== undefined)
    expect(keys.filter((key, at) => keys.indexOf(key) !== at)).toEqual([])
  })

  it('lists the guest window, and in More tools the reader, the side panel, the dark-mode tick and sleep, in the layout', () => {
    const inMenu = commandsIn(MENU_LAYOUT)
    for (const id of ['window.newGuest', 'page.reader', 'sidePanel.toggle', 'page.forceDark', 'tab.sleep']) expect(inMenu, id).toContain(id)
    for (const id of ['focus.nextPane', 'focus.previousPane', 'caret.toggle', 'tab.group', 'tab.ungroup']) expect(inMenu, id).not.toContain(id)
  })
})

describe('the main menu while those commands are pending', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-layout-commands-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('shows none of them and runs none of them', async () => {
    const store = new ShortcutStore(join(dir, 'shortcuts.json'), 'linux')
    await store.load()
    const ctx = {
      window: {
        window: { isAlwaysOnTop: () => false },
        tabs: { getState: () => ({ tabs: [{ id: 'a', url: 'https://a.example/', displayUrl: 'https://a.example/', isNewTab: false, isInternal: false }], activeTabId: 'a' }) }
      },
      services: { shortcuts: new ShortcutService(store, 'linux'), closedTabs: new ClosedStack(), settings: { get: () => 'auto' }, bookmarks: { children: () => [] }, zoom: { percentFor: () => 100 } }
    } as unknown as WindowContext

    const ids = runnableIds(menuItems(ctx))

    for (const [id] of ROWS) expect(ids.has(id as never), id).toBe(LANDED.includes(id))
  })
})
