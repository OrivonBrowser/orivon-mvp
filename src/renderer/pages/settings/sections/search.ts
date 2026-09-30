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
      id: 'address-bar-full-urls',
      label: 'Always show full addresses',
      help: 'Show the whole address, with https:// and www., while you are not editing it. Off, the bar shows the site name and hides them.',
      keywords: ['url', 'https', 'www', 'elide', 'full address', 'address bar', 'omnibox', 'show full url'],
      control: { type: 'toggle', key: 'addressBar.showFullUrl' },
      group: 'Address bar'
    }
  ]
}
