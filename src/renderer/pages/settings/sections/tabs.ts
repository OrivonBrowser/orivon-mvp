import type { Section } from '../model.js'

export const tabs: Section = {
  id: 'tabs',
  title: 'Tabs and windows',
  rows: [
    {
      id: 'last-tab-closed',
      label: 'When I close the last tab',
      keywords: ['window', 'quit', 'exit', 'empty'],
      control: {
        type: 'choice',
        key: 'tabs.lastTabClosed',
        options: [
          { value: 'closeWindow', label: 'Close the window' },
          { value: 'newTab', label: 'Open a new tab' }
        ]
      }
    }
  ]
}
