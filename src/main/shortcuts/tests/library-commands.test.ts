import { describe, expect, it } from 'vitest'
import { COMMANDS, commandById } from '../commands.js'
import type { CommandDef } from '../commands.js'
import { MENU_LAYOUT } from '../../shell/menu-layout.js'
import type { MenuEntry } from '../../shell/menu-layout.js'

// The library commands: their rows exist ahead of the features that run them, so the id, the label, the
// category and the keys are what those features and Settings > Shortcuts rely on.
const ROWS: ReadonlyArray<[id: string, label: string, category: string, binding: string | undefined, yields: boolean]> = [
  ['downloads.open', 'Downloads', 'navigation', 'Mod+J', true],
  ['bookmarks.open', 'Bookmark manager', 'navigation', 'Mod+Shift+O', false],
  ['bookmarks.toggleBar', 'Show bookmarks bar', 'navigation', 'Mod+Shift+B', false],
  ['bookmark.allTabs', 'Bookmark all tabs', 'navigation', 'Mod+Shift+D', false],
  ['readingList.open', 'Reading list', 'navigation', undefined, false],
  ['readingList.add', 'Add page to reading list', 'navigation', undefined, false],
  ['nav.focusSearch', 'Search the web', 'navigation', 'Mod+K', true],
  ['page.qr', 'Create QR code for this page', 'tools', undefined, false],
  ['devtools.console', 'JavaScript console', 'navigation', 'Mod+Shift+J', false],
  ['tasks.open', 'Task manager', 'window', undefined, false],
  ['import.open', 'Import bookmarks and history', 'window', undefined, false],
  ['about.open', 'About Orivon', 'window', undefined, false]
]

// Rows whose feature has landed: they run something now, so they carry no pending flag. One id a line.
const LANDED: readonly string[] = []

const commandsIn = (entries: readonly MenuEntry[]): string[] => entries.flatMap((entry): string[] => {
  if (entry === '-') return []
  if (typeof entry === 'string') return [entry]
  if ('check' in entry) return [entry.check]
  if ('item' in entry) return [entry.item]
  if ('submenu' in entry) return commandsIn(entry.items)
  return []
})

describe('the library command rows', () => {
  it.each(ROWS)('%s is "%s" in %s with its default and its yield flag', (id, label, category, binding, yields) => {
    const def = commandById(id) as CommandDef | undefined

    expect(def).toMatchObject({ id, label, category })
    expect(def?.default).toBe(binding)
    expect(def?.yieldToApp === true).toBe(yields)
  })

  it('marks every row whose feature has not landed pending, and no other', () => {
    const listed = new Set(ROWS.map(([id]) => id))
    const pending = COMMANDS.filter((def) => (def as CommandDef).pending === true && listed.has(def.id)).map((def) => def.id)

    expect([...pending].sort()).toEqual(ROWS.map(([id]) => id).filter((id) => !LANDED.includes(id)).sort())
  })

  it('gives the web search its second key, and the JavaScript console its macOS one', () => {
    expect(commandById('nav.focusSearch')).toMatchObject({ aliases: ['Mod+E'] })
    expect(commandById('devtools.console')).toMatchObject({ macDefault: 'Mod+Alt+J' })
  })

  it('keeps the Task manager on Shift+Escape as a fixed key, since a default needs a modifier', () => {
    expect(commandById('tasks.open')).toMatchObject({ aliases: ['Shift+Escape'] })
    expect((commandById('tasks.open') as CommandDef).default).toBeUndefined()
  })

  it('lists each but the web search, which is a key to the address bar, in the main menu layout, where it appears once its row is no longer pending', () => {
    const inMenu = commandsIn(MENU_LAYOUT)
    for (const [id] of ROWS.filter(([id]) => id !== 'nav.focusSearch')) expect(inMenu, id).toContain(id)
  })
})
