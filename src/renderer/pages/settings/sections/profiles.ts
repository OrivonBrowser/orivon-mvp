import type { Section } from '../model.js'

export const profiles: Section = {
  id: 'profiles',
  title: 'Profiles',
  intro: 'A profile is a separate browser: its own bookmarks, history, permissions, apps and settings. Nothing is shared between them.',
  rows: [
    {
      id: 'profile-current',
      label: 'This window',
      keywords: ['profile', 'account', 'user', 'name'],
      control: { type: 'info', text: (state) => state.profiles?.isPrivate === true ? 'A private window' : (state.profiles?.profiles.find((profile) => profile.current)?.name ?? '') }
    },
    {
      id: 'profile-manage',
      label: 'Profiles',
      help: 'Make a profile, open one, change its name and colour, or delete it.',
      keywords: ['profile', 'add', 'create', 'switch', 'rename', 'delete', 'colour', 'color', 'accounts'],
      control: { type: 'action', label: 'Manage profiles', run: async (state) => { await state.openPage('profiles') } }
    },
    {
      id: 'profile-import',
      label: 'Import bookmarks and history',
      help: 'Copy your bookmarks and history from another browser on this computer, or from a bookmarks file. Nothing is changed in the other browser.',
      keywords: ['import', 'migrate', 'switch', 'bookmarks', 'history', 'chrome', 'firefox', 'edge', 'brave', 'move'],
      control: { type: 'action', label: 'Import', run: async (state) => { await state.openPage('import') } }
    },
    {
      id: 'profile-private',
      label: 'Private window',
      help: 'A browser that starts empty and is deleted when you close it. It keeps no history and no identity, and asks for every permission again. It does not hide your network address, or files you download.',
      keywords: ['private', 'incognito', 'anonymous', 'temporary', 'guest'],
      control: { type: 'action', label: 'Open a private window', run: async (state) => { await state.openPrivate() } }
    }
  ]
}
