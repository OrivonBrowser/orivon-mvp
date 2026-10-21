import { engineNames } from '../../browsing/search-current.js'
import type { ShellStatePart } from '../shell-state-parts.js'

/** What the watched keys are: the settings that decide how the address bar looks and which engine its search goes to. */
const WATCHED = new Set(['addressBar.showFullUrl', 'search.mode', 'search.engine', 'search.web3Engine', 'search.customUrl'])

/** Whether the address bar shows full addresses, and the mode and engines a search from it uses; all follow the settings live. */
export const addressBarStatePart: ShellStatePart = {
  name: 'addressBar',
  read: ({ services }) => {
    const names = engineNames(services)
    return {
      showFullUrl: services.settings.get('addressBar.showFullUrl'),
      searchMode: services.settings.get('search.mode'),
      searchWeb3Name: names.web3,
      searchWeb2Name: names.web2
    }
  },
  watch: ({ services }, push) => services.settings.onChange(({ key }) => { if (WATCHED.has(key)) push() })
}
