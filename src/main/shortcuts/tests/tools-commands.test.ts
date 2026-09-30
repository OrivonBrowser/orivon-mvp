import { describe, expect, it } from 'vitest'
import { COMMANDS, commandById } from '../commands.js'
import type { CommandDef } from '../commands.js'
import { parseBinding } from '../accelerator.js'
import { checkBinding } from '../rules.js'

// The commands whose rows exist ahead of the feature that runs them: the id, its label, its
// category and its keys are what those features and Settings > Shortcuts rely on.
const ROWS: ReadonlyArray<[id: string, label: string, category: string, binding: string | undefined, yields: boolean]> = [
  ['tab.reopen', 'Reopen closed tab', 'tabs', 'Mod+Shift+T', false],
  ['tab.duplicate', 'Duplicate tab', 'tabs', undefined, false],
  ['tab.pin', 'Pin tab', 'tabs', undefined, false],
  ['tab.mute', 'Mute tab', 'tabs', undefined, false],
  ['tab.closeOthers', 'Close other tabs', 'tabs', undefined, false],
  ['tab.closeRight', 'Close tabs to the right', 'tabs', undefined, false],
  ['tab.search', 'Search tabs', 'tabs', 'Mod+Shift+A', false],
  ['nav.stop', 'Stop loading', 'navigation', undefined, false],
  ['nav.home', 'Home page', 'navigation', 'Alt+Home', false],
  ['find.open', 'Find in page', 'tools', 'Mod+F', true],
  ['find.next', 'Find next', 'tools', 'Mod+G', true],
  ['find.previous', 'Find previous', 'tools', 'Mod+Shift+G', true],
  ['page.print', 'Print', 'tools', 'Mod+P', true],
  ['page.pdf', 'Save as PDF', 'tools', undefined, false],
  ['page.save', 'Save page as', 'tools', 'Mod+S', true],
  ['page.viewSource', 'View page source', 'tools', 'Mod+U', true],
  ['page.screenshot', 'Take a screenshot', 'tools', 'Mod+Shift+S', true],
  ['page.pip', 'Picture in picture', 'tools', undefined, false],
  ['window.alwaysOnTop', 'Keep window on top', 'window', undefined, false]
]

describe('the page-tools command rows', () => {
  it.each(ROWS)('%s is "%s" in %s with its default and its yield flag', (id, label, category, binding, yields) => {
    const def = commandById(id) as CommandDef | undefined

    expect(def).toMatchObject({ id, label, category })
    expect(def?.default).toBe(binding)
    expect(def?.yieldToApp === true).toBe(yields)
  })

  it('marks every row without a feature behind it pending, and no other row', () => {
    const pending = COMMANDS.filter((def) => (def as CommandDef).pending === true).map((def) => def.id)

    expect(pending).toEqual(ROWS.map(([id]) => id).filter((id) => id !== 'window.alwaysOnTop' && id !== 'tab.reopen'))
  })

  it('gives find next and previous their function-key aliases', () => {
    expect(commandById('find.next')).toMatchObject({ aliases: ['F3'] })
    expect(commandById('find.previous')).toMatchObject({ aliases: ['Shift+F3'] })
  })

  it('binds only what the shortcut rules allow, on every platform, and no chord twice', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const seen = new Map<string, string>()
      for (const def of COMMANDS as readonly CommandDef[]) {
        const texts = [platform === 'darwin' ? (def.macDefault ?? def.default) : def.default, ...(def.aliases ?? [])]
        for (const text of texts) {
          if (text === undefined) continue
          const chord = parseBinding(text, platform)
          expect(chord, `${def.id} ${text}`).not.toBeNull()
          if (chord === null) continue
          if (text === def.default || text === def.macDefault) expect(checkBinding(chord, platform), `${def.id} ${text}`).toBeNull()
          const key = JSON.stringify(chord)
          expect(seen.get(key), `${def.id} shares ${text} with ${seen.get(key) ?? ''} on ${platform}`).toBeUndefined()
          seen.set(key, def.id)
        }
      }
    }
  })
})
