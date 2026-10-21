import type { Section } from '../model.js'

export const search: Section = {
  id: 'search',
  title: 'Search',
  intro: 'What you type in the address bar that is not an address is searched on the Web3 (sites on IPFS with ENS names) or on the Web2 (ordinary search engines). Each has its own engine.',
  rows: [
    {
      id: 'search-mode',
      label: 'Address bar searches',
      help: 'You can also switch with the Web3 or Web2 button in the address bar while you type.',
      keywords: ['web3', 'web2', 'mode', 'explore', 'ipfs', 'ens', 'address bar', 'omnibox', 'switch'],
      control: { type: 'choice', key: 'search.mode' }
    },
    {
      id: 'search-web3-engine',
      label: 'Web3 search engine',
      keywords: ['web3', 'explore', 'ipfs', 'ens', 'decentralised', 'address bar', 'omnibox'],
      control: { type: 'choice', key: 'search.web3Engine' }
    },
    {
      id: 'search-engine',
      label: 'Web2 search engine',
      keywords: ['web2', 'duckduckgo', 'google', 'bing', 'brave', 'startpage', 'address bar', 'omnibox'],
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
      id: 'search-suggestions',
      label: 'Show suggestions from the search engine',
      helpFor: (state) => {
        const name = state.engines.defaultName === '' ? 'Your search engine' : state.engines.defaultName
        if (state.engines.isPrivate) return 'Not used in a private window.'
        if (!state.engines.suggestable) return `${name} does not offer suggestions.`
        const web2Only = state.value('search.mode') === 'web3' ? ' This applies while the address bar searches Web2; the Web3 search engine gives no suggestions.' : ''
        return `As you type a search, Orivon sends what you type to ${name}. Off, suggestions come only from your history, bookmarks and open tabs.${web2Only}`
      },
      keywords: ['suggestions', 'autocomplete', 'predictions', 'search suggestions', 'address bar', 'omnibox', 'privacy', 'typing'],
      control: { type: 'toggle', key: 'search.suggestions', disabled: (state) => state.engines.isPrivate || !state.engines.suggestable }
    },
    {
      id: 'address-bar-autocomplete',
      label: 'Complete addresses as I type',
      help: 'Suggestions come from your history, bookmarks and open tabs on this device.',
      keywords: ['autocomplete', 'autofill', 'inline', 'suggestions', 'address bar', 'omnibox', 'history'],
      control: { type: 'toggle', key: 'addressBar.autocomplete' },
      group: 'Address bar'
    },
    {
      id: 'address-bar-full-urls',
      label: 'Always show full addresses',
      help: 'Show the whole address, with https:// and www., while you are not editing it. Off, the bar shows the site name and hides them.',
      keywords: ['url', 'https', 'www', 'elide', 'full address', 'address bar', 'omnibox', 'show full url'],
      control: { type: 'toggle', key: 'addressBar.showFullUrl' },
      group: 'Address bar'
    },
    {
      id: 'search-engines',
      label: 'Search a site from the address bar',
      help: 'Type a keyword and a space before what you are looking for, like "w solar eclipse", to search that site instead of the default engine.',
      keywords: ['keyword', 'shortcut', 'custom search engine', 'site search', 'add search engine', 'wikipedia', 'youtube', 'github', 'openstreetmap', 'omnibox', 'address bar', 'default'],
      control: { type: 'engines' },
      group: 'Site search and keywords'
    }
  ]
}
