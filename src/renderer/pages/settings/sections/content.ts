import type { Section } from '../model.js'

export const content: Section = {
  id: 'content',
  title: 'Page content',
  rows: [
    {
      id: 'spellcheck',
      label: 'Check spelling as I type',
      help: 'Misspelt words in a text box are underlined, and the right-click menu offers corrections.',
      keywords: ['spell', 'spelling', 'dictionary', 'typo', 'autocorrect', 'red underline'],
      control: { type: 'toggle', key: 'spellcheck.enabled' }
    }
  ]
}
