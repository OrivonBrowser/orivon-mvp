import type { Section } from '../model.js'

export const downloads: Section = {
  id: 'downloads',
  title: 'Downloads',
  rows: [
    {
      id: 'downloads-open',
      label: 'Downloads list',
      help: 'See, pause and open the files you have downloaded.',
      keywords: ['downloads', 'files', 'saved', 'list', 'ctrl+j'],
      control: { type: 'action', label: 'Open downloads', run: async (state) => { await state.openPage('downloads') } }
    },
    {
      id: 'downloads-folder',
      label: 'Save files to',
      help: 'Where downloaded files go. A name that is already taken gets a number.',
      keywords: ['download location', 'folder', 'directory', 'path', 'where', 'save', 'change', 'choose', 'browse'],
      control: { type: 'action', label: 'Change…', shows: (state) => state.downloads.folder, run: async (state) => { await state.downloads.choose() } }
    },
    {
      id: 'downloads-default-folder',
      label: 'Default folder',
      help: 'Go back to the folder your operating system offers for downloads.',
      keywords: ['download location', 'folder', 'directory', 'reset', 'default', 'system'],
      control: { type: 'action', label: 'Use the default folder', run: async (state) => { await state.downloads.useDefault() } },
      visible: (state) => state.downloads.custom
    },
    {
      id: 'downloads-ask-where',
      label: 'Ask where to save each file',
      help: 'Orivon shows a save dialog for every download.',
      keywords: ['download location', 'prompt', 'dialog', 'save as', 'ask', 'folder'],
      control: { type: 'toggle', key: 'downloads.askWhere' }
    },
    {
      id: 'downloads-show-bubble',
      label: 'Show downloads when a download starts',
      help: 'The list of downloads opens under the toolbar button when a file begins to download, and closes by itself when they are done.',
      keywords: ['download bubble', 'popup', 'panel', 'shelf', 'bar', 'notification', 'show', 'open', 'start'],
      control: { type: 'toggle', key: 'downloads.showBubble' }
    }
  ]
}
