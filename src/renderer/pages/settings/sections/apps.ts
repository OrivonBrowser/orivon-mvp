import type { Section } from '../model.js'

export const apps: Section = {
  id: 'apps',
  title: 'Apps',
  intro: 'Apps ask for what they need, and a permission lasts until you take it back. Taking one back applies at once.',
  rows: [
    {
      id: 'apps-extensions',
      label: 'Extensions',
      help: 'Manage your Chrome extensions: turn one off, remove it, or load one of your own.',
      keywords: ['extensions', 'chrome', 'addons', 'plugins', 'crx', 'unpacked'],
      control: { type: 'action', label: 'Open extensions', run: async (state) => { await state.openPage('extensions') } }
    },
    {
      id: 'apps-list',
      label: 'Permissions and files',
      keywords: ['permissions', 'grants', 'revoke', 'apps', 'files', 'network', 'storage', 'access', 'folder', 'allow'],
      control: { type: 'apps' }
    },
    {
      id: 'apps-identity',
      label: 'Identity key',
      help: 'Apps that ask for it can sign in as you with a key made for each of them. It is kept in your system\'s keyring, so it survives a restart, when there is one.',
      keywords: ['identity', 'key', 'keyring', 'keychain', 'secrets', 'sign', 'login'],
      control: {
        type: 'info',
        text: (state) => {
          switch (state.apps.identity) {
            case 'keychain': return 'Kept in your system\'s keyring'
            case 'session-only': return 'Made again each time Orivon starts: no keyring is available here, or this is a private window'
            case 'not-started': return 'Not started yet'
          }
        }
      }
    }
  ]
}
