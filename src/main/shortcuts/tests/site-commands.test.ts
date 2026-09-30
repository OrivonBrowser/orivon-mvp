import { describe, expect, it } from 'vitest'
import { COMMANDS, commandById } from '../commands.js'
import type { CommandDef } from '../commands.js'
import { MENU_LAYOUT } from '../../shell/menu-layout.js'
import type { MenuEntry } from '../../shell/menu-layout.js'

// The site and privacy commands: rows and menu entries exist ahead of the features that run them, so the
// id, the label, the category and the key are what those features and Settings > Shortcuts rely on.
const ROWS: ReadonlyArray<[id: string, label: string, category: string, binding: string | undefined]> = [
  ['privacy.clearData', 'Clear browsing data', 'navigation', 'Mod+Shift+Delete'],
  ['passwords.open', 'Passwords', 'window', undefined],
  ['siteSettings.open', 'Site settings', 'window', undefined],
  ['share.copyLink', 'Copy link', 'tools', undefined],
  ['share.email', 'Email link', 'tools', undefined],
  ['site.shortcut', 'Create shortcut', 'tools', undefined],
  ['site.certificate', 'View certificate', 'tools', undefined]
]

// Rows whose feature has landed: they run something now, so they carry no pending flag. One id a line.
const LANDED: readonly string[] = [
  'site.certificate'
]

const commandsIn = (entries: readonly MenuEntry[]): string[] => entries.flatMap((entry): string[] => {
  if (entry === '-') return []
  if (typeof entry === 'string') return [entry]
  if ('check' in entry) return [entry.check]
  if ('item' in entry) return [entry.item]
  if ('submenu' in entry) return commandsIn(entry.items)
  return []
})

describe('the site and privacy command rows', () => {
  it.each(ROWS)('%s is "%s" in %s with its default', (id, label, category, binding) => {
    const def = commandById(id) as CommandDef | undefined

    expect(def).toMatchObject({ id, label, category })
    expect(def?.default).toBe(binding)
  })

  it('marks every row whose feature has not landed pending, and no other', () => {
    const listed = new Set(ROWS.map(([id]) => id))
    const pending = COMMANDS.filter((def) => (def as CommandDef).pending === true && listed.has(def.id)).map((def) => def.id)

    expect([...pending].sort()).toEqual(ROWS.map(([id]) => id).filter((id) => !LANDED.includes(id)).sort())
  })

  it('gives Mod+Shift+Delete to one command only', () => {
    expect(COMMANDS.filter((def) => (def as CommandDef).default === 'Mod+Shift+Delete').map((def) => def.id)).toEqual(['privacy.clearData'])
  })

  it('lists each but the site settings row, which Settings opens, in the main menu layout', () => {
    const inMenu = commandsIn(MENU_LAYOUT)
    for (const [id] of ROWS.filter(([id]) => id !== 'siteSettings.open')) expect(inMenu, id).toContain(id)
  })
})
