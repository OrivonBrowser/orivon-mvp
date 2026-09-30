import type { Section } from '../model.js'

export const startup: Section = {
  id: 'startup',
  title: 'On start-up',
  rows: [
    {
      id: 'startup-mode',
      label: 'When Orivon starts',
      keywords: ['launch', 'open', 'restore', 'session', 'continue', 'last time', 'new tab', 'pages'],
      control: {
        type: 'choice',
        key: 'startup.mode',
        options: [
          { value: 'newTab', label: 'Open the new tab page' },
          { value: 'continue', label: 'Continue where you left off' },
          { value: 'pages', label: 'Open specific pages' }
        ]
      }
    },
    {
      id: 'home-url',
      label: 'Home page',
      help: 'Where the Home button and Alt + Home go. Leave it empty for the new tab page.',
      keywords: ['homepage', 'start page', 'address', 'url'],
      group: 'Home page',
      control: { type: 'text', key: 'home.url', placeholder: 'New tab page', problem: 'That is not an address. It must start with https:// or http://.' }
    },
    {
      id: 'home-button',
      label: 'Show the Home button',
      keywords: ['toolbar', 'house'],
      group: 'Home page',
      control: { type: 'toggle', key: 'toolbar.home' }
    }
  ]
}
