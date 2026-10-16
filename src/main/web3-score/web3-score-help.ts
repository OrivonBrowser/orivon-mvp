// Where the "?" marks of the Web3 Score shield lead: the page that says what the levels mean, at the name Orivon's
// documentation lives at. The address is the one a person types; the tab opens at what the address bar makes of it.
import { parseOmniboxInput } from '../browsing/omnibox.js'
import { isDevEthName } from '../dev/eth-resolver.js'

export const WEB3_SCORE_HELP_ADDRESS = 'docs.orivonstack.eth/docs/using/web3-score'

/** What the address bar opens for `WEB3_SCORE_HELP_ADDRESS`, so a "?" and a typed address cannot drift apart. */
export function web3ScoreHelpUrl (isDevName: (host: string) => boolean = isDevEthName): string {
  const parsed = parseOmniboxInput(WEB3_SCORE_HELP_ADDRESS, isDevName)
  if (parsed.kind !== 'url') throw new Error('the Web3 Score help address is not an address')
  return parsed.url
}

/** A new tab in front, in the window of `tabs`, the way any link opens one. */
export function openWeb3ScoreHelp (tabs: { createTab: (url: string) => string }): void {
  tabs.createTab(web3ScoreHelpUrl())
}
