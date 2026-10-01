import type { Row } from '../../model.js'

/** Rows spread into the Keyboard group of Accessibility, so a feature adds its rows here and edits no other file. */
export const caretRows: readonly Row[] = [
  {
    id: 'caret-browsing',
    group: 'Keyboard',
    label: 'Navigate pages with a text cursor',
    help: 'Also called caret browsing. Press F7 to turn it on or off.',
    keywords: ['caret', 'cursor', 'keyboard', 'f7', 'text cursor', 'select text', 'read'],
    control: { type: 'toggle', key: 'accessibility.caretBrowsing' }
  },
  {
    id: 'caret-ask',
    group: 'Keyboard',
    label: 'Ask before turning on caret browsing with F7',
    keywords: ['caret', 'cursor', 'keyboard', 'f7', 'confirm', 'prompt'],
    control: { type: 'toggle', key: 'accessibility.caretAsk' }
  },
  {
    id: 'pane-keys',
    group: 'Keyboard',
    label: 'Move between the address bar, toolbar, tabs and page',
    help: 'Press F6 to go forward and Shift+F6 to go back.',
    keywords: ['f6', 'focus', 'panes', 'keyboard', 'tab', 'navigate', 'toolbar'],
    control: { type: 'info', text: () => 'F6', keys: true }
  }
]
