import type { Section } from '../model.js'

const HELP: Readonly<Record<string, string>> = {
  continue: 'Your windows and tabs from last time reopen. Private windows are never reopened.',
  pages: 'These pages open in the first window.'
}

export const startup: Section = {
  id: 'startup',
  title: 'On start-up',
  rows: [
    {
      id: 'startup-mode',
      label: 'When Orivon starts',
      helpFor: (state) => HELP[String(state.value('startup.mode'))] ?? '',
      keywords: ['startup', 'launch', 'restore', 'session', 'tabs', 'reopen', 'begin', 'continue', 'last time', 'new tab', 'pages'],
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
      id: 'startup-pages',
      label: 'Pages to open',
      keywords: ['startup', 'launch', 'pages', 'addresses', 'websites', 'urls', 'sites'],
      control: { type: 'pageList', key: 'startup.pages' },
      visible: (state) => state.value('startup.mode') === 'pages'
    },
    {
      id: 'home-url',
      label: 'Address',
      helpFor: (state) => {
        const keys = state.shortcuts.rows.find((row) => row.id === 'nav.home')?.keys ?? null
        const who = keys === null ? 'the Home button opens' : `the Home button and ${keys.join('+')} open`
        return `The page ${who}. Leave empty for the new tab page.`
      },
      keywords: ['homepage', 'home', 'start', 'start page', 'address', 'url'],
      group: 'Home page',
      control: { type: 'text', key: 'home.url', placeholder: 'New tab page', problem: 'Enter a web address, like https://example.com' }
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
