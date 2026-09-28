import type { Section } from '../model.js'

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
      id: 'reset-all',
      label: 'Reset every setting',
      help: 'Puts every setting back to its default. Your bookmarks, permissions and site data are not touched.',
      keywords: ['restore', 'defaults', 'factory', 'clear'],
      control: { type: 'action', label: 'Reset all settings', confirm: 'Click again to reset', danger: true, run: async (state) => { await state.resetAll() } }
    }
  ]
}
