import type { Section } from '../model.js'
import { aboutSystemRows } from './about-system.js'

export const about: Section = {
  id: 'about',
  title: 'About',
  rows: [
    { id: 'about-version', label: 'Orivon', keywords: ['version', 'build', 'release'], control: { type: 'info', text: (state) => state.about?.version ?? '' } },
    { id: 'about-chromium', label: 'Chromium', keywords: ['engine', 'version'], control: { type: 'info', text: (state) => state.about?.chromium ?? '' } },
    { id: 'about-electron', label: 'Electron', keywords: ['runtime', 'version'], control: { type: 'info', text: (state) => state.about?.electron ?? '' } },
    { id: 'about-platform', label: 'System', keywords: ['os', 'platform', 'linux', 'windows', 'mac'], control: { type: 'info', text: (state) => state.about?.platform ?? '' } },
    {
      id: 'about-user-agent',
      label: 'How sites see this browser',
      help: 'The User-Agent your browser sends. It reads as an ordinary Chrome.',
      keywords: ['user agent', 'user-agent', 'ua', 'identify'],
      control: { type: 'info', text: (state) => state.about?.userAgent ?? '' }
    },
    {
      id: 'updates-check',
      label: 'Look for updates',
      help: 'Once a day Orivon asks GitHub whether a newer release exists, and tells you if one does. It never downloads or installs anything, and sends nothing about you but the request itself. It is off until you turn it on.',
      keywords: ['update', 'upgrade', 'release', 'version', 'new', 'automatic'],
      control: { type: 'toggle', key: 'updates.check' }
    },
    {
      id: 'updates-now',
      label: 'Check now',
      keywords: ['update', 'upgrade', 'latest'],
      control: { type: 'action', label: 'Check for an update', run: async (state) => { await state.updates.check() } },
      visible: (state) => state.profiles?.isPrivate !== true
    },
    {
      id: 'updates-result',
      label: 'Latest release',
      keywords: ['update', 'latest', 'version'],
      control: { type: 'info', text: (state) => state.updates.words() },
      visible: (state) => state.updates.words() !== ''
    },
    ...aboutSystemRows,
    {
      id: 'reset-all',
      label: 'Reset every setting',
      help: 'Puts every setting back to its default. Your bookmarks, permissions and site data are not touched.',
      keywords: ['restore', 'defaults', 'factory', 'clear'],
      control: { type: 'action', label: 'Reset all settings', confirm: 'Click again to reset', danger: true, run: async (state) => { await state.resetAll() } }
    }
  ]
}
