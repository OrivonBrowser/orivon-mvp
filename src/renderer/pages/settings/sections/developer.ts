import type { Section } from '../model.js'

export const developer: Section = {
  id: 'developer',
  title: 'Developer',
  rows: [
    {
      id: 'developer-tools',
      label: 'Developer tools',
      help: 'Open them on any page with F12 or Ctrl+Shift+I, or with Inspect in a page\'s menu. On an app that has been given permissions, the first time asks you to confirm, because anything typed into its console acts with those permissions.',
      keywords: ['devtools', 'inspect', 'console', 'debug', 'f12', 'element', 'network'],
      control: { type: 'toggle', key: 'developer.tools' }
    },
    {
      id: 'developer-dock',
      label: 'Where they open',
      keywords: ['dock', 'window', 'side', 'bottom', 'detach', 'undock'],
      control: {
        type: 'choice',
        key: 'developer.dock',
        options: [
          { value: 'right', label: 'Beside the page' },
          { value: 'bottom', label: 'Under the page' },
          { value: 'undocked', label: 'In a window of their own' }
        ]
      },
      visible: (state) => state.value('developer.tools') === true
    },
    {
      id: 'developer-mode',
      label: 'Developer mode',
      help: 'Set from outside the browser, never from a page or from here. When on, a local address can be treated as an app for testing, and the shell\'s own pages can be inspected.',
      keywords: ['local', 'loopback', 'localhost', 'testing', 'override'],
      control: { type: 'info', text: (state) => state.about?.developerMode === true ? 'On' : 'Off' }
    }
  ]
}
