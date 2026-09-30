import type { Section } from '../model.js'

export const search: Section = {
  id: 'search',
  title: 'Search',
  intro: 'What you type in the address bar that is not an address goes to this search engine.',
  rows: [
    {
      id: 'search-engine',
      label: 'Search engine',
      keywords: ['duckduckgo', 'google', 'bing', 'brave', 'startpage', 'address bar', 'omnibox'],
      control: { type: 'choice', key: 'search.engine' }
    },
    {
      id: 'search-custom-url',
      label: 'Your search address',
      help: 'Where the search goes, with %s in place of what you typed. It must start with https://, and %s cannot be part of the site name.',
      keywords: ['custom', 'own', 'url', 'template', 'searxng'],
      control: { type: 'text', key: 'search.customUrl', placeholder: 'https://search.example/?q=%s' },
      visible: (state) => state.value('search.engine') === 'custom'
    },
    {
      id: 'address-bar-autocomplete',
      label: 'Complete addresses as I type',
      help: 'Suggestions come from your history, bookmarks and open tabs on this device.',
      keywords: ['autocomplete', 'autofill', 'inline', 'suggestions', 'address bar', 'omnibox', 'history'],
      control: { type: 'toggle', key: 'addressBar.autocomplete' },
      group: 'Address bar'
    }
  ]
}
