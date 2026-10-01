import type { Row, Section } from '../model.js'
import type { ShortcutRow } from '../shortcuts-state.js'

const GROUPS: Readonly<Record<string, string>> = { tabs: 'Tabs', navigation: 'Pages', tools: 'Page tools', window: 'Windows' }

function rowFor (shortcut: ShortcutRow): Row {
  return {
    id: `shortcut-${shortcut.id}`,
    label: shortcut.label,
    group: GROUPS[shortcut.category] ?? shortcut.category,
    keywords: ['shortcut', 'shortcuts', 'keyboard', 'key', 'keys', 'hotkey', 'binding', shortcut.category],
    control: { type: 'shortcut', id: shortcut.id }
  }
}

/** Built once the shortcuts are known: which commands there are is main's to say. */
export function shortcutsSection (shortcuts: readonly ShortcutRow[]): Section {
  return {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    intro: 'Choose Change, then press the keys you want. Escape cancels. A shortcut a website would also like stays yours: the browser takes it first.',
    rows: [
      ...shortcuts.map(rowFor),
      {
        id: 'shortcuts-reset',
        label: 'Restore the default shortcuts',
        keywords: ['shortcut', 'keyboard', 'reset', 'defaults'],
        control: { type: 'action', label: 'Restore defaults', confirm: 'Click again to restore', danger: true, run: async (state) => { await state.shortcuts.resetAll() } }
      }
    ]
  }
}
