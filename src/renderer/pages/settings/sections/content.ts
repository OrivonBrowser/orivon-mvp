import type { Section } from '../model.js'

export const content: Section = {
  id: 'content',
  title: 'Page content',
  rows: [
    {
      id: 'spellcheck',
      label: 'Check spelling as I type',
      help: 'Misspelt words in a text box are underlined, and the right-click menu offers corrections. Words are checked on this computer. Dictionaries are downloaded once per language.',
      keywords: ['spell', 'spelling', 'dictionary', 'typo', 'autocorrect', 'red underline'],
      control: { type: 'toggle', key: 'spellcheck.enabled' }
    },
    {
      id: 'pdf-viewer',
      label: 'Open PDFs in Orivon',
      help: 'A PDF opens in a tab. When this is off, it is downloaded instead.',
      keywords: ['pdf', 'document', 'viewer', 'download', 'reader'],
      control: { type: 'toggle', key: 'pdf.viewer' }
    }
  ]
}
